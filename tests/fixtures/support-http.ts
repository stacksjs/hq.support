import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { db, one, query, workspaceTransaction } from '../../app/Support/database'
import { digest, enqueue, reserveAi, usage } from '../../app/Support/service'
import { Storage } from '@stacksjs/storage'
import { drainOutbox, processInbound, receiveInbound } from '../../app/Support/delivery'
import { route } from '@stacksjs/router'
import { overridesReady, config } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
const migrated = await runDatabaseMigration()
assert.equal((await migrateAuthTables()).success, true)
assert.equal(migrated.isOk, true, 'Native migrations must apply')
await injectGlobalAutoImports()
await route.importRoutes()
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let checks = 0
let csrfToken = '', csrfCookie = ''
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++ }
async function request(path: string, method = 'GET', body?: unknown, token?: string, origin?: string) {
  const result = await fetch(base + path, { method, headers: { 'accept': 'application/json', ...(csrfCookie ? { cookie: csrfCookie, 'x-csrf-token': csrfToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const raw = await result.text()
  let data: any
  try { data = JSON.parse(raw) }
  catch { throw new Error(`${method} ${path} answered ${result.status}: ${raw.slice(0, 300)}`) }
  return { status: result.status, data, headers: result.headers }
}
try {
  const csrf = await request('/csrf-token')
  csrfToken = csrf.data.token
  csrfCookie = csrf.headers.get('set-cookie')!.split(';')[0]!
  const register = await request('/register', 'POST', { name: 'Owner One', email: 'owner@example.test', password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  check(register.status === 200 || register.status === 201, `native registration: ${register.status} ${JSON.stringify(register.data)}`)
  const login = await request('/login', 'POST', { email: 'owner@example.test', password: 'SecureSupport2026!' })
  const token = login.data.token ?? login.data.access_token ?? login.data.data?.token
  check(typeof token === 'string', `native login issues token ${JSON.stringify(login.data)}`)
  const otherRegister = await request('/register', 'POST', { name: 'Owner Two', email: 'other@example.test', password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  check(otherRegister.status < 300, 'second account registers')
  const otherLogin = await request('/login', 'POST', { email: 'other@example.test', password: 'SecureSupport2026!' })
  const otherToken = otherLogin.data.token ?? otherLogin.data.access_token ?? otherLogin.data.data?.token
  const workspace = await request('/support/workspaces', 'POST', { name: 'Support company' }, token)
  check(workspace.status === 201, `workspace created: ${JSON.stringify(workspace.data)}`)
  const workspaceId = workspace.data.workspace.id
  const selected = await request(`/support/workspaces/${workspaceId}/projects`, 'POST', { name: 'Main app' }, token)
  check(selected.status === 201, `project created: ${JSON.stringify(selected.data)}`)
  const project = selected.data.project, prefix = `/v1/projects/${project.public_id}`, agent = `/support/projects/${project.public_id}`, widget = `/widget/projects/${project.public_id}`
  const keysResult = await request(`${agent}/keys`, 'POST', {}, token)
  check(keysResult.status === 201, 'keys issued')
  const keys = keysResult.data
  const agents = await request(`${agent}/agents`, 'GET', undefined, token)
  check(agents.status === 200 && agents.data.agents.length === 1 && agents.data.agents[0].email === 'owner@example.test', 'agent picker lists active humans in the workspace only')
  check((await request(`${agent}/inbox`, 'GET', undefined, otherToken)).status === 403, 'tenant isolation denies other owner')
  check((await request(prefix + '/sessions', 'POST', { externalId: 'c1' }, keys.readKey)).status === 401, 'read key cannot issue customer session')
  const session = await request(prefix + '/sessions', 'POST', { externalId: 'c1', name: 'Ada', email: 'ada@example.test' }, keys.ingestKey)
  check(session.status === 200, `server session issued ${JSON.stringify(session.data)}`)
  check(!await one('SELECT id FROM support_customer_sessions WHERE digest = ?', [session.data.token]), 'customer token not persisted in plaintext')
  check(Boolean(await one('SELECT id FROM support_customer_sessions WHERE digest = ?', [digest(session.data.token)])), 'customer token hash persisted')
  check((await request(`${agent}`, 'PATCH', { allowedOrigins: ['https://customer.example'], anonymousEnabled: true }, token)).status === 200, 'origin setting saved')
  const widgetSession = await request(widget + '/session', 'POST', { token: session.data.token }, undefined, 'https://customer.example')
  check(widgetSession.status === 200 && widgetSession.headers.get('access-control-allow-origin') === 'https://customer.example', 'widget session with project origin CORS')
  check((await request(widget + '/session', 'POST', {}, undefined, 'https://evil.example')).status === 403, 'unlisted widget origin denied')
  const payload = { externalId: 'c1', subject: 'Need help', body: 'How do I sign in?', idempotencyKey: 'create-1' }
  const created = await request(prefix + '/conversations', 'POST', payload, keys.ingestKey)
  check(created.status === 201, `conversation persisted ${JSON.stringify(created.data)}`)
  const conversation = created.data.conversation
  // Global native db helpers must stay on the transaction connection on both dialects.
  await assert.rejects(workspaceTransaction(workspaceId, async () => {
    await query('UPDATE support_usage SET used = used + 100 WHERE workspace_id = ?', [workspaceId])
    await enqueue(project, 'rollback.probe', { marker: 'must roll back' })
    throw new Error('rollback probe')
  }), /rollback probe/)
  check(await usage(workspaceId, 'conversations') === 1 && !await one("SELECT id FROM support_outbox WHERE kind = 'rollback.probe'"), 'explicit transaction rollback covers global query helper and insert on same connection')
  const invalidConversation = await request(prefix + '/conversations', 'POST', { ...payload, body: '', idempotencyKey: 'invalid-body' }, keys.ingestKey)
  check(invalidConversation.status === 422 && await usage(workspaceId, 'conversations') === 1 && Number((await one('SELECT COUNT(*) AS n FROM support_conversations WHERE project_id = ?', [project.id]))?.n) === 1, 'HTTP body validation rolls back conversation and quota reservation')
  const ticketCountBeforeInvalid = Number((await one('SELECT COUNT(*) AS count FROM support_tickets WHERE workspace_id = ?', [workspaceId]))!.count)
  const outboxBeforeInvalid = Number((await one('SELECT COUNT(*) AS count FROM support_outbox WHERE workspace_id = ?', [workspaceId]))!.count)
  for (const [invalidIndex, invalidId] of [true, false, null, [session.data.contact.id], {}, `${session.data.contact.id}e0`].entries()) {
    const invalidTicket = await request(`${agent}/tickets`, 'POST', { contactId: invalidId, title: 'Malformed contact must not create a ticket', description: 'Validation fixture', idempotencyKey: `invalid-ticket-id-${invalidIndex}` }, token)
    check(invalidTicket.status === 422 && invalidTicket.data.error.code === 'invalid_identifier', `existing ticket HTTP mutation rejects coerced contact ID ${JSON.stringify(invalidId)}`)
  }
  check(Number((await one('SELECT COUNT(*) AS count FROM support_tickets WHERE workspace_id = ?', [workspaceId]))!.count) === ticketCountBeforeInvalid && Number((await one('SELECT COUNT(*) AS count FROM support_outbox WHERE workspace_id = ?', [workspaceId]))!.count) === outboxBeforeInvalid, 'invalid core contact identifiers leave tickets and transactional outbox unchanged')
  const duplicate = await request(prefix + '/conversations', 'POST', payload, keys.ingestKey)
  check(duplicate.data.conversation.id === conversation.id && await usage(workspaceId, 'conversations') === 1, 'retry returns same conversation, allowance counts once')
  check((await request(prefix + '/conversations', 'POST', { ...payload, body: 'different' }, keys.ingestKey)).status === 409, 'idempotency payload mismatch denied')
  const note = await request(`${agent}/conversations/${conversation.id}/messages`, 'POST', { body: 'Private account investigation', visibility: 'internal', idempotencyKey: 'note-1' }, token)
  check(note.status === 201, `internal note stored ${JSON.stringify(note.data)}`)
  const customerDetail = await request(`${widget}/conversations/${conversation.id}`, 'GET', undefined, session.data.token, 'https://customer.example')
  check(customerDetail.status === 200 && customerDetail.data.messages.length === 1, 'internal note excluded from customer detail')
  const privatePost = await request(`${widget}/conversations/${conversation.id}/messages`, 'POST', { body: 'forged note', visibility: 'internal', idempotencyKey: 'forged' }, session.data.token, 'https://customer.example')
  check(privatePost.status === 403, 'customer cannot send internal note')
  const agentBeforeRead = await request(`${agent}/inbox`, 'GET', undefined, token)
  check(agentBeforeRead.data.conversations[0].unread_count === 1, 'agent unread count begins at unread customer public messages')
  const read = await request(`${agent}/conversations/${conversation.id}/read`, 'POST', { lastMessageId: customerDetail.data.messages[0].id }, token)
  check(read.status === 200 && read.data.unreadCount === 0, 'agent last-seen cursor marks displayed messages read')
  check((await request(`${agent}/inbox`, 'GET', undefined, token)).data.conversations[0].unread_count === 0, 'inbox uses per-agent read cursor')

  const sessionTwo = await request(prefix + '/sessions', 'POST', { externalId: 'c2' }, keys.ingestKey)
  check((await request(`${widget}/conversations/${conversation.id}`, 'GET', undefined, sessionTwo.data.token, 'https://customer.example')).status === 404, 'customer cannot read another contact conversation')
  const listing = await request(prefix + '/conversations', 'GET', undefined, keys.readKey)
  check(listing.status === 200 && listing.data.conversations[0].customer_id === session.data.contact.id && listing.data.nextCursor === null, 'HQ summary wire contract')
  const summaryJson = JSON.stringify(listing.data)
  check(!summaryJson.includes('Private account investigation') && !summaryJson.includes('ada@example.test'), 'HQ summary omits body and customer PII')
  check(Number((await one('SELECT COUNT(*) AS n FROM support_outbox WHERE project_id = ?', [project.id]))?.n) === 2, 'conversation and note atomically enqueue delivery work')
  async function uploadAttachment(name: string, content: Uint8Array, key: string) {
    const form = new FormData()
    form.set('file', new File([content.buffer as ArrayBuffer], name, { type: 'text/plain' }))
    form.set('idempotencyKey', key)
    const result = await fetch(base + `${agent}/conversations/${conversation.id}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, body: form })
    return { status: result.status, data: await result.json() as any }
  }
  const uploaded = await uploadAttachment('answer.txt', new TextEncoder().encode('private file'), 'upload-1')
  check(uploaded.status === 201 && uploaded.data.attachment.status === 'stored' && uploaded.data.attachment.bytes === 12, `native private attachment stored: ${JSON.stringify(uploaded.data)}`)
  const retriedUpload = await uploadAttachment('answer.txt', new TextEncoder().encode('private file'), 'upload-1')
  check(retriedUpload.data.attachment.id === uploaded.data.attachment.id && Number((await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspaceId]))?.storage_bytes) === 12, 'attachment retry does not charge twice')
  check((await uploadAttachment('changed.txt', new TextEncoder().encode('different file'), 'upload-1')).status === 409, 'attachment idempotency mismatch refused')
  const downloaded = await fetch(base + `${widget}/attachments/${uploaded.data.attachment.id}`, { headers: { authorization: `Bearer ${session.data.token}`, origin: 'https://customer.example' } })
  check(downloaded.status === 404, 'an unshared agent attachment stays private even inside the customer’s own conversation')
  check(!(await request(`${widget}/conversations/${conversation.id}`, 'GET', undefined, session.data.token, 'https://customer.example')).data.attachments.some((file: any) => file.id === uploaded.data.attachment.id), 'customer metadata does not disclose private agent files')
  check((await request(`${widget}/attachments/${uploaded.data.attachment.id}`, 'GET', undefined, sessionTwo.data.token, 'https://customer.example')).status === 404, 'another customer cannot read attachment')
  const unconfigured = await drainOutbox(async () => ({ status: 'unconfigured', reason: 'No provider configured' }))
  check(unconfigured.delivered === 0 && unconfigured.unconfigured === 2 && !await one("SELECT id FROM support_outbox WHERE status = 'delivered'"), 'unconfigured provider never reports successful delivery')
  await query('UPDATE support_outbox SET available_at = 0 WHERE project_id = ?', [project.id])
  const deliveredIds: string[] = []
  const delivery = async (event: { id: string }) => { deliveredIds.push(event.id); await Promise.resolve(); return { status: 'delivered' as const, receipt: `test-provider:${event.id}` } }
  const drained = await Promise.all([drainOutbox(delivery), drainOutbox(delivery)])
  check(drained.reduce((n, item) => n + item.delivered, 0) === 2 && new Set(deliveredIds).size === 2 && deliveredIds.length === 2, 'concurrent outbox workers claim each active lease once')
  await request(`${agent}/conversations/${conversation.id}/messages`, 'POST', { body: 'Internal file context', visibility: 'internal', attachmentIds: [uploaded.data.attachment.id], idempotencyKey: 'internal-file' }, token)
  check((await fetch(base + `${widget}/attachments/${uploaded.data.attachment.id}`, { headers: { authorization: `Bearer ${session.data.token}`, origin: 'https://customer.example' } })).status === 404, 'internal notes never publish attached agent files')
  const shared = await request(`${agent}/conversations/${conversation.id}/messages`, 'POST', { body: 'Here is your file', attachmentIds: [uploaded.data.attachment.id], idempotencyKey: 'public-file' }, token)
  check(shared.status === 201, 'an explicit public agent reply publishes scoped selected attachments')
  const publicDownload = await fetch(base + `${widget}/attachments/${uploaded.data.attachment.id}`, { headers: { authorization: `Bearer ${session.data.token}`, origin: 'https://customer.example' } })
  check(publicDownload.status === 200 && await publicDownload.text() === 'private file' && publicDownload.headers.get('content-disposition')?.startsWith('attachment;'), 'published files download privately with safe disposition')
  await query('UPDATE support_contacts SET attributes = ? WHERE id = ?', [JSON.stringify({ tier: 'gold' }), Number(session.data.contact.id)])
  const tracked = await request(prefix + '/events', 'POST', { externalId: 'c1', event: 'signed_in', attributes: { page: '/home' }, idempotencyKey: 'event-1' }, keys.ingestKey)
  check(tracked.status === 200 && tracked.data.accepted === true && JSON.parse(String((await one('SELECT attributes FROM support_contacts WHERE id = ?', [Number(session.data.contact.id)]))?.attributes)).tier === 'gold', 'event metadata never overwrites contact identity attributes')
  const inbound = await receiveInbound(project, 'test-provider', 'provider-event-1', { message: 'Retain this support request' })
  check((await receiveInbound(project, 'test-provider', 'provider-event-1', { message: 'duplicate' })).id === inbound.id, 'provider ingress retries deduplicate durably')
  check(!(await processInbound(inbound.id, async () => { throw new Error('quota exceeded') })).processed, 'inbound overflow deferred')
  const retained = await one('SELECT * FROM support_inbound WHERE id = ?', [Number(inbound.id)])
  check(retained?.status === 'pending' && JSON.parse(String(retained.payload)).message === 'Retain this support request', 'inbound overflow payload persisted without sampling or replacement')
  await query('UPDATE support_inbound SET available_at = 0 WHERE id = ?', [Number(inbound.id)])
  check((await processInbound(inbound.id, async () => {})).processed, 'persisted inbound overflow can recover later')
  // Set verified free state only inside this owned test database. There is no public plan mutation endpoint.
  await query("UPDATE support_workspaces SET plan = 'free', stacks_verified = ?, deployment_verified = ? WHERE id = ?", [true, true, workspaceId])
  check((await request(`/support/workspaces/${workspaceId}/invitations`, 'POST', { email: 'invite@example.test' }, token)).status === 201, 'pending invitation consumes second free seat')
  check((await request(`/support/workspaces/${workspaceId}/invitations`, 'POST', { email: 'third@example.test' }, token)).status === 402, 'third free seat refused including pending')
  check((await uploadAttachment('oversize.bin', new Uint8Array(10_000_001), 'oversize')).status === 413, 'free per-file 10MB exact maximum enforced')
  await query('UPDATE support_workspaces SET storage_bytes = 299999999 WHERE id = ?', [workspaceId])
  const storageBoundary = await Promise.all(['a', 'b'].map(id => uploadAttachment(`${id}.txt`, new Uint8Array([65]), `storage-boundary-${id}`)))
  check(storageBoundary.filter(item => item.status === 201).length === 1 && storageBoundary.filter(item => item.status === 402).length === 1, 'concurrent uploads cannot exceed 300000000 free storage bytes')
  await query('UPDATE support_workspaces SET storage_bytes = 13 WHERE id = ?', [workspaceId])
  const removed = await request(`${agent}/attachments/${uploaded.data.attachment.id}`, 'DELETE', undefined, token)
  check(removed.status === 200 && Number((await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspaceId]))?.storage_bytes) === 1, 'verified attachment deletion releases stored byte allowance once')
  await query("UPDATE support_usage SET used = 119 WHERE workspace_id = ? AND meter = 'conversations'", [workspaceId])
  const boundary = await Promise.all(['a', 'b', 'c'].map(id => request(prefix + '/conversations', 'POST', { ...payload, idempotencyKey: `boundary-${id}` }, keys.ingestKey)))
  check(boundary.filter(result => result.status === 201).length === 1 && boundary.filter(result => result.status === 402).length === 2, `120th accepted, 121st refused under concurrent HTTP writes ${boundary.map(r => r.status)}`)
  check(await usage(workspaceId, 'conversations') === 120, 'exact persisted free usage')
  check((await request(`${widget}/conversations/${conversation.id}/messages`, 'POST', { body: 'Existing thread still works', idempotencyKey: 'reply-after-cap' }, session.data.token, 'https://customer.example')).status === 201, 'existing conversations work after cap')
  check((await request(prefix + '/conversations', 'POST', payload, keys.ingestKey)).data.conversation.id === conversation.id, 'retry stays successful after quota cap')
  for (let index = 0; index < 10; index++) {
    const row = await one('INSERT INTO support_conversations (workspace_id, project_id, contact_id, subject, status, unread_count, ai_turns, ai_tokens, ai_charged_period, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?) RETURNING *', [workspaceId, project.id, Number(session.data.contact.id), `AI ${index}`, 'open', '', new Date().toISOString(), new Date().toISOString()])
    await reserveAi(project, row!.id, 100)
  }
  const aiExtra = await one('SELECT id FROM support_conversations WHERE id = ?', [conversation.id])
  let refusedAi = false
  try { await reserveAi(project, aiExtra!.id, 100) }
  catch (error) { refusedAi = (error as { code?: string }).code === 'ai_limit' }
  check(refusedAi && await usage(workspaceId, 'ai') === 10, '11th AI-handled conversation refused exactly')
  const usageResult = await request('/v1/usage', 'GET', undefined, keys.readKey)
  check(usageResult.status === 200 && usageResult.data.some((row: any) => row.meter === 'conversations' && row.used === 120 && row.limit === 100), 'native HQ usage contract exact persisted counters')
  const connectStart = await request('/cli/connect', 'POST', { app: 'Main app' })
  check(connectStart.status === 201 && typeof connectStart.data.confirmCode === 'string' && connectStart.data.approveUrl, `HQ challenge issued ${JSON.stringify(connectStart.data)}`)
  check((await request(`/support/connect/${connectStart.data.code}/approve`, 'POST', { confirmCode: 'WRONG' }, token)).status === 422, 'HQ challenge must be confirmed')
  const approved = await request(`/support/connect/${connectStart.data.code}/approve`, 'POST', { confirmCode: connectStart.data.confirmCode }, token)
  check(approved.status === 200 && approved.data.ok === true, `HQ signed-in approval ${JSON.stringify(approved.data)}`)
  const collected = await request(`/cli/connect/${connectStart.data.code}`)
  check(collected.status === 200 && collected.data.ingestKey && collected.data.readKey, 'HQ keys collected once')
  check((await request(`/cli/connect/${connectStart.data.code}`)).status === 404, 'HQ code single use')
  check(!await one('SELECT id FROM hq_connect_codes WHERE code_hash = ?', [connectStart.data.code]), 'HQ plaintext connect code not persisted')
  console.log(`PASS support HTTP ${checks} checks`)
}
finally {
  await server.stop(true)

}
