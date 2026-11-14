import { storeJob } from '@stacksjs/queue/utils'
import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, SupportError, text } from './errors'
import * as support from './service'
import { drainOutbox } from './delivery'
import type { DeliveryHandler } from './delivery'

export const workflowLimits = { nodes: 50, steps: 100, waitSeconds: 30 * 86400, versions: 1000, workflowsPerProject: 100, runsPerDispatch: 20, automationDepth: 4 } as const
export type WorkflowNode = Row & { id: string, type: string, next?: string }
export type WorkflowDefinition = { start: string, nodes: WorkflowNode[] }
const nodeTypes = ['condition', 'wait', 'assign', 'tag', 'reply', 'note', 'ticket', 'status', 'tool', 'start_conversation', 'end']
const safeKey = (key: string) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) && !['constructor', 'prototype', '__proto__'].includes(key)

export function definition(value: unknown): WorkflowDefinition {
  const source = support.object(value), nodes = source.nodes
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > workflowLimits.nodes || JSON.stringify(source).length > 100000) fail(422, 'invalid_workflow', 'A workflow requires 1 to 50 bounded steps.')
  const parsed = nodes.map((candidate) => {
    const node = support.object(candidate), id = text(node.id, 'step id', 60), type = String(node.type)
    if (!safeKey(id) || !nodeTypes.includes(type)) fail(422, 'invalid_workflow', 'Unknown step type or invalid identifier.')
    if (type === 'wait' && (!Number.isSafeInteger(node.seconds) || Number(node.seconds) < 1 || Number(node.seconds) > workflowLimits.waitSeconds)) fail(422, 'invalid_workflow', 'A wait must be 1 second to 30 days.')
    if (type === 'assign') identifier(node.userId)
    if (type === 'tag') text(node.tag, 'tag', 60)
    if (type === 'reply' || type === 'note') text(node.body, 'body', 20000)
    if (type === 'ticket') text(node.title, 'title', 200)
    if (type === 'start_conversation') { text(node.subject, 'subject', 200); text(node.body, 'body', 20000) }
    if (type === 'status' && !['open', 'closed', 'snoozed'].includes(String(node.status))) fail(422, 'invalid_workflow', 'Unknown conversation status.')
    if (type === 'tool' && (!['contact.set_attribute', 'contact.remove_attribute'].includes(String(node.tool)) || !safeKey(String(node.key)) || JSON.stringify(node.value ?? null).length > 2000)) fail(422, 'invalid_workflow', 'Internal tools are limited to bounded custom contact attributes.')
    if (type === 'condition' && (!/^(event|contact|conversation)\.[a-zA-Z0-9_.]{1,100}$/.test(String(node.field)) || !['eq', 'neq', 'contains', 'exists', 'gt', 'lt'].includes(String(node.operator)) || !node.yes || !node.no)) fail(422, 'invalid_workflow', 'A condition requires a supported field, operator and both branches.')
    return { ...node, id, type } as WorkflowNode
  })
  const ids = new Set(parsed.map(node => node.id)), start = String(source.start || parsed[0]!.id)
  if (ids.size !== parsed.length || !ids.has(start)) fail(422, 'invalid_workflow', 'Step identifiers must be unique and the start step must exist.')
  const edges = (node: WorkflowNode) => (node.type === 'condition' ? [node.yes, node.no] : node.next ? [node.next] : []).map(String)
  for (const node of parsed) for (const target of edges(node)) if (!ids.has(target)) fail(422, 'invalid_workflow', 'Every transition must name an existing step.')
  const visiting = new Set<string>(), visited = new Set<string>()
  const walk = (id: string) => { if (visiting.has(id)) fail(422, 'invalid_workflow', 'Workflow transitions must not contain cycles.'); if (visited.has(id)) return; visiting.add(id); for (const target of edges(parsed.find(node => node.id === id)!)) walk(target); visiting.delete(id); visited.add(id) }
  walk(start)
  if (visited.size !== ids.size) fail(422, 'invalid_workflow', 'Every step must be reachable from the start step.')
  return { start, nodes: parsed }
}

async function workflow(project: Row, id: unknown) {
  const row = await one('SELECT * FROM support_workflows WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])
  if (!row) fail(404, 'not_found', 'Workflow not found.')
  return row
}
export async function createWorkflow(project: Row, input: Row, userId: number) {
  await support.member(userId, Number(project.workspace_id), ['owner', 'admin'])
  const parsed = definition(input.definition)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const count = Number((await one('SELECT COUNT(*) AS count FROM support_workflows WHERE project_id = ?', [project.id]))?.count)
    if (count >= workflowLimits.workflowsPerProject) fail(422, 'workflow_limit', 'This project already has 100 workflows.')
    return await insert('support_workflows', { workspace_id: project.workspace_id, project_id: project.id, name: text(input.name, 'name'), event: text(input.event, 'event', 200), definition: JSON.stringify(parsed), enabled: false, published_version: 0 })
  })
}
export async function saveDraft(project: Row, id: unknown, input: Row, userId: number) {
  await support.member(userId, Number(project.workspace_id), ['owner', 'admin'])
  const parsed = definition(input.definition)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const row = await workflow(project, id)
    await query('UPDATE support_workflows SET name = ?, event = ?, definition = ?, updated_at = ? WHERE id = ? AND project_id = ?', [input.name === undefined ? row.name : text(input.name, 'name'), input.event === undefined ? row.event : text(input.event, 'event', 200), JSON.stringify(parsed), new Date().toISOString(), row.id, project.id])
    return await workflow(project, id)
  })
}
export async function publishWorkflow(project: Row, id: unknown, userId: number) {
  await support.member(userId, Number(project.workspace_id), ['owner', 'admin'])
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const row = await workflow(project, id), parsed = definition(JSON.parse(String(row.definition)))
    const active = Number((await one('SELECT COUNT(*) AS count FROM support_workflows WHERE project_id = ? AND event = ? AND enabled = ? AND id <> ?', [project.id, row.event, true, row.id]))?.count)
    if (active >= workflowLimits.runsPerDispatch) fail(422, 'workflow_trigger_limit', 'An event can trigger at most 20 published workflows.')
    const version = Number(row.published_version) + 1
    if (version > workflowLimits.versions) fail(422, 'workflow_version_limit', 'This workflow reached its version limit.')
    for (const node of parsed.nodes) if (node.type === 'assign') await support.member(identifier(node.userId), Number(project.workspace_id))
    await insert('support_workflow_versions', { workspace_id: project.workspace_id, project_id: project.id, workflow_id: row.id, version, event: row.event, definition: JSON.stringify(parsed), published_by: userId })
    await query('UPDATE support_workflows SET published_version = ?, enabled = ?, updated_at = ? WHERE id = ?', [version, true, new Date().toISOString(), row.id])
    return { workflow: await workflow(project, id), version }
  })
}
export async function pauseWorkflow(project: Row, id: unknown, userId: number) {
  await support.member(userId, Number(project.workspace_id), ['owner', 'admin'])
  const row = await workflow(project, id)
  await query('UPDATE support_workflows SET enabled = ?, updated_at = ? WHERE id = ?', [false, new Date().toISOString(), row.id])
  return { paused: true }
}
export async function listWorkflows(project: Row) {
  return { workflows: await query('SELECT * FROM support_workflows WHERE project_id = ? AND workspace_id = ? ORDER BY id DESC', [project.id, project.workspace_id]), executionAvailable: true, workerRequired: true, limits: workflowLimits }
}

/** Called by the durable outbox worker. The source UUID prevents duplicate trigger admission. */
export async function dispatchWorkflowEvent(event: { id: string, kind: string, workspaceId: number, projectId: number, payload: Row }, now = Date.now()) {
  const project = await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [event.projectId, event.workspaceId])
  if (!project) fail(404, 'not_found', 'Project not found.')
  return await workspaceTransaction(event.workspaceId, async () => {
    const previous = await one('SELECT * FROM support_workflow_dispatches WHERE project_id = ? AND source_id = ?', [project.id, event.id])
    if (previous) return { dispatchId: String(previous.id), duplicate: true }
    let input: Row | undefined
    if (event.kind === 'event.created') input = await one('SELECT * FROM support_events WHERE id = ? AND project_id = ?', [identifier(event.payload.eventId), project.id])
    else if (event.kind === 'conversation.created') {
      const conversation = await support.conversation(project, event.payload.conversationId)
      input = await insert('support_events', { workspace_id: event.workspaceId, project_id: project.id, contact_id: conversation.contact_id, event: event.kind, attributes: JSON.stringify({ conversationId: conversation.id }) })
    }
    else if (event.kind === 'ticket.created') {
      const ticket = await one('SELECT * FROM support_tickets WHERE id = ? AND project_id = ?', [identifier(event.payload.ticketId), project.id])
      if (ticket) input = await insert('support_events', { workspace_id: event.workspaceId, project_id: project.id, contact_id: ticket.contact_id, event: event.kind, attributes: JSON.stringify({ ticketId: ticket.id, conversationId: ticket.conversation_id || undefined }) })
    }
    if (!input) fail(422, 'invalid_trigger', 'Workflow trigger record could not be resolved.')
    const depth = Math.max(0, Number(event.payload.automationDepth) || 0)
    const dispatched = await insert('support_workflow_dispatches', { workspace_id: event.workspaceId, project_id: project.id, source_id: event.id, event_id: input.id, depth })
    if (depth >= workflowLimits.automationDepth) return { dispatchId: String(dispatched.id), runs: 0, depthLimited: true }
    const matches = await query('SELECT * FROM support_workflows WHERE workspace_id = ? AND project_id = ? AND event = ? AND enabled = ? AND published_version > 0 ORDER BY id ASC LIMIT ?', [event.workspaceId, project.id, input.event, true, workflowLimits.runsPerDispatch])
    for (const row of matches) {
      const version = await one('SELECT * FROM support_workflow_versions WHERE workflow_id = ? AND version = ?', [row.id, row.published_version])
      if (!version) fail(409, 'workflow_version_missing', 'Published workflow version is unavailable.')
      const parsed = definition(JSON.parse(String(version.definition)))
      const context = { ...support.object(JSON.parse(String(input.attributes))), depth }
      const run = await insert('support_workflow_runs', { workspace_id: event.workspaceId, project_id: project.id, workflow_id: row.id, workflow_version_id: version.id, event_id: input.id, status: 'pending', cursor: parsed.nodes.findIndex(node => node.id === parsed.start), available_at: now, context: JSON.stringify(context) })
      await storeJob('RunSupportWorkflows', { queue: 'support-workflows', payload: { runId: run.id }, maxTries: 5, timeout: 60 })
    }
    return { dispatchId: String(dispatched.id), runs: matches.length }
  })
}

function fieldValue(root: Row, path: string): unknown {
  let value: unknown = root
  for (const key of path.split('.')) {
    if (!safeKey(key) || !value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = (value as Row)[key]
  }
  return value
}
function matches(value: unknown, operator: string, expected: unknown) {
  if (operator === 'exists') return value !== undefined && value !== null && value !== ''
  if (operator === 'eq') return value === expected
  if (operator === 'neq') return value !== expected
  if (operator === 'contains') return Array.isArray(value) ? value.includes(expected) : typeof value === 'string' && value.includes(String(expected))
  if (operator === 'gt' || operator === 'lt') return typeof value === 'number' && typeof expected === 'number' && (operator === 'gt' ? value > expected : value < expected)
  return false
}
function interpolate(value: unknown, scope: Row, max = 20000) {
  // eslint-disable-next-line pickier/no-unused-vars
  return text(String(value ?? '').replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (whole, key: string) => { const selected = fieldValue(scope, key); return ['string', 'number', 'boolean'].includes(typeof selected) ? String(selected) : '' }), 'step text', max)
}
async function runStep(run: Row, lease: string, now: number) {
  return await workspaceTransaction(Number(run.workspace_id), async () => {
    const current = await one('SELECT * FROM support_workflow_runs WHERE id = ?', [run.id])
    if (!current || current.status !== 'running' || current.lease_token !== lease) return { advanced: false }
    const version = await one('SELECT * FROM support_workflow_versions WHERE id = ? AND project_id = ?', [current.workflow_version_id, current.project_id])
    if (!version) fail(409, 'workflow_version_missing', 'Workflow version was removed.')
    const parsed = definition(JSON.parse(String(version.definition))), cursor = Number(current.cursor)
    if (cursor < 0 || cursor >= parsed.nodes.length) {
      await query("UPDATE support_workflow_runs SET status = 'completed', lease_until = 0, updated_at = ? WHERE id = ?", [new Date(now).toISOString(), current.id])
      return { advanced: true, completed: true }
    }
    if (Number(current.step_count) >= workflowLimits.steps) fail(422, 'workflow_step_limit', 'Workflow step limit reached.')
    const node = parsed.nodes[cursor]!, project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [current.project_id, current.workspace_id]))!
    const event = (await one('SELECT * FROM support_events WHERE id = ? AND project_id = ?', [current.event_id, project.id]))!
    const contact = (await one('SELECT * FROM support_contacts WHERE id = ? AND project_id = ?', [event.contact_id, project.id]))!
    const context = support.object(JSON.parse(String(current.context))), attributes = support.object(JSON.parse(String(contact.attributes)))
    const selected = context.conversationId ? await support.conversation(project, context.conversationId, contact) : undefined
    const scope = { contact: { ...contact, attributes }, event: { name: event.event, attributes: support.object(JSON.parse(String(event.attributes))) }, conversation: selected || {} }
    let next = node.next, outcome: Row = {}, waitingUntil = 0
    const requireConversation = () => { if (!selected) fail(422, 'workflow_context', 'This step requires a contact-owned conversation.'); return selected }
    const previous = await one('SELECT * FROM support_workflow_steps WHERE workflow_run_id = ? AND step_id = ?', [current.id, node.id])
    if (previous) fail(409, 'workflow_cursor_conflict', 'A completed step cannot execute twice.')
    if (node.type === 'condition') { const allowed = matches(fieldValue(scope, String(node.field)), String(node.operator), node.value); next = String(allowed ? node.yes : node.no); outcome = { matched: allowed } }
    else if (node.type === 'wait') { waitingUntil = now + Number(node.seconds) * 1000; outcome = { wakeAt: waitingUntil } }
    else if (node.type === 'assign') { const convo = requireConversation(); const { routeConversation } = await import('./routing'); outcome = await routeConversation(project, convo.id, { assigneeId: identifier(node.userId) }, { source: 'workflow', workflowRunId: Number(run.id) }) }
    else if (node.type === 'tag' || node.type === 'tool') {
      if (node.type === 'tag') { const tags = Array.isArray(attributes.tags) ? attributes.tags.filter(value => typeof value === 'string').slice(0, 49) : []; attributes.tags = [...new Set([...tags, text(node.tag, 'tag', 60)])] }
      else if (node.tool === 'contact.set_attribute') attributes[String(node.key)] = node.value ?? null
      else delete attributes[String(node.key)]
      await query('UPDATE support_contacts SET attributes = ?, updated_at = ? WHERE id = ? AND project_id = ?', [JSON.stringify(attributes), new Date(now).toISOString(), contact.id, project.id]); outcome = { contactId: contact.id }
    }
    else if (node.type === 'reply' || node.type === 'note') {
      const convo = requireConversation()
      const result = await support.reply(project, convo.id, { body: interpolate(node.body, scope), visibility: node.type === 'note' ? 'internal' : 'public', idempotencyKey: `workflow:${current.id}:${node.id}` }, { userId: 0 })
      await query("UPDATE support_messages SET author_type = 'automation' WHERE id = ? AND project_id = ?", [Number(result.message.id), project.id]); outcome = { messageId: result.message.id }
    }
    else if (node.type === 'status') { const convo = requireConversation(); const { routeConversation } = await import('./routing'); outcome = await routeConversation(project, convo.id, { status: node.status }, { source: 'workflow', workflowRunId: Number(run.id) }) }
    else if (node.type === 'ticket') {
      const ticket = await insert('support_tickets', { workspace_id: project.workspace_id, project_id: project.id, contact_id: contact.id, conversation_id: selected?.id ?? null, title: interpolate(node.title, scope, 200), description: node.description ? interpolate(node.description, scope) : '', status: 'open', priority: ['low', 'normal', 'high', 'urgent'].includes(String(node.priority)) ? node.priority : 'normal' })
      await support.enqueue(project, 'ticket.created', { ticketId: ticket.id, automationDepth: Number(context.depth || 0) + 1, workflowRunId: current.id }); outcome = { ticketId: ticket.id }
    }
    else if (node.type === 'start_conversation') {
      const created = await support.createConversation(project, { externalId: contact.external_id }, { subject: interpolate(node.subject, scope, 200), body: interpolate(node.body, scope), idempotencyKey: `workflow:${current.id}:${node.id}` }, contact, { workflowRunId: Number(current.id), automationDepth: Number(context.depth || 0) + 1 })
      await query("UPDATE support_messages SET author_type = 'automation' WHERE conversation_id = ? AND project_id = ?", [Number(created.conversation.id), project.id])
      await query('UPDATE support_conversations SET unread_count = 0 WHERE id = ? AND project_id = ?', [Number(created.conversation.id), project.id])
      context.conversationId = Number(created.conversation.id); outcome = { conversationId: created.conversation.id }
    }
    else if (node.type === 'end') next = undefined
    await insert('support_workflow_steps', { workspace_id: project.workspace_id, project_id: project.id, workflow_run_id: current.id, step_id: node.id, type: node.type, result: JSON.stringify(outcome) })
    const nextCursor = next ? parsed.nodes.findIndex(item => item.id === next) : -1, finished = nextCursor < 0 && !waitingUntil
    await query('UPDATE support_workflow_runs SET cursor = ?, context = ?, step_count = step_count + 1, status = ?, available_at = ?, lease_until = ?, last_error = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [nextCursor, JSON.stringify(context), finished ? 'completed' : waitingUntil ? 'waiting' : 'pending', waitingUntil || now, 0, '', new Date(now).toISOString(), current.id, lease])
    if (!finished) await storeJob('RunSupportWorkflows', { queue: 'support-workflows', payload: { runId: current.id }, delay: waitingUntil ? Math.ceil((waitingUntil - now) / 1000) : 0, maxTries: 5, timeout: 60 })
    return { advanced: true, completed: finished, waiting: Boolean(waitingUntil) }
  })
}
export async function executeWorkflowRun(id: unknown, options: { now?: number, leaseMs?: number } = {}) {
  const runId = identifier(id), now = options.now ?? Date.now(), leaseMs = options.leaseMs ?? 60000
  const initial = await one('SELECT * FROM support_workflow_runs WHERE id = ?', [runId])
  if (!initial) fail(404, 'not_found', 'Workflow run not found.')
  const claimed: Row | null = await workspaceTransaction(Number(initial.workspace_id), async () => {
    const row = await one('SELECT * FROM support_workflow_runs WHERE id = ?', [runId])
    if (!row || !['pending', 'running', 'waiting', 'blocked'].includes(String(row.status)) || Number(row.available_at) > now || Number(row.lease_until) > now) return null
    const lease = support.secret()
    await query("UPDATE support_workflow_runs SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ? WHERE id = ?", [lease, now + leaseMs, runId])
    return { ...row, lease_token: lease }
  })
  if (!claimed) return { advanced: false }
  try { return await runStep(claimed, String(claimed.lease_token), now) }
  catch (error) {
    const blocked = error instanceof SupportError && error.status === 402
    const permanent = error instanceof SupportError && error.status >= 400 && error.status < 500 && !blocked
    await workspaceTransaction(Number(claimed.workspace_id), async () => {
      await query('UPDATE support_workflow_runs SET status = ?, available_at = ?, lease_until = 0, last_error = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [blocked ? 'blocked' : permanent ? 'failed' : 'pending', now + 60000, error instanceof SupportError ? error.message : 'Step failed. Native worker will retry.', new Date(now).toISOString(), runId, claimed.lease_token])
    })
    if (!permanent && !blocked) throw error
    return { advanced: false, blocked, failed: permanent }
  }
}

export async function workflowWorkerTick(options: { now?: number, deliver?: DeliveryHandler, limit?: number } = {}) {
  const now = options.now ?? Date.now(), limit = Math.min(200, Math.max(1, options.limit ?? 50))
  const delivery = await drainOutbox(async (event) => {
    if (['event.created', 'conversation.created', 'ticket.created'].includes(event.kind)) {
      const dispatched = await dispatchWorkflowEvent(event, now)
      return { status: 'delivered', receipt: `internal-workflow-dispatch:${dispatched.dispatchId}` }
    }
    return options.deliver ? await options.deliver(event) : { status: 'unconfigured', reason: 'No channel adapter configured. Durable delivery remains pending.', retryAfterMs: 60000 }
  }, { now: () => now, limit })
  const due = await query("SELECT id FROM support_workflow_runs WHERE status IN ('pending', 'running', 'waiting', 'blocked') AND available_at <= ? AND lease_until <= ? ORDER BY id LIMIT ?", [now, now, limit])
  let advanced = 0
  for (const run of due) if ((await executeWorkflowRun(run.id, { now })).advanced) advanced++
  return { delivery, advanced }
}
