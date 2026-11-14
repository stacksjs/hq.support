import { createHash, randomBytes } from 'node:crypto'
import type { Row } from './database'
import type { Plan } from './limits'
import { db, insert, one, query, workspaceTransaction } from './database'
import { billingPolicy, limitsFor, periodOf } from './limits'
import { fail, identifier, text } from './errors'
import { initialWorkspaceEntitlement } from './deployment'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const secret = () => randomBytes(32).toString('hex')
export function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {} }
export const jsonText = (value: unknown) => JSON.stringify(object(value))
const number = (row: Row, key: string) => Number(row[key])

export async function workspace(id: number): Promise<Row> {
  const row = await one('SELECT * FROM support_workspaces WHERE id = ?', [id])
  if (!row) fail(404, 'not_found', 'Workspace not found.')
  return row
}
export async function entitled(id: number): Promise<Row> {
  let row = await workspace(id)
  if (['starter', 'growth', 'enterprise'].includes(String(row.plan))) {
    const subscription = await one('SELECT * FROM support_subscriptions WHERE workspace_id = ? ORDER BY id DESC LIMIT 1', [id])
    if (subscription && (subscription.status !== 'active' || Number(subscription.current_period_end) <= Date.now())) row = { ...row, plan: row.stacks_verified && row.deployment_verified && Number(row.free_qualified_at) ? 'free' : 'trial' }
  }
  if (row.plan === 'trial' && Number(row.trial_ends_at) <= Date.now()) fail(402, 'trial_expired', 'Choose a plan to start new conversations.')
  if (row.plan === 'free' && (!row.stacks_verified || !row.deployment_verified)) fail(403, 'verification_required', 'Verify your Stacks application and deployment first.')
  return row
}
export async function member(userId: number, workspaceId: number, roles?: string[]): Promise<Row> {
  const row = await one("SELECT * FROM support_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active'", [workspaceId, userId])
  if (!row || (roles && !roles.includes(String(row.role)))) fail(403, 'forbidden', 'Workspace access denied.')
  return row
}
export async function project(reference: string): Promise<Row> {
  const row = await one('SELECT * FROM support_projects WHERE public_id = ?', [reference])
  if (!row) fail(404, 'not_found', 'Project not found.')
  return row
}
export async function agentProject(userId: number, reference: string, roles?: string[]): Promise<Row> {
  const row = await project(reference)
  await member(userId, number(row, 'workspace_id'), roles)
  return row
}
export async function keyProject(reference: string, key: string, scope: 'read' | 'write'): Promise<Row> {
  const row = await project(reference)
  const token = await one(`SELECT * FROM support_api_keys WHERE project_id = ? AND digest = ? AND scope IN (${scope === 'read' ? "'read', 'write'" : "'write'"}) AND revoked_at = 0`, [row.id, digest(key)])
  if (!token) fail(401, 'unauthorized', 'A valid project key is required.')
  return row
}
export async function readPrincipal(key: string) {
  const token = await one("SELECT * FROM support_api_keys WHERE digest = ? AND scope = 'read' AND revoked_at = 0", [digest(key)])
  return token ? { owner: String(token.workspace_id), project: String((await one('SELECT public_id FROM support_projects WHERE id = ?', [token.project_id]))?.public_id) } : null
}
export async function createWorkspace(user: { id: number, email: string }, name: string) {
  return await db.transaction(async () => {
    const row = await insert('support_workspaces', { public_id: crypto.randomUUID(), owner_id: user.id, name: text(name, 'name'), ...initialWorkspaceEntitlement() })
    await insert('support_memberships', { workspace_id: row.id, user_id: user.id, email: user.email.toLowerCase(), role: 'owner', status: 'active' })
    return row
  })
}
export async function createProject(workspaceId: number, name: string) {
  return await workspaceTransaction(workspaceId, async () => {
    const owner = await entitled(workspaceId)
    const count = Number((await one('SELECT COUNT(*) AS count FROM support_projects WHERE workspace_id = ?', [workspaceId]))?.count)
    const limit = limitsFor(owner.plan as Plan).projects
    if (limit !== null && count >= limit) fail(402, 'project_limit', 'Project allowance reached.')
    return await insert('support_projects', { workspace_id: workspaceId, public_id: crypto.randomUUID(), name: text(name, 'name'), allowed_origins: '[]', anonymous_enabled: false })
  })
}
export async function issueKeys(projectRow: Row) {
  const write = secret(), read = secret()
  for (const [scope, key] of [['write', write], ['read', read]]) await insert('support_api_keys', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, digest: digest(key!), scope })
  return { ingestKey: write, readKey: read }
}
export async function invite(workspaceId: number, email: unknown, role: unknown = 'agent') {
  const address = text(email, 'email', 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) fail(422, 'invalid_input', 'A valid email is required.')
  if (!['agent', 'admin'].includes(String(role))) fail(422, 'invalid_input', 'Role must be agent or admin.')
  return await workspaceTransaction(workspaceId, async () => {
    const owner = await entitled(workspaceId)
    const existing = await one('SELECT * FROM support_memberships WHERE workspace_id = ? AND email = ?', [workspaceId, address])
    if (existing) return existing
    const count = Number((await one("SELECT COUNT(*) AS count FROM support_memberships WHERE workspace_id = ? AND status IN ('active', 'pending')", [workspaceId]))?.count)
    const limit = limitsFor(owner.plan as Plan).seats
    if (limit !== null && count >= limit) fail(402, 'seat_limit', 'Agent allowance includes pending invitations.')
    return await insert('support_memberships', { workspace_id: workspaceId, user_id: null, email: address, role, status: 'pending' })
  })
}
export async function contact(projectRow: Row, identity: Row) {
  const externalId = text(identity.externalId, 'externalId', 255)
  const found = await one('SELECT * FROM support_contacts WHERE project_id = ? AND external_id = ?', [projectRow.id, externalId])
  const company = object(identity.company), companyId = identity.company !== undefined && typeof identity.company !== 'string' ? text(company.id, 'company.id', 255) : undefined
  const previousAttributes = found ? object(JSON.parse(String(found.attributes))) : {}
  const previousCompany = object(previousAttributes._hqSupportCompany)
  const companyName = companyId && company.name !== undefined ? text(company.name, 'company.name', 200) : companyId && previousCompany.id === companyId && typeof previousCompany.name === 'string' ? previousCompany.name : undefined
  const attributes = { ...(identity.attributes === undefined ? previousAttributes : object(identity.attributes)) }
  // This namespace is derived from the SDK's typed company field, never a
  // client-supplied attributes override. Existing company identity survives
  // unrelated profile/event updates.
  delete attributes._hqSupportCompany
  if (companyId) attributes._hqSupportCompany = { id: companyId, ...(companyName ? { name: companyName } : {}) }
  else if (identity.company === undefined && previousAttributes._hqSupportCompany !== undefined) attributes._hqSupportCompany = previousAttributes._hqSupportCompany
  const fields = { name: typeof identity.name === 'string' ? identity.name.slice(0, 200) : '', email: typeof identity.email === 'string' ? identity.email.slice(0, 254) : '', company: typeof identity.company === 'string' ? identity.company.slice(0, 200) : (companyName || companyId || '').slice(0, 200), attributes: JSON.stringify(attributes) }
  if (found) {
    await query('UPDATE support_contacts SET name = ?, email = ?, company = ?, attributes = ?, updated_at = ? WHERE id = ? AND project_id = ?', [fields.name || found.name, fields.email || found.email, fields.company || found.company, fields.attributes, new Date().toISOString(), found.id, projectRow.id])
    return (await one('SELECT * FROM support_contacts WHERE id = ?', [found.id]))!
  }
  return await insert('support_contacts', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, external_id: externalId, ...fields })
}
export async function createSession(projectRow: Row, identity: Row) {
  return await workspaceTransaction(number(projectRow, 'workspace_id'), async () => {
    const person = await contact(projectRow, identity)
    const token = secret(), expiresAt = Date.now() + 86400000
    await insert('support_customer_sessions', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, contact_id: person.id, digest: digest(token), expires_at: expiresAt })
    return { token, expiresAt, contact: { id: String(person.id), externalId: String(person.external_id), name: String(person.name), email: String(person.email) } }
  })
}
export async function customer(projectRow: Row, token: string): Promise<Row> {
  const session = await one('SELECT * FROM support_customer_sessions WHERE digest = ? AND project_id = ? AND expires_at > ?', [digest(token), projectRow.id, Date.now()])
  if (!session) fail(401, 'invalid_session', 'Customer session is invalid or expired.')
  return (await one('SELECT * FROM support_contacts WHERE id = ? AND project_id = ?', [session.contact_id, projectRow.id]))!
}
export async function usage(workspaceId: number, meter: string, period = periodOf()): Promise<number> {
  return Number((await one('SELECT used FROM support_usage WHERE workspace_id = ? AND period = ? AND meter = ?', [workspaceId, period, meter]))?.used ?? 0)
}
async function consume(workspaceId: number, meter: 'conversations' | 'ai', limit: number | null) {
  const period = periodOf(), used = await usage(workspaceId, meter, period)
  if (limit !== null && used >= limit) fail(402, `${meter}_limit`, `${meter === 'ai' ? 'AI conversation' : 'New conversation'} allowance reached.`)
  const found = await one('SELECT id FROM support_usage WHERE workspace_id = ? AND period = ? AND meter = ?', [workspaceId, period, meter])
  if (found) await query('UPDATE support_usage SET used = used + 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), found.id])
  else await insert('support_usage', { workspace_id: workspaceId, period, meter, used: 1 })
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
export async function idempotent<T>(projectRow: Row, operation: string, keyValue: unknown, payload: unknown, action: () => Promise<T>): Promise<T> {
  const key = text(keyValue, 'idempotencyKey', 200), fingerprint = digest(canonical(payload))
  return await workspaceTransaction(number(projectRow, 'workspace_id'), async () => {
    const existing = await one('SELECT * FROM support_idempotency WHERE project_id = ? AND operation = ? AND key = ?', [projectRow.id, operation, key])
    if (existing) {
      if (existing.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'This idempotency key was used with different input.')
      return JSON.parse(String(existing.response)) as T
    }
    const result = await action()
    await insert('support_idempotency', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, operation, key, fingerprint, response: JSON.stringify(result) })
    return result
  })
}
export async function enqueue(projectRow: Row, kind: string, payload: Row) {
  return await insert('support_outbox', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, event_id: crypto.randomUUID(), kind, payload: JSON.stringify(payload), available_at: Date.now() })
}
const isoTime = (value: unknown) => value instanceof Date ? value.toISOString() : String(value)
export function summary(row: Row) {
  return { id: String(row.id), subject: String(row.subject), status: String(row.status), customer_id: String(row.contact_id), updated_at: isoTime(row.updated_at), unread_count: Number(row.agent_unread_count ?? row.unread_count) }
}
export function messageView(row: Row) {
  return { id: String(row.id), conversation_id: String(row.conversation_id), body: String(row.body), visibility: String(row.visibility), author_type: String(row.author_type), created_at: isoTime(row.created_at), delivery_status: String(row.delivery_status) }
}
export async function conversation(projectRow: Row, id: unknown, person?: Row): Promise<Row> {
  const row = await one('SELECT * FROM support_conversations WHERE id = ? AND project_id = ?', [identifier(id), projectRow.id])
  if (!row || (person && row.contact_id !== person.id)) fail(404, 'not_found', 'Conversation not found.')
  return row
}
/** States supported by actual conversation transitions, independent of ticket state names. */
export const conversationStatuses = ['open', 'closed', 'snoozed'] as const
export async function conversations(projectRow: Row, person?: Row, cursor?: string | null, agentId?: number, options: { status?: unknown, limit?: unknown } = {}) {
  if (cursor !== undefined && cursor !== null && !/^[1-9]\d*$/.test(cursor)) fail(422, 'invalid_cursor', 'Use the conversation cursor returned by the previous page.')
  const before = cursor === undefined || cursor === null ? Number.MAX_SAFE_INTEGER : identifier(cursor)
  if (options.status !== undefined && !conversationStatuses.some(status => status === options.status)) fail(422, 'invalid_status', 'Conversation status must be open, closed or snoozed.')
  const limit = options.limit === undefined ? 50 : typeof options.limit === 'number' ? options.limit : typeof options.limit === 'string' && /^[1-9]\d{0,2}$/.test(options.limit) ? Number(options.limit) : NaN
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(422, 'invalid_limit', 'Conversation limit must be a whole number from 1 to 100.')
  const readProjection = agentId ? `, (SELECT COUNT(*) FROM support_messages m WHERE m.conversation_id = support_conversations.id AND m.project_id = support_conversations.project_id AND m.author_type = 'customer' AND m.visibility = 'public' AND m.delivery_status <> 'imported' AND m.id > COALESCE((SELECT last_message_id FROM support_conversation_reads r WHERE r.conversation_id = support_conversations.id AND r.user_id = ?), 0)) AS agent_unread_count` : ''
  const rows = await query(`SELECT support_conversations.*${readProjection} FROM support_conversations WHERE project_id = ? AND id < ?${person ? ' AND contact_id = ?' : ''}${options.status !== undefined ? ' AND status = ?' : ''} ORDER BY id DESC LIMIT ?`, [...(agentId ? [agentId] : []), projectRow.id, before, ...(person ? [person.id] : []), ...(options.status !== undefined ? [options.status] : []), limit + 1])
  return { conversations: rows.slice(0, limit).map(summary), nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null }
}
export async function detail(projectRow: Row, id: unknown, person?: Row, beforeMessage?: string | null) {
  const row = await conversation(projectRow, id, person)
  const before = beforeMessage ? identifier(beforeMessage) : Number.MAX_SAFE_INTEGER
  const page = await query(`SELECT * FROM support_messages WHERE project_id = ? AND conversation_id = ? AND id < ?${person ? " AND visibility = 'public'" : ''} ORDER BY id DESC LIMIT 501`, [projectRow.id, row.id, before])
  const messages = page.slice(0, 500).reverse(), messagesNextCursor = page.length > 500 ? String(messages[0]!.id) : null
  const personRow = await one('SELECT * FROM support_contacts WHERE id = ? AND project_id = ?', [row.contact_id, projectRow.id])
  const attachments = await query(`SELECT id, file_name, mime_type, bytes, status, visibility FROM support_attachments WHERE project_id = ? AND conversation_id = ? AND status = 'stored'${person ? " AND (visibility = 'public' OR contact_id = ?)" : ''} ORDER BY id ASC`, [projectRow.id, row.id, ...(person ? [person.id] : [])])
  return { attachments: attachments.map(file => ({ id: String(file.id), fileName: file.file_name, mimeType: file.mime_type, bytes: Number(file.bytes), status: file.status, visibility: file.visibility })), conversation: summary(row), contact: { id: String(personRow?.id), name: String(personRow?.name), email: String(personRow?.email), externalId: String(personRow?.external_id) }, messages: messages.map(messageView), messagesNextCursor }
}
export async function createConversation(projectRow: Row, identity: Row, input: Row, person?: Row, automation?: { workflowRunId: number, automationDepth: number }, options?: { mediaOnly?: boolean }) {
  return await idempotent(projectRow, `conversation:${person?.id ?? identity.externalId}`, input.idempotencyKey, input, async () => {
    const owner = await entitled(number(projectRow, 'workspace_id'))
    const who = person ?? await contact(projectRow, identity)
    await consume(number(projectRow, 'workspace_id'), 'conversations', limitsFor(owner.plan as Plan).conversationCeiling)
    const row = await insert('support_conversations', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, contact_id: who.id, subject: text(input.subject, 'subject', 200), status: 'open', unread_count: 1 })
    const message = await insert('support_messages', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, conversation_id: row.id, contact_id: who.id, body: options?.mediaOnly && input.body === '' ? '' : text(input.body, 'body', 20000), visibility: 'public', author_type: 'customer' })
    await enqueue(projectRow, 'conversation.created', { conversationId: row.id, messageId: message.id, ...(automation || {}) })
    return { conversation: summary(row) }
  })
}
export async function reply(projectRow: Row, id: unknown, input: Row, actor: { customer?: Row, userId?: number, deferDelivery?: boolean, mediaOnly?: boolean }) {
  const visibility = actor.customer ? 'public' : input.visibility ?? 'public'
  if (actor.customer && input.visibility && input.visibility !== 'public') fail(403, 'forbidden', 'Customer messages must be public.')
  if (!['public', 'internal'].includes(String(visibility))) fail(422, 'invalid_input', 'Visibility must be public or internal.')
  return await idempotent(projectRow, `reply:${id}:${actor.customer?.id ?? actor.userId ?? 'server'}`, input.idempotencyKey, input, async () => {
    const row = await conversation(projectRow, id, actor.customer)
    const message = await insert('support_messages', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, conversation_id: row.id, contact_id: row.contact_id, body: actor.mediaOnly && input.body === '' ? '' : text(input.body, 'body', 20000), visibility, author_type: actor.customer ? 'customer' : 'agent', author_id: actor.userId ?? 0 })
    await query('UPDATE support_conversations SET updated_at = ?, unread_count = unread_count + ? WHERE id = ? AND project_id = ?', [new Date().toISOString(), actor.customer ? 1 : 0, row.id, projectRow.id])
    await enqueue(projectRow, visibility === 'internal' ? 'note.created' : 'message.created', { conversationId: row.id, messageId: message.id })
    if (actor.userId && visibility === 'public' && !actor.deferDelivery) {
      await (await import('./attachments')).shareAttachments(projectRow, row.id, input.attachmentIds)
      const { recordTicketFirstResponse } = await import('./ticket-sla')
      await recordTicketFirstResponse(projectRow, row.id)
    }
    return { message: messageView(message) }
  })
}
export async function track(projectRow: Row, input: Row) {
  return await idempotent(projectRow, 'event', input.idempotencyKey, input, async () => {
    const externalId = text(input.externalId, 'externalId', 255)
    const person = await one('SELECT * FROM support_contacts WHERE project_id = ? AND external_id = ?', [projectRow.id, externalId]) ?? await contact(projectRow, { externalId })
    const event = await insert('support_events', { workspace_id: projectRow.workspace_id, project_id: projectRow.id, contact_id: person.id, event: text(input.event, 'event', 200), attributes: jsonText(input.attributes) })
    await enqueue(projectRow, 'event.created', { eventId: event.id })
    return { id: String(event.id), accepted: true }
  })
}
export async function updateConversation(projectRow: Row, id: unknown, input: Row) {
  return await workspaceTransaction(number(projectRow, 'workspace_id'), async () => {
    const row = await conversation(projectRow, id)
    const status = input.status ?? row.status, assigneeId = Number(input.assigneeId === undefined ? row.assignee_id : input.assigneeId)
    if (!Number.isSafeInteger(assigneeId) || assigneeId < 0) fail(422, 'invalid_assignee', 'Assignee must be an active workspace user identifier, or zero to unassign.')
    if (!conversationStatuses.some(value => value === status)) fail(422, 'invalid_input', 'Unknown conversation status.')
    if (assigneeId) await member(Number(assigneeId), number(projectRow, 'workspace_id'))
    await query('UPDATE support_conversations SET status = ?, assignee_id = ?, unread_count = 0, updated_at = ? WHERE id = ? AND project_id = ?', [status, assigneeId, new Date().toISOString(), row.id, projectRow.id])
    return { conversation: summary((await conversation(projectRow, id))) }
  })
}

/** Internal atomic admission primitive; provider orchestration uses durable run reservations and reconciliation. */
export async function reserveAi(projectRow: Row, conversationId: unknown, tokens: number) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0) fail(422, 'invalid_input', 'Token reservation must be a positive integer.')
  return await workspaceTransaction(number(projectRow, 'workspace_id'), async () => {
    const owner = await entitled(number(projectRow, 'workspace_id')), row = await conversation(projectRow, conversationId)
    if (Number(row.ai_turns) >= billingPolicy.aiMaxTurns || Number(row.ai_tokens) + tokens > billingPolicy.aiMaxTokens) fail(402, 'ai_unit_limit', 'This AI conversation reached its turn or token limit.')
    if (row.ai_charged_period !== periodOf()) await consume(number(projectRow, 'workspace_id'), 'ai', limitsFor(owner.plan as Plan).ai)
    await query('UPDATE support_conversations SET ai_turns = ai_turns + 1, ai_tokens = ai_tokens + ?, ai_charged_period = ? WHERE id = ?', [tokens, periodOf(), row.id])
    return { conversationId: row.id, tokens }
  })
}
