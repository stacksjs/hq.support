import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { overridesReady, config } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { authCookie } from '@stacksjs/auth/cookie'
import { launch, navigate, closeSharedBrowsers } from '@stacksjs/testing/browser'
import { digest } from '../../app/Support/service'
import { query } from '../../app/Support/database'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports(); await route.importRoutes()
const api = await route.serve({ port: 0, hostname: '127.0.0.1' }), apiOrigin = `http://127.0.0.1:${api.port}`
const host = () => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('<!doctype html><title>Owned plain customer host</title>', { headers: { 'content-type': 'text/html' } }) })
const allowedHost = host(), deniedHost = host(), origin = allowedHost.url.origin
let browser: Awaited<ReturnType<typeof launch>> | undefined
let csrf = '', cookie = ''
const proof: unknown[] = []
async function http(path: string, method = 'POST', body: unknown = {}, token?: string, requestOrigin?: string, extra: Record<string, string> = {}) {
  const response = await fetch(apiOrigin + '/api' + path, { method, headers: { accept: 'application/json', 'content-type': 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(requestOrigin ? { origin: requestOrigin } : {}), ...extra }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any, headers: response.headers }
}
try {
  const seed = await fetch(apiOrigin + '/api/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const password = 'CustomerCorsFixture2026!', email = 'cors-owner@example.test'
  assert.equal((await http('/register', 'POST', { name: 'CORS Owner', email, password, password_confirmation: password })).status, 200)
  const login = (await http('/login', 'POST', { email, password })).data, agentToken = login.access_token ?? login.token
  const workspace = (await http('/support/workspaces', 'POST', { name: 'CORS Workspace' }, agentToken)).data.workspace
  const createProject = async (name: string) => (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name }, agentToken)).data.project
  const project = await createProject('Allowed project'), sibling = await createProject('Other project')
  const agent = `/support/projects/${project.public_id}`, widget = `/widget/projects/${project.public_id}`, server = `/v1/projects/${project.public_id}`
  assert.equal((await http(agent, 'PATCH', { allowedOrigins: [origin] }, agentToken)).status, 200)
  const keys = (await http(agent + '/keys', 'POST', {}, agentToken)).data
  const session = async (id: string) => (await http(server + '/sessions', 'POST', { externalId: id }, keys.ingestKey)).data.token as string
  const valid = await session('valid'), revoked = await session('revoked'), expired = await session('expired')
  await query('DELETE FROM support_customer_sessions WHERE digest = ?', [digest(revoked)])
  await query('UPDATE support_customer_sessions SET expires_at = ? WHERE digest = ?', [Date.now() - 1, digest(expired)])
  const siblingKeys = (await http(`/support/projects/${sibling.public_id}/keys`, 'POST', {}, agentToken)).data
  const mismatch = (await http(`/v1/projects/${sibling.public_id}/sessions`, 'POST', { externalId: 'sibling' }, siblingKeys.ingestKey)).data.token
  const otherWorkspace = (await http('/support/workspaces', 'POST', { name: 'Other CORS workspace' }, agentToken)).data.workspace
  const otherProject = (await http(`/support/workspaces/${otherWorkspace.id}/projects`, 'POST', { name: 'Other tenant' }, agentToken)).data.project
  const otherKeys = (await http(`/support/projects/${otherProject.public_id}/keys`, 'POST', {}, agentToken)).data
  const otherTenant = (await http(`/v1/projects/${otherProject.public_id}/sessions`, 'POST', { externalId: 'other-tenant' }, otherKeys.ingestKey)).data.token
  const conversation = (await http(server + '/conversations', 'POST', { externalId: 'valid', subject: 'Public fixture', body: 'Public body', idempotencyKey: 'cors-create' }, keys.ingestKey)).data.conversation
  const snapshot = await http(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, valid, origin)
  assert.equal(snapshot.status, 200)
  const checkpoint = snapshot.data.checkpoint
  const cases = [['invalid', 'not-a-session'], ['revoked', revoked], ['expired', expired], ['scope-mismatched', mismatch], ['workspace-mismatched', otherTenant], ['integration-key', keys.ingestKey], ['read-key', keys.readKey], ['agent-bearer', agentToken]] as const
  // Read-only diagnostic before assertions: wire status and browser outcome expose the pre-fix discrepancy.
  for (const [name, body, token, extra] of [['revoked', {}, revoked, {}], ['malformed', '{', valid, {}], ['override', {}, valid, { 'x-contact-id': '123' }]] as const) {
    const diagnostic = await http(widget + '/realtime/snapshot', 'POST', body, token, origin, extra)
    proof.push({ case: name + '-wire', status: diagnostic.status, allowOrigin: diagnostic.headers.get('access-control-allow-origin'), allowCredentials: diagnostic.headers.get('access-control-allow-credentials') })
  }
  if (process.env.SUPPORT_AUTH_CORS_BROWSER === '1') {
    browser = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH, startTimeoutMs: 60000, commandTimeoutMs: 20000 })
    await navigate(browser.cdp, origin, { quietMs: 50, timeoutMs: 20000 })
    const fetchFromBrowser = (path: string, token: string, body = '{}', extra: Record<string, string> = {}) => browser!.cdp.evaluate(`(async()=>{try { const r=await fetch(${JSON.stringify(apiOrigin + '/api' + path)},{method:'POST',credentials:'omit',headers:{'content-type':'application/json',authorization:${JSON.stringify('Bearer ' + token)},...${JSON.stringify(extra)}},body:${JSON.stringify(body)}});return {status:r.status,body:await r.json()}}catch(error){return {error:error.name}}})()`)
    const before = await fetchFromBrowser(widget + '/realtime/snapshot', revoked)
    proof.push({ case: 'revoked-browser', result: before })
    console.log('AUTH CORS PROOF', JSON.stringify(proof))
    assert.equal((before as any).status, 401, 'registered website can read revoked authority instead of opaque transport failure')
    for (const operation of ['snapshot', 'replay', 'stream']) for (const [name, token] of cases) assert.equal((await fetchFromBrowser(widget + '/realtime/' + operation, token) as any).status, 401, name + ' authority status readable in Chrome on ' + operation)
    assert.equal((await fetchFromBrowser(widget + '/realtime/snapshot', valid, '{') as any).status, 400)
    const visibleSnapshot = await fetchFromBrowser(widget + '/realtime/snapshot', valid) as any
    assert.equal(visibleSnapshot.status, 200)
    const streamStatus = await browser.cdp.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(apiOrigin + '/api' + widget + '/realtime/stream')},{method:'POST',credentials:'omit',headers:{'content-type':'application/json',authorization:${JSON.stringify('Bearer ' + valid)}},body:${JSON.stringify(JSON.stringify({ checkpoint }))}});await r.body.cancel();return {status:r.status,type:r.headers.get('content-type')}})()`) as any
    assert.equal(streamStatus.status, 200); assert.ok(streamStatus.type.includes('text/event-stream'))
    assert.equal((await fetchFromBrowser(widget + '/realtime/snapshot', valid, '{}', { 'x-contact-id': '123' }) as any).error, 'TypeError', 'unsupported header is rejected by preflight')
    await navigate(browser.cdp, deniedHost.url.origin, { quietMs: 50, timeoutMs: 20000 })
    assert.equal((await fetchFromBrowser(widget + '/realtime/snapshot', valid) as any).error, 'TypeError', 'unregistered website cannot read customer response')
  }
  console.log('AUTH CORS PROOF', JSON.stringify(proof))
  for (const operation of ['snapshot', 'replay', 'stream']) for (const [name, token] of cases) {
    const result = await http(widget + '/realtime/' + operation, 'POST', operation === 'snapshot' ? {} : { checkpoint }, token, origin)
    assert.equal(result.status, 401, name + ' denied on ' + operation)
    assert.equal(result.headers.get('access-control-allow-origin'), origin, name + ' error readable only to registered Origin')
    assert.equal(result.headers.get('access-control-allow-credentials'), null)
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.ok(Object.keys(result.data).every(key => ['error', 'request_id'].includes(key)))
    assert.ok(!JSON.stringify(result.data).includes('Public body'))
  }
  for (const badOrigin of [deniedHost.url.origin, 'null', '*', origin + '/path', origin + '.evil']) {
    const result = await http(widget + '/realtime/snapshot', 'POST', {}, valid, badOrigin)
    assert.equal(result.status, 403); assert.equal(result.headers.get('access-control-allow-origin'), null)
    assert.ok(Object.keys(result.data).every(key => ['error', 'request_id'].includes(key)))
  }
  const otherCustomer = await session('other-customer')
  const privateDetail = await http(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, otherCustomer, origin)
  assert.equal(privateDetail.status, 404); assert.equal(privateDetail.headers.get('access-control-allow-origin'), origin)
  assert.ok(!JSON.stringify(privateDetail.data).includes('Public body'))
  const normalDenied = await http(widget + '/conversations', 'GET', undefined, valid, deniedHost.url.origin)
  assert.equal(normalDenied.status, 403); assert.equal(normalDenied.headers.get('access-control-allow-origin'), null)
  const normalExpired = await http(widget + '/conversations', 'GET', undefined, expired, origin)
  assert.equal(normalExpired.status, 401); assert.equal(normalExpired.headers.get('access-control-allow-origin'), origin)
  const malformed = await http(widget + '/realtime/snapshot', 'POST', '{', valid, origin)
  assert.equal(malformed.status, 400); assert.equal(malformed.headers.get('access-control-allow-origin'), origin)
  const denied = await http(widget + '/realtime/snapshot', 'POST', {}, valid, origin, { 'x-contact-id': '123' })
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('access-control-allow-origin'), origin)
  const unknown = await http('/widget/projects/unknown/realtime/snapshot', 'POST', {}, valid, origin)
  assert.equal(unknown.headers.get('access-control-allow-origin'), null)
  // Agent boundary is cookie + native CSRF only; never obtains customer CORS.
  const cookieHeaders = { cookie: cookie + '; ' + authCookie(agentToken).split(';')[0], 'x-csrf-token': csrf }
  const operator = await http(agent + '/realtime/snapshot', 'POST', {}, undefined, 'https://operator.example', cookieHeaders)
  assert.equal(operator.status, 200); assert.equal(operator.headers.get('access-control-allow-origin'), null)
  const noCsrf = await http(agent + '/realtime/snapshot', 'POST', {}, undefined, 'https://operator.example', { ...cookieHeaders, 'x-csrf-token': '' })
  assert.equal(noCsrf.status, 403); assert.equal(noCsrf.headers.get('access-control-allow-origin'), null)
  const agentBearer = await http(agent + '/realtime/snapshot', 'POST', {}, agentToken, 'https://operator.example')
  assert.equal(agentBearer.status, 401); assert.equal(agentBearer.headers.get('access-control-allow-origin'), null)
  const note = await http(agent + '/conversations/' + conversation.id + '/messages', 'POST', { visibility: 'internal', body: 'Private fixture note', idempotencyKey: 'cors-note' }, agentToken)
  assert.equal(note.status, 201)
  const replay = await http(widget + '/realtime/replay', 'POST', { checkpoint }, valid, origin)
  assert.equal(replay.status, 200); assert.equal(replay.data.messages.length, 0)
  assert.equal(replay.data.cursor.seq, checkpoint.seq)
  const abort = new AbortController()
  const stream = await fetch(apiOrigin + '/api' + widget + '/realtime/stream', { method: 'POST', signal: abort.signal, headers: { origin, authorization: 'Bearer ' + valid, 'content-type': 'application/json' }, body: JSON.stringify({ checkpoint }) })
  assert.equal(stream.status, 200); assert.equal(stream.headers.get('access-control-allow-origin'), origin); assert.ok(stream.headers.get('content-type')?.includes('text/event-stream'))
  await stream.body?.cancel(); abort.abort()
  await http(agent, 'PATCH', { allowedOrigins: [] }, agentToken)
  const removed = await http(widget + '/realtime/snapshot', 'POST', {}, revoked, origin)
  assert.equal(removed.status, 403); assert.equal(removed.headers.get('access-control-allow-origin'), null)
  await query('UPDATE support_projects SET allowed_origins = ? WHERE id = ?', [JSON.stringify(['*', 'null', origin + '/path']), project.id])
  const unsafePolicy = await http(widget + '/realtime/snapshot', 'POST', {}, valid, 'null')
  assert.equal(unsafePolicy.status, 403); assert.equal(unsafePolicy.headers.get('access-control-allow-origin'), null)
  const discarded = await createProject('Deleted project')
  await http(`/support/projects/${discarded.public_id}`, 'PATCH', { allowedOrigins: [origin] }, agentToken)
  await query('DELETE FROM support_projects WHERE id = ?', [discarded.id])
  const deleted = await http(`/widget/projects/${discarded.public_id}/realtime/snapshot`, 'POST', {}, valid, origin)
  assert.equal(deleted.headers.get('access-control-allow-origin'), null)
  console.log('PASS customer authority CORS')
}
finally { await browser?.close(); await closeSharedBrowsers(); await api.stop(true); await allowedHost.stop(true); await deniedHost.stop(true) }
