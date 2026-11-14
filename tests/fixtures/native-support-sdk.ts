import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { createSupportClient, SupportError } from '@stacksjs/support/server'
import NativeSessionAction from '@stacksjs/defaults/app/Actions/Support/SessionAction.ts'
import { one, query } from '../../app/Support/database'
import { digest } from '../../app/Support/service'

// This seam exercises the real native client and default authenticated action
// against application HTTP/SQL; it deliberately does not stand in for browser QA.
await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
// Explicit native default action registration keeps this fixture independent of
// whether the consumer's optional support integration was enabled at boot.
route.post('/api/_native/support/session', NativeSessionAction).middleware('auth')
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), origin = `http://127.0.0.1:${server.port}`, base = origin + '/api'
let checks = 0, cookie = '', csrf = ''
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, token?: string, widget = false) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(widget ? { origin: 'https://customer.example.test' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any, headers: response.headers }
}
async function register(email: string) {
  const created = await http('/register', 'POST', { name: 'Native SDK User', email, password: 'NativeSdkSecret2026!', password_confirmation: 'NativeSdkSecret2026!' })
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.data))
  const login = await http('/login', 'POST', { email, password: 'NativeSdkSecret2026!' })
  const token = login.data.access_token ?? login.data.token
  assert.equal(typeof token, 'string')
  return token as string
}
async function rejectsCode(action: () => Promise<unknown>, code: string, status: number) {
  await assert.rejects(action, error => error instanceof SupportError && error.code === code && error.status === status && !error.message.includes('secret'))
  checks++
}
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const nativeToken = await register('native-sdk-owner@example.test')
  const owner = (await one("SELECT * FROM users WHERE email = 'native-sdk-owner@example.test'"))!
  const workspace = (await http('/support/workspaces', 'POST', { name: 'SDK A' }, nativeToken)).data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Native SDK app' }, nativeToken)).data.project
  const agent = `/support/projects/${project.public_id}`, widget = `/widget/projects/${project.public_id}`
  const keys = (await http(`${agent}/keys`, 'POST', {}, nativeToken)).data
  await http(agent, 'PATCH', { allowedOrigins: ['https://customer.example.test'], anonymousEnabled: false }, nativeToken)
  const client = createSupportClient({ url: origin, key: keys.ingestKey, readKey: keys.readKey, project: project.public_id })
  const session = await client.createSession({ externalId: 'sdk:customer-a', email: 'customer@example.test', name: 'SDK Customer', company: { id: 'company:123', name: 'Native Customer Company' }, attributes: { tier: 'growth' } })
  check(typeof session.expiresAt === 'string' && Number.isFinite(Date.parse(session.expiresAt)), 'native server SDK accepts the real ISO session expiry')
  const companyContact = (await one('SELECT company, attributes FROM support_contacts WHERE id = ? AND project_id = ?', [session.contact.id, project.id]))!
  check(companyContact.company === 'Native Customer Company' && JSON.parse(String(companyContact.attributes))._hqSupportCompany.id === 'company:123', 'SDK company label and stable ID survive the actual app boundary')
  await client.createSession({ externalId: 'sdk:customer-a', attributes: { tier: 'updated' } })
  const updatedCompany = JSON.parse(String((await one('SELECT attributes FROM support_contacts WHERE id = ?', [session.contact.id]))!.attributes))
  check(updatedCompany.tier === 'updated' && updatedCompany._hqSupportCompany.id === 'company:123', 'unrelated native profile updates preserve stable company identity')
  await client.createSession({ externalId: 'sdk:customer-a', company: { id: 'company:123' } })
  check((await one('SELECT company FROM support_contacts WHERE id = ?', [session.contact.id]))!.company === 'Native Customer Company', 'an ID-only company update does not erase its known company name')
  const persisted = (await one('SELECT * FROM support_customer_sessions WHERE digest = ?', [digest(session.token)]))!
  check(Number(persisted.expires_at) === Date.parse(session.expiresAt) && persisted.digest !== session.token, 'wire ISO expiry matches hashed native database session')
  const widgetSession = await http(`${widget}/session`, 'POST', { token: session.token, externalId: 'forged-customer' }, undefined, true)
  check(widgetSession.status === 200 && widgetSession.data.contact.id === session.contact.id && widgetSession.data.expiresAt === Number(persisted.expires_at), 'widget session still returns numeric milliseconds and cannot replace identity')
  check((await http(`${widget}/session`, 'POST', { externalId: 'forged-customer' }, undefined, true)).status === 403, 'anonymous-disabled widget cannot mint a submitted customer identity')
  // The native default action calls createAuthenticatedSupportSession itself.
  ;(config.services as unknown as Record<string, unknown>).supporthq = { enabled: true, url: origin, key: keys.ingestKey, readKey: keys.readKey, project: project.public_id, expose: ['email', 'name'] }
  check((await http('/_native/support/session', 'POST', { externalId: 'user:forged' })).status === 401, 'native authenticated bridge refuses anonymous requests')
  ;(config.services as unknown as Record<string, any>).supporthq.enabled = false
  check((await http('/_native/support/session', 'POST', {}, nativeToken)).status === 404, 'disabled consumer integration refuses session provisioning')
  ;(config.services as unknown as Record<string, any>).supporthq.enabled = true
  const identified = await http('/_native/support/session', 'POST', { externalId: 'user:forged', userId: 'another-account', email: 'forged@example.test' }, nativeToken)
  check(identified.status === 200 && typeof identified.data.expiresAt === 'string', 'real native default bridge accepts application session wire format')
  check(identified.headers.get('cache-control') === 'private, no-store' && !JSON.stringify(identified.data).includes(keys.ingestKey), 'native bridge returns no cacheable server credentials')
  const identifiedContact = (await one('SELECT c.* FROM support_contacts c JOIN support_customer_sessions s ON s.contact_id = c.id WHERE s.digest = ?', [digest(identified.data.token)]))!
  check(identifiedContact.external_id === `user:${owner.id}` && identifiedContact.email === owner.email, 'native bridge derives identity and exposed fields from actual authenticated request.user')
  const otherToken = await register('native-sdk-other@example.test'), other = (await one("SELECT id FROM users WHERE email = 'native-sdk-other@example.test'"))!
  const otherIdentified = await http('/_native/support/session', 'POST', { externalId: `user:${owner.id}` }, otherToken)
  const otherContact = (await one('SELECT c.* FROM support_contacts c JOIN support_customer_sessions s ON s.contact_id = c.id WHERE s.digest = ?', [digest(otherIdentified.data.token)]))!
  check(otherIdentified.status === 200 && otherContact.external_id === `user:${other.id}` && otherContact.id !== identifiedContact.id, 'a second real login cannot submit the first native user identity')
  check((await http(`${widget}/session`, 'POST', { token: identified.data.token }, undefined, true)).data.contact.id === String(identifiedContact.id), 'native authenticated bridge token works on the actual widget API')
  const created = await client.conversations.create({ externalId: 'sdk:customer-a', subject: 'SDK conversation', body: 'Original customer question', idempotencyKey: 'sdk-create-1' })
  check((await client.conversations.create({ externalId: 'sdk:customer-a', subject: 'SDK conversation', body: 'Original customer question', idempotencyKey: 'sdk-create-1' })).conversation.id === created.conversation.id, 'native SDK write replay returns the same stored conversation')
  await rejectsCode(() => client.conversations.create({ externalId: 'sdk:customer-a', subject: 'Changed input', body: 'Original customer question', idempotencyKey: 'sdk-create-1' }), 'conflict', 409)
  const publicReply = await client.conversations.reply(created.conversation.id, { body: 'Public agent reply', visibility: 'public', idempotencyKey: 'sdk-public-reply' })
  const privateReply = await client.conversations.reply(created.conversation.id, { body: 'Private internal investigation', visibility: 'internal', idempotencyKey: 'sdk-private-reply' })
  check(publicReply.message.id !== privateReply.message.id, 'native reply validators accept real public and internal message responses')
  const widgetDetail = await http(`${widget}/conversations/${created.conversation.id}`, 'GET', undefined, session.token, true)
  check(widgetDetail.status === 200 && widgetDetail.data.messages.some((message: any) => message.id === publicReply.message.id) && !JSON.stringify(widgetDetail.data).includes('Private internal investigation'), 'widget reads public SDK reply and never internal note text')
  const widgetCreated = await http(`${widget}/conversations`, 'POST', { externalId: 'sdk:someone-else', subject: 'Widget question', body: 'Widget body', idempotencyKey: 'widget-create-sdk-roundtrip' }, session.token, true)
  check(widgetCreated.status === 201 && widgetCreated.data.conversation.customer_id === session.contact.id, 'widget conversation creation binds the server-issued session instead of submitted externalId')
  const widgetReply = await http(`${widget}/conversations/${created.conversation.id}/messages`, 'POST', { body: 'Customer follow-up', idempotencyKey: 'widget-sdk-followup' }, session.token, true)
  check(widgetReply.status === 201 && (await client.conversations.list()).conversations.some(row => row.id === created.conversation.id), 'native summaries see a real widget/customer roundtrip')
  check((await http(`${widget}/conversations/${created.conversation.id}/messages`, 'POST', { body: 'Forged private note', visibility: 'internal', idempotencyKey: 'forged-widget-note' }, session.token, true)).status === 403, 'widget customer cannot create internal notes')
  check((await http(`${widget}/conversations/${created.conversation.id}`, 'GET', undefined, identified.data.token, true)).status === 404, 'native bridge customer cannot read another SDK contact thread')
  const event = { externalId: 'sdk:customer-a', event: 'checkout-viewed', attributes: { route: '/checkout' }, idempotencyKey: 'sdk-event-1' }
  const tracked = await client.track(event)
  check((await client.track(event)).id === tracked.id, 'SDK event idempotency is backed by actual SQL')
  await rejectsCode(() => client.track({ ...event, attributes: { route: '/changed' } }), 'conflict', 409)
  let writeRequests = 0
  const lostAck = createSupportClient({ url: origin, key: keys.ingestKey, project: project.public_id, fetch: async (url, init) => { writeRequests++; const response = await fetch(url, init); await response.body?.cancel(); throw new Error('Simulated acknowledgement loss after actual HTTP commit') } })
  await rejectsCode(() => lostAck.track({ ...event, idempotencyKey: 'sdk-lost-ack' }), 'network', 0)
  check(writeRequests === 1, 'native SDK never automatically retries a committed request with a lost acknowledgement')
  const recovered = await client.track({ ...event, idempotencyKey: 'sdk-lost-ack' })
  check(Boolean(recovered.id) && Number((await one('SELECT COUNT(*) AS count FROM support_events WHERE project_id = ?', [project.id]))!.count) === 2, 'manual same-key recovery does not duplicate the committed event')
  const readOnly = createSupportClient({ url: origin, key: keys.readKey, project: project.public_id })
  check((await readOnly.conversations.list()).conversations.length === 2, 'read key can request bounded summaries')
  const before = await one('SELECT (SELECT COUNT(*) FROM support_messages) AS messages, (SELECT COUNT(*) FROM support_customer_sessions) AS sessions, (SELECT COUNT(*) FROM support_events) AS events')
  await rejectsCode(() => readOnly.createSession({ externalId: 'read-key-customer' }), 'unauthorized', 401)
  await rejectsCode(() => readOnly.track({ ...event, idempotencyKey: 'read-key-event' }), 'unauthorized', 401)
  await rejectsCode(() => readOnly.conversations.create({ externalId: 'read-key-customer', subject: 'Refused', body: 'No write scope', idempotencyKey: 'read-key-conversation' }), 'unauthorized', 401)
  await rejectsCode(() => readOnly.conversations.reply(created.conversation.id, { body: 'No write scope', visibility: 'public', idempotencyKey: 'read-key-message' }), 'unauthorized', 401)
  assert.deepEqual(await one('SELECT (SELECT COUNT(*) FROM support_messages) AS messages, (SELECT COUNT(*) FROM support_customer_sessions) AS sessions, (SELECT COUNT(*) FROM support_events) AS events'), before)
  checks++
  for (const [index, status] of ['open', 'closed', 'open', 'snoozed', 'closed', 'open'].entries()) {
    const row = await client.conversations.create({ externalId: 'sdk:customer-a', subject: `Filtered ${index}`, body: `Source ${index}`, idempotencyKey: `filtered-${index}` })
    if (status !== 'open') { const updated = await http(`${agent}/conversations/${row.conversation.id}`, 'PATCH', { status }, nativeToken);  assert.equal(updated.status, 200, JSON.stringify(updated.data)) }
  }
  check((await http(`${agent}/conversations/${created.conversation.id}`, 'PATCH', { assigneeId: -1 }, nativeToken)).status === 422, 'invalid assignee is validated instead of using a truthy PostgreSQL string sentinel')
  const first = await readOnly.conversations.list({ status: 'open', limit: 2 })
  check(first.conversations.length === 2 && first.conversations.every(row => row.status === 'open') && first.nextCursor === first.conversations[1]!.id, 'SDK limit/status parameters affect the actual keyset query')
  const next = await readOnly.conversations.list({ status: 'open', limit: 2, cursor: first.nextCursor! })
  check(next.conversations.length === 2 && !next.conversations.some(row => first.conversations.some(previous => previous.id === row.id)) && next.nextCursor !== null, 'filtered cursor pages contain no duplicate rows')
  const final = await readOnly.conversations.list({ status: 'open', limit: 2, cursor: next.nextCursor! })
  check(final.conversations.length === 1 && final.nextCursor === null, 'last filtered page reports no next cursor')
  check((await readOnly.conversations.list({ status: 'closed', limit: 1 })).conversations.every(row => row.status === 'closed'), 'actual closed state is supported')
  check((await readOnly.conversations.list({ status: 'snoozed', limit: 100 })).conversations.length === 1, 'actual snoozed state and maximum bounded page are supported')
  const summaries = JSON.stringify(await readOnly.conversations.list())
  check(!summaries.includes('Original customer question') && !summaries.includes('customer@example.test') && !summaries.includes('Private internal investigation'), 'read-key summaries contain no transcripts, note text or customer email')
  for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=1e2', 'limit=', 'limit=nope', 'status=resolved', 'status=', 'cursor=nope', 'limit=1&limit=2']) check((await http(`/v1/projects/${project.public_id}/conversations?${query}`, 'GET', undefined, keys.readKey)).status === 422, `invalid query rejected: ${query}`)
  await rejectsCode(() => readOnly.conversations.list({ status: 'resolved' }), 'validation', 422)
  const widgetFiltered = await http(`${widget}/conversations?status=closed&limit=1`, 'GET', undefined, session.token, true)
  check(widgetFiltered.status === 200 && widgetFiltered.data.conversations.length === 1 && widgetFiltered.data.conversations[0].status === 'closed', 'widget uses the same bounded validated query while retaining contact scope')
  check((await http(`${widget}/conversations?limit=100`, 'GET', undefined, identified.data.token, true)).data.conversations.length === 0, 'another authenticated native customer sees no foreign contacts despite a large limit')
  const workspaceB = (await http('/support/workspaces', 'POST', { name: 'SDK B' }, nativeToken)).data.workspace
  const projectB = (await http(`/support/workspaces/${workspaceB.id}/projects`, 'POST', { name: 'Different tenant' }, nativeToken)).data.project
  const wrongProject = createSupportClient({ url: origin, key: keys.ingestKey, readKey: keys.readKey, project: projectB.public_id })
  await rejectsCode(() => wrongProject.conversations.list(), 'unauthorized', 401)
  await rejectsCode(() => wrongProject.createSession({ externalId: 'sdk:customer-a' }), 'unauthorized', 401)
  check(Number((await one('SELECT COUNT(*) AS count FROM support_contacts WHERE project_id = ?', [projectB.id]))!.count) === 0, 'project keys never create contacts across tenant boundaries')
  await query('UPDATE support_api_keys SET revoked_at = ? WHERE project_id = ? AND digest = ?', [Date.now(), project.id, digest(keys.ingestKey)])
  check((await http('/_native/support/session', 'POST', {}, nativeToken)).status === 503, 'native bridge reports upstream authorization failure instead of a fabricated session')
  console.log(`PASS native support SDK HTTP (${checks} checks)`)
}
finally { server.stop(true) }
