import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { runIsolated, assertIsolatedOk } from '@stacksjs/testing/isolated'
import { one, query } from '../../app/Support/database'
import { dispatchWorkflowEvent, executeWorkflowRun, workflowWorkerTick } from '../../app/Support/workflows'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let checks = 0, csrf = '', cookie = ''
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, bearer?: string) {
  const result = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: result.status, data: await result.json() as any, headers: result.headers }
}
async function restartResume(runId: unknown, target?: string) {
  const result = await runIsolated('tests/fixtures/workflow-resume.ts', { args: [String(runId), ...(target ? [target] : [])], env: { QUEUE_DRIVER: 'database' }, envFile: false, preload: [], timeoutMs: 20000 })
  assertIsolatedOk(result, 'PASS native workflow resume')
}
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const registration = await http('/register', 'POST', { name: 'Workflow Owner', email: 'workflow@example.test', password: 'WorkflowSecret2026!', password_confirmation: 'WorkflowSecret2026!' })
  check(registration.status < 300, 'native auth registration')
  const login = await http('/login', 'POST', { email: 'workflow@example.test', password: 'WorkflowSecret2026!' }), token = login.data.access_token
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Automations' }, token)).data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'App' }, token)).data.project
  const keys = (await http(`/support/projects/${project.public_id}/keys`, 'POST', {}, token)).data
  const prefix = `/support/projects/${project.public_id}`, sdk = `/v1/projects/${project.public_id}`
  const session = (await http(`${sdk}/sessions`, 'POST', { externalId: 'vip-1', name: 'Ada', attributes: { tier: 'gold' } }, keys.ingestKey)).data
  const conversation = (await http(`${sdk}/conversations`, 'POST', { externalId: 'vip-1', subject: 'Billing help', body: 'Need a hand', idempotencyKey: 'conversation' }, keys.ingestKey)).data.conversation
  // Session identity is not changed by creating a conversation or tracking metadata.
  await query('UPDATE support_contacts SET attributes = ? WHERE id = ?', [JSON.stringify({ tier: 'gold' }), Number(session.contact.id)])
  const graph = { start: 'vip', nodes: [
    { id: 'vip', type: 'condition', field: 'contact.attributes.tier', operator: 'eq', value: 'gold', yes: 'assign', no: 'end' },
    { id: 'assign', type: 'assign', userId: Number(login.data.user.id), next: 'tag' },
    { id: 'tag', type: 'tag', tag: 'vip', next: 'note' },
    { id: 'note', type: 'note', body: 'Review VIP billing privately', next: 'ticket' },
    { id: 'ticket', type: 'ticket', title: 'Billing for {{contact.name}}', priority: 'high', next: 'wait' },
    { id: 'wait', type: 'wait', seconds: 2, next: 'reply' },
    { id: 'reply', type: 'reply', body: 'Hello {{contact.name}}, we are looking into this.', next: 'end' },
    { id: 'end', type: 'end' },
  ] }
  const created = await http(`${prefix}/automations`, 'POST', { name: 'VIP billing', event: 'billing.requested', definition: graph }, token)
  check(created.status === 201 && !created.data.workflow.enabled, `draft native workflow persisted ${JSON.stringify(created.data)}`)
  const workflow = created.data.workflow
  const published = await http(`${prefix}/automations/${workflow.id}/publish`, 'POST', {}, token)
  check(published.status === 200 && published.data.version === 1, `published immutable version ${JSON.stringify(published.data)}`)
  const invalid = await http(`${prefix}/automations`, 'POST', { name: 'Unsafe loop', event: 'billing.requested', definition: { nodes: [{ id: 'loop', type: 'wait', seconds: 1, next: 'loop' }] } }, token)
  check(invalid.status === 422, 'cycles rejected before publication')
  const unsafe = await http(`${prefix}/automations`, 'POST', { name: 'No arbitrary execution', event: 'billing.requested', definition: { nodes: [{ id: 'tool', type: 'tool', tool: 'shell.exec', key: 'cmd', value: 'echo unsafe' }] } }, token)
  check(unsafe.status === 422, 'arbitrary code and external tool side effects are unavailable')
  for (const idempotencyKey of ['backlog-first', 'backlog-second']) {
    const note = await http(`${prefix}/conversations/${conversation.id}/messages`, 'POST', { body: 'Undelivered private note', visibility: 'internal', idempotencyKey }, token)
    check(note.status === 201, 'native reply stores older private notes in the durable outbox')
  }
  const tracked = await http(`${sdk}/events`, 'POST', { externalId: 'vip-1', event: 'billing.requested', attributes: { conversationId: Number(conversation.id) }, idempotencyKey: 'trigger' }, keys.ingestKey)
  check(tracked.status === 200, 'workflow trigger accepted through public server SDK API')
  const tick = await workflowWorkerTick({ limit: 2 })
  check(tick.advanced === 1 && tick.delivery.delivered === 2, 'workflow triggers make progress despite an older unrelated outbox backlog')
  check(Number((await one("SELECT COUNT(*) AS count FROM support_outbox WHERE project_id = ? AND kind = 'note.created' AND status = 'pending' AND attempts = 0", [project.id]))?.count) === 2, 'the workflow worker leaves delivery events available for an adapter')
  const run = await one('SELECT * FROM support_workflow_runs WHERE workflow_id = ?', [workflow.id])
  check(run && run.status === 'pending' && Number(run.cursor) === 1, 'branch checkpoint persisted')
  check(Number((await one("SELECT COUNT(*) AS count FROM jobs WHERE queue = 'support-workflows'"))?.count) >= 1, 'step continuation is durable in native job queue')
  const source = await one("SELECT * FROM support_outbox WHERE project_id = ? AND kind = 'event.created'", [project.id])
  const duplicate = await dispatchWorkflowEvent({ id: String(source!.event_id), kind: 'event.created', workspaceId: Number(project.workspace_id), projectId: Number(project.id), payload: { eventId: Number(tracked.data.id) } })
  check(duplicate.duplicate === true && Number((await one('SELECT COUNT(*) AS count FROM support_workflow_runs WHERE workflow_id = ?', [workflow.id]))?.count) === 1, 'outbox trigger retries never duplicate a workflow run')
  const modified = { ...graph, nodes: graph.nodes.map(node => node.id === 'reply' ? { ...node, body: 'A different published response' } : node) }
  check((await http(`${prefix}/automations/${workflow.id}/draft`, 'POST', { definition: modified }, token)).status === 200, 'new draft saved while a run is active')
  check((await http(`${prefix}/automations/${workflow.id}/publish`, 'POST', {}, token)).data.version === 2, 'second version published independently')
  // Every continuation runs in a new Bun process to prove restart recovery from durable rows.
  await restartResume(run!.id, 'waiting')
  const waiting = await one('SELECT * FROM support_workflow_runs WHERE id = ?', [run!.id])
  check(waiting?.status === 'waiting' && Number(waiting.cursor) === 6, 'wait deadline and next cursor survive worker restarts')
  const stepsBefore = Number((await one('SELECT COUNT(*) AS count FROM support_workflow_steps WHERE workflow_run_id = ?', [run!.id]))?.count)
  await restartResume(run!.id)
  check(Number((await one('SELECT COUNT(*) AS count FROM support_workflow_steps WHERE workflow_run_id = ?', [run!.id]))?.count) === stepsBefore, 'early restart cannot bypass the persisted wait')
  await Bun.sleep(2100)
  await Promise.all([restartResume(run!.id), restartResume(run!.id)])
  await restartResume(run!.id)
  check((await one('SELECT status FROM support_workflow_runs WHERE id = ?', [run!.id]))?.status === 'completed', 'workflow resumes after wait and completes')
  const generated = await query("SELECT body, visibility FROM support_messages WHERE conversation_id = ? AND author_type = 'automation' ORDER BY id", [conversation.id])
  check(generated.length === 2 && generated.some(row => row.visibility === 'internal') && generated.some(row => row.body === 'Hello Ada, we are looking into this.'), 'internal note and public reply each execute once from immutable version one')
  check(!generated.some(row => row.body === 'A different published response'), 'publishing version two cannot mutate an in-flight run')
  const assigned = await one('SELECT assignee_id FROM support_conversations WHERE id = ?', [conversation.id])
  check(Number(assigned?.assignee_id) === Number(login.data.user.id), 'assignment belongs to a real workspace member')
  const contact = await one('SELECT attributes FROM support_contacts WHERE id = ?', [Number(session.contact.id)])
  check(JSON.parse(String(contact?.attributes)).tags.includes('vip'), 'contact tag persisted')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_tickets WHERE project_id = ?', [project.id]))?.count) === 1, 'ticket created once across restarted and concurrent worker attempts')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_workflow_steps WHERE workflow_run_id = ?', [run!.id]))?.count) === 8, 'every workflow step has one durable execution marker')
  // A crash before execution leaves an expired run lease; a replacement worker can recover it.
  const proactive = await http(`${prefix}/automations`, 'POST', { name: 'Proactive', event: 'onboarding', definition: { nodes: [{ id: 'start', type: 'start_conversation', subject: 'Welcome', body: 'Welcome {{contact.name}}', next: 'flag' }, { id: 'flag', type: 'tool', tool: 'contact.set_attribute', key: 'onboarded', value: true }] } }, token)
  await http(`${prefix}/automations/${proactive.data.workflow.id}/publish`, 'POST', {}, token)
  await http(`${sdk}/events`, 'POST', { externalId: 'vip-1', event: 'onboarding', idempotencyKey: 'onboard' }, keys.ingestKey)
  await workflowWorkerTick()
  const proactiveRun = await one('SELECT * FROM support_workflow_runs WHERE workflow_id = ?', [proactive.data.workflow.id])
  await query("UPDATE support_workflow_runs SET status = 'running', lease_token = 'dead-worker', lease_until = 1 WHERE id = ?", [proactiveRun!.id])
  await restartResume(proactiveRun!.id)
  check((await one('SELECT status FROM support_workflow_runs WHERE id = ?', [proactiveRun!.id]))?.status === 'completed', 'replacement worker recovers expired ownership lease')
  check(Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id]))?.used) === 2, 'proactive conversation uses the same exact quota admission')
  const proactiveContext = JSON.parse(String((await one('SELECT context FROM support_workflow_runs WHERE id = ?', [proactiveRun!.id]))?.context))
  check(proactiveContext.conversationId && Number((await one("SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ? AND author_type = 'automation'", [proactiveContext.conversationId]))?.count) === 1, 'proactive opener is automation-authored and persisted')
  check(JSON.parse(String((await one('SELECT attributes FROM support_contacts WHERE id = ?', [Number(session.contact.id)]))?.attributes)).onboarded === true, 'allowlisted internal contact tool persisted')
  // A quota refusal keeps the durable run blocked, without a phantom conversation or message.
  await query("UPDATE support_workspaces SET plan = 'free', stacks_verified = ?, deployment_verified = ? WHERE id = ?", [true, true, project.workspace_id])
  await query("UPDATE support_usage SET used = 120 WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id])
  const beforeConversations = Number((await one('SELECT COUNT(*) AS count FROM support_conversations WHERE project_id = ?', [project.id]))?.count)
  await http(`${sdk}/events`, 'POST', { externalId: 'vip-1', event: 'onboarding', idempotencyKey: 'onboard-blocked' }, keys.ingestKey)
  await workflowWorkerTick()
  const blocked = await one('SELECT * FROM support_workflow_runs WHERE workflow_id = ? ORDER BY id DESC LIMIT 1', [proactive.data.workflow.id])
  check(blocked?.status === 'blocked' && Number((await one('SELECT COUNT(*) AS count FROM support_conversations WHERE project_id = ?', [project.id]))?.count) === beforeConversations, 'proactive quota overflow stays recoverable without creating phantom support traffic')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_workflow_steps WHERE workflow_run_id = ?', [blocked!.id]))?.count) === 0, 'quota refusal rolls back the entire effect and checkpoint')
  await query("UPDATE support_usage SET used = 119 WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id])
  await query('UPDATE support_workflow_runs SET available_at = 0 WHERE id = ?', [blocked!.id])
  await restartResume(blocked!.id)
  await restartResume(blocked!.id)
  check((await one('SELECT status FROM support_workflow_runs WHERE id = ?', [blocked!.id]))?.status === 'completed' && Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id]))?.used) === 120, 'blocked proactive workflow recovers with exact allowance once capacity returns')
  const ordinary = (await http(`${sdk}/sessions`, 'POST', { externalId: 'ordinary', name: 'Bo', attributes: { tier: 'standard' } }, keys.ingestKey)).data
  await http(`${sdk}/events`, 'POST', { externalId: 'ordinary', event: 'billing.requested', idempotencyKey: 'ordinary-branch' }, keys.ingestKey)
  await workflowWorkerTick()
  const falseRun = await one('SELECT r.* FROM support_workflow_runs r JOIN support_events e ON e.id = r.event_id WHERE r.workflow_id = ? AND e.contact_id = ?', [workflow.id, Number(ordinary.contact.id)])
  await restartResume(falseRun!.id)
  check((await one('SELECT status FROM support_workflow_runs WHERE id = ?', [falseRun!.id]))?.status === 'completed' && Number((await one('SELECT COUNT(*) AS count FROM support_workflow_steps WHERE workflow_run_id = ?', [falseRun!.id]))?.count) === 2, 'false condition follows its explicit end branch without executing VIP effects')
  console.log(`PASS workflows HTTP ${checks} checks`)
}
finally { await server.stop(true) }
