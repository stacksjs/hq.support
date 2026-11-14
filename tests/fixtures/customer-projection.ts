import assert from 'node:assert/strict'
import { resolvedDatabaseConfig, sqlDateTime } from '@stacksjs/database/runtime'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { insert, one, query } from '../../app/Support/database'
import { digest } from '../../app/Support/service'
import { Storage } from '@stacksjs/storage'
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
  const publicRead = async () => {
    const list = await request(widget + '/conversations?limit=1', 'GET', undefined, session.data.token, 'https://customer.example')
    const detail = await request(widget + '/conversations/' + conversation.id, 'GET', undefined, session.data.token, 'https://customer.example')
    check(list.status === 200 && detail.status === 200, 'authorized existing widget list/detail')
    check(detail.headers.get('cache-control') === 'no-store' && !detail.headers.has('etag') && !detail.headers.has('last-modified'), 'customer history has no private cache metadata')
    return { list: list.data, detail: detail.data }
  }
  // A future imported public message stays later than the real reply clock, giving all responses a fixed expected instant.
  const nativeCreated = sqlDateTime(new Date('2090-01-01T00:00:00.000Z'))
  check(nativeCreated === '2090-01-01T00:00:00.000', 'native SQL fixture uses canonical zone-less ISO T timestamps')
  const timestampIs = async (expected: string, label: string) => {
    const result = await publicRead()
    assert.equal(result.list.conversations[0].updated_at, expected, label + ' list'); checks++
    assert.equal(result.detail.conversation.updated_at, expected, label + ' detail'); checks++
  }
  await query('UPDATE support_conversations SET created_at = ? WHERE id = ?', [nativeCreated, conversation.id])
  await query('UPDATE support_messages SET created_at = ? WHERE conversation_id = ?', [sqlDateTime(new Date('2090-01-01T01:00:00.000Z')), conversation.id])
  await timestampIs('2090-01-01T01:00:00.000Z', 'later public message beats native UTC creation in every server timezone')
  await query("UPDATE support_messages SET visibility = 'internal' WHERE conversation_id = ?", [conversation.id])
  await timestampIs('2090-01-01T00:00:00.000Z', 'without public messages the UTC creation floor is exact')
  await query("UPDATE support_messages SET visibility = 'public', created_at = ? WHERE conversation_id = ?", [sqlDateTime(new Date('2089-12-31T23:00:00.000Z')), conversation.id])
  await timestampIs('2090-01-01T00:00:00.000Z', 'creation later than public history retains the UTC floor')
  await query('UPDATE support_messages SET created_at = ? WHERE conversation_id = ?', [sqlDateTime(new Date('2090-01-01T01:00:00.000Z')), conversation.id])
  const replyInput = { body: 'Customer timezone regression', idempotencyKey: 'projection-timezone-reply' }
  const customerReply = await request(`${widget}/conversations/${conversation.id}/messages`, 'POST', replyInput, session.data.token, 'https://customer.example')
  check(customerReply.status === 201 && customerReply.data.conversation.updated_at === '2090-01-01T01:00:00.000Z', 'customer mutation summary uses the same UTC public maximum')
  const replyRetry = await request(`${widget}/conversations/${conversation.id}/messages`, 'POST', replyInput, session.data.token, 'https://customer.example')
  assert.deepEqual(replyRetry.data, customerReply.data, 'lost acknowledgement retains the exact UTC mutation summary'); checks++
  await timestampIs('2090-01-01T01:00:00.000Z', 'customer reply and retry preserve the public maximum on reads')
  if (resolvedDatabaseConfig().driver === 'sqlite') {
    await query('UPDATE support_conversations SET created_at = ? WHERE id = ?', ['invalid-import-date', conversation.id])
    for (const path of [`${widget}/conversations`, `${widget}/conversations/${conversation.id}`]) {
      const invalid = await request(path, 'GET', undefined, session.data.token, 'https://customer.example')
      check(invalid.status === 503 && invalid.data.error.code === 'projection_unavailable' && Buffer.byteLength(JSON.stringify(invalid.data), 'utf8') < 1024 && !('nextCursor' in invalid.data) && !('messagesNextCursor' in invalid.data), 'invalid imported creation fails with a bounded generic response and no cursor')
    }
  }
  // Fixed historical values prove that neither wall clock nor imported private updated_at is public activity.
  await query('UPDATE support_conversations SET created_at = ?, updated_at = ? WHERE id = ?', ['2020-01-01 00:00:00', '2035-01-01T00:00:00.000Z', conversation.id])
  await query('UPDATE support_messages SET created_at = ? WHERE conversation_id = ?', ['2020-01-02T01:00:00.000Z', conversation.id])
  const baseline = await publicRead()
  check(baseline.list.conversations[0].updated_at === '2020-01-02T01:00:00.000Z' && baseline.detail.conversation.updated_at === '2020-01-02T01:00:00.000Z', 'customer timestamp derives only from public messages and creation')
  const unchanged = async (label: string) => { assert.deepEqual(await publicRead(), baseline, label); checks++ }
  const note = await request(`${agent}/conversations/${conversation.id}/messages`, 'POST', { body: 'Private account investigation', visibility: 'internal', idempotencyKey: 'projection-note' }, token)
  check(note.status === 201, 'private note accepted'); await unchanged('internal note leaves every customer response field unchanged')
  const agentId = (await request('/support/me', 'GET', undefined, token)).data.user.id
  const assigned = await request(`${agent}/conversations/${conversation.id}`, 'PATCH', { assigneeId: agentId }, token)
  check(assigned.status === 200, 'pure assignment accepted'); await unchanged('assignment leaves public body, timestamp, count and cursor unchanged')
  const read = await request(`${agent}/conversations/${conversation.id}/read`, 'POST', { lastMessageId: baseline.detail.messages[0].id }, token)
  check(read.status === 200, 'native agent read accepted'); await unchanged('agent read state remains private')
  const form = new FormData(); form.set('file', new File(['secret bytes'], 'private-projection.txt', { type: 'text/plain' })); form.set('idempotencyKey', 'projection-file')
  const uploaded = await fetch(base + `${agent}/conversations/${conversation.id}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })
  const file = (await uploaded.json() as any).attachment
  check(uploaded.status === 201, 'private agent file stored'); await unchanged('private file metadata and size cannot change customer projection')
  const failedShare = await request(`${agent}/conversations/${conversation.id}/messages`, 'POST', { body: 'Must roll back', attachmentIds: [file.id, '999999999'], idempotencyKey: 'failed-share' }, token)
  check(failedShare.status === 404, 'invalid public sharing rolls back'); await unchanged('failed public share leaves no message, attachment or timestamp')
  const removed = await request(`${agent}/attachments/${file.id}`, 'DELETE', undefined, token)
  check(removed.status === 200, 'private file deleted'); await unchanged('private deletion leaves customer collection and cursor unchanged')
  // Public timestamp order must be temporal, independent of insertion order and formatting.
  for (const [index, stamp] of ['2020-01-02 23:59:59.999', '2020-01-03T00:59:59.998+01:00', '2020-01-01T23:00:00.000Z'].entries()) {
    await insert('support_messages', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: Number(session.data.contact.id), body: `Historical public ${index}`, visibility: 'public', author_type: 'agent' })
    const latest = (await one('SELECT id FROM support_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conversation.id]))!
    await query('UPDATE support_messages SET created_at = ? WHERE id = ?', [resolvedDatabaseConfig().driver === 'postgres' ? new Date(stamp.includes(' ') ? stamp.replace(' ', 'T') + 'Z' : stamp).toISOString() : stamp, latest.id])
  }
  const temporal = await publicRead()
  check(temporal.list.conversations[0].updated_at === '2020-01-02T23:59:59.999Z' && temporal.detail.conversation.updated_at === '2020-01-02T23:59:59.999Z', 'SQL-space/ISO/offset/day-boundary timestamps normalize before temporal maximum on both drivers')
  if (resolvedDatabaseConfig().driver === 'postgres') {
    check((await one('SELECT created_at FROM support_messages WHERE conversation_id = ? LIMIT 1', [conversation.id]))!.created_at instanceof Date, 'PostgreSQL fixture exercises native Date timestamps')
  }
  const otherSession = await request(prefix + '/sessions', 'POST', { externalId: 'projection-other' }, keys.ingestKey)
  const otherConversation = await insert('support_conversations', { workspace_id: workspaceId, project_id: project.id, contact_id: Number(otherSession.data.contact.id), subject: 'Other contact', status: 'open' })
  await query('UPDATE support_conversations SET continued_from_id = ?, continuation_id = ? WHERE id = ?', [otherConversation.id, otherConversation.id, conversation.id])
  const scopedLineage = await publicRead()
  check(scopedLineage.list.conversations[0].continued_from_id === null && scopedLineage.detail.conversation.continuation_id === null, 'customer lineage never exposes another contact even on imported/corrupt bindings')
  await query('UPDATE support_conversations SET continued_from_id = NULL, continuation_id = NULL WHERE id = ?', [conversation.id])
  await insert('support_messages', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: Number(otherSession.data.contact.id), body: 'Mismatched imported customer public row', visibility: 'public', author_type: 'agent', })
  assert.deepEqual(await publicRead(), temporal, 'mismatched contact messages cannot influence public activity or transcript'); checks++
  const beforeHistory = temporal.detail.messages.map((message: any) => message.id)
  const publicIds: string[] = []
  for (let index = 0; index < 9; index++) {
    const row = await insert('support_messages', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: Number(session.data.contact.id), body: '界'.repeat(20000), visibility: 'public', author_type: 'agent' })
    publicIds.push(String(row.id))
    await insert('support_messages', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: Number(session.data.contact.id), body: 'Hidden interleaved page row', visibility: 'internal', author_type: 'agent' })
  }
  const seen: string[] = []; let messageCursor: string | null = null, pages = 0
  do {
    const result = await request(`${widget}/conversations/${conversation.id}?limit=5${messageCursor ? '&beforeMessage=' + messageCursor : ''}`, 'GET', undefined, session.data.token, 'https://customer.example')
    check(result.status === 200 && Buffer.byteLength(JSON.stringify(result.data), 'utf8') <= 512 * 1024 && result.data.messages.length <= 5, 'whole HTTP envelope and message row count bounded with multibyte content')
    check(Buffer.byteLength(JSON.stringify(result.data.messages), 'utf8') <= 256 * 1024, 'message budget measures UTF-8 rather than JS characters')
    check(result.data.messages.every((message: any) => message.visibility === 'public'), 'private rows never affect transcript page')
    const ids = result.data.messages.map((message: any) => message.id)
    if (result.data.messagesNextCursor) check(result.data.messagesNextCursor === ids[0], 'message cursor is oldest returned whole row, including byte truncation')
    seen.push(...ids); messageCursor = result.data.messagesNextCursor; pages++
  } while (messageCursor && pages < 10)
  check(pages > 2 && !messageCursor && new Set(seen).size === seen.length && [...seen].sort().join() === [...beforeHistory, ...publicIds].sort().join(), 'following byte cursors recovers every public row once without skipping the trimmed row')
  const storedFiles: string[] = []
  for (let index = 0; index < 105; index++) {
    const stored = await insert('support_attachments', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: 0, visibility: 'public', file_name: `public-${index}-` + '界'.repeat(240) + '.txt', mime_type: 'text/plain', bytes: 12, status: 'stored', idempotency_key: `bulk-${index}`, sha256: 'fixture', storage_key: `fixture-${index}`, storage_disk: 'local' })
    storedFiles.push(String(stored.id))
    await insert('support_attachments', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: 0, visibility: 'private', file_name: `private-${index}.txt`, mime_type: 'text/plain', bytes: 999999, status: 'stored', idempotency_key: `hidden-${index}`, sha256: 'fixture', storage_key: `hidden-${index}`, storage_disk: 'local' })
  }
  const filesSeen: string[] = []; let attachmentCursor: string | null = null
  do {
    const result = await request(`${widget}/conversations/${conversation.id}?limit=1${attachmentCursor ? '&beforeAttachment=' + attachmentCursor : ''}`, 'GET', undefined, session.data.token, 'https://customer.example')
    check(result.status === 200 && result.data.attachments.length <= 100 && result.data.attachments.every((file: any) => file.fileName.startsWith('public-')), 'attachment SQL page exposes only bounded public metadata')
    check(Buffer.byteLength(JSON.stringify(result.data.attachments), 'utf8') <= 64 * 1024 && Buffer.byteLength(JSON.stringify(result.data), 'utf8') <= 512 * 1024, 'attachment and exact envelope budgets include Unicode metadata')
    const ids = result.data.attachments.map((file: any) => file.id)
    if (result.data.attachmentsNextCursor) check(result.data.attachmentsNextCursor === ids[0], 'attachment cursor comes only from visible returned files')
    filesSeen.push(...ids); attachmentCursor = result.data.attachmentsNextCursor
  } while (attachmentCursor)
  check(new Set(filesSeen).size === 105 && filesSeen.length === 105 && filesSeen.sort().join() === storedFiles.sort().join(), 'bounded attachment history retrieves all visible rows once across hidden rows')
  const beforePrivateFilePage = await publicRead()
  await insert('support_attachments', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: 0, visibility: 'private', file_name: 'latest-hidden.txt', mime_type: 'text/plain', bytes: 999999, status: 'stored', idempotency_key: 'latest-hidden', sha256: 'fixture', storage_key: 'latest-hidden', storage_disk: 'local' })
  assert.deepEqual(await publicRead(), beforePrivateFilePage, 'private attachment insertion cannot move a byte-truncated visible cursor or total'); checks++
  const ownUpload = await insert('support_attachments', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: Number(session.data.contact.id), visibility: 'private', file_name: 'customer-owned.txt', mime_type: 'text/plain', bytes: 1, status: 'stored', idempotency_key: 'owned-upload', sha256: 'fixture', storage_key: 'owned-upload', storage_disk: 'local' })
  const ownFiles = await request(`${widget}/conversations/${conversation.id}?attachmentLimit=1`, 'GET', undefined, session.data.token, 'https://customer.example')
  check(ownFiles.data.attachments[0].id === String(ownUpload.id), 'same customer own allowed upload remains visible')
  const invalidQueries = ['limit=0', 'limit=501', 'limit=1e2', 'limit=1&limit=2', 'beforeMessage=', 'beforeMessage=01', 'beforeMessage=-1', 'beforeAttachment=0', 'beforeAttachment=1&beforeAttachment=2', 'attachmentLimit=101', 'attachmentLimit=1.1', 'workspaceId=1', 'beforeMessage=9007199254740992']
  for (const queryString of invalidQueries) check((await request(`${widget}/conversations/${conversation.id}?${queryString}`, 'GET', undefined, session.data.token, 'https://customer.example')).status === 422, 'bounded query rejects ' + queryString)
  // Corrupt imported oversized rows fail closed and never advance a cursor past missing content.
  const oversized = await insert('support_messages', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: Number(session.data.contact.id), body: '界'.repeat(100000), visibility: 'public', author_type: 'agent' })
  const unavailable = await request(`${widget}/conversations/${conversation.id}?limit=1`, 'GET', undefined, session.data.token, 'https://customer.example')
  check(unavailable.status === 503 && unavailable.data.error.code === 'projection_unavailable' && !('messagesNextCursor' in unavailable.data), 'single oversized message returns bounded generic failure without cursor')
  await query('DELETE FROM support_messages WHERE id = ?', [oversized.id])
  const overFile = await insert('support_attachments', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: 0, visibility: 'public', file_name: '界'.repeat(30000), mime_type: 'text/plain', bytes: 1, status: 'stored', idempotency_key: 'oversized-metadata', sha256: 'fixture', storage_key: 'oversized-metadata', storage_disk: 'local' })
  check((await request(`${widget}/conversations/${conversation.id}?attachmentLimit=1`, 'GET', undefined, session.data.token, 'https://customer.example')).status === 503, 'single oversized attachment metadata fails without dropping its content')
  await query('DELETE FROM support_attachments WHERE id = ?', [overFile.id])
  const oldName = (await one('SELECT name FROM support_contacts WHERE id = ?', [session.data.contact.id]))!.name
  await query('UPDATE support_contacts SET name = ? WHERE id = ?', ['界'.repeat(180000), session.data.contact.id])
  check((await request(`${widget}/conversations/${conversation.id}?limit=1&attachmentLimit=1`, 'GET', undefined, session.data.token, 'https://customer.example')).status === 503, 'exact final envelope includes contact metadata as well as collection budgets')
  await query('UPDATE support_contacts SET name = ? WHERE id = ?', [oldName, session.data.contact.id])
  const largeConversations: string[] = []
  for (let index = 0; index < 5; index++) {
    const imported = await insert('support_conversations', { workspace_id: workspaceId, project_id: project.id, contact_id: Number(session.data.contact.id), subject: '界'.repeat(20000), status: 'open' })
    largeConversations.push(String(imported.id))
  }
  const summaries: string[] = []; let listCursor: string | null = null
  do {
    const result = await request(`${widget}/conversations?limit=5${listCursor ? '&cursor=' + listCursor : ''}`, 'GET', undefined, session.data.token, 'https://customer.example')
    check(result.status === 200 && Buffer.byteLength(JSON.stringify(result.data.conversations), 'utf8') <= 128 * 1024 && Buffer.byteLength(JSON.stringify(result.data), 'utf8') <= 512 * 1024, 'summary pages enforce UTF-8 whole-row and final envelope budgets')
    const ids = result.data.conversations.map((row: any) => row.id)
    if (result.data.nextCursor) check(result.data.nextCursor === ids[ids.length - 1], 'summary cursor names last emitted row rather than byte-trimmed lookahead')
    summaries.push(...ids); listCursor = result.data.nextCursor
  } while (listCursor)
  check(new Set(summaries).size === 6 && summaries.length === 6 && largeConversations.every(id => summaries.includes(id)), 'every imported summary survives byte pagination once')
  console.log(`PASS customer projection HTTP ${checks} checks`)
}
finally { await server.stop(true) }
