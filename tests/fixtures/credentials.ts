import assert from 'node:assert/strict'
import { startBrowserSession, browserSessionCookie } from '@stacksjs/auth'
import { Action } from '@stacksjs/actions/runtime'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { handleCredentialRequest } from '../../app/Actions/Support/CredentialAction'
import { one, query, insert } from '../../app/Support/database'
import { agentProject, digest, object } from '../../app/Support/service'
import { rotateProjectKey } from '../../app/Support/credentials'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
config.email.default = 'capture'
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const lostEntered = Promise.withResolvers<void>(), lostRelease = Promise.withResolvers<void>(), roleEntered = Promise.withResolvers<void>(), roleRelease = Promise.withResolvers<void>()
route.post('/api/_credentials/projects/{project}/keys/{key}/lost-response', new Action({ name: 'Fixture response boundary after credential commit', method: 'POST', apiResponse: false, async handle(request) {
  const response = await handleCredentialRequest(request, 'rotate')
  lostEntered.resolve(); await lostRelease.promise
  return response
} })).middleware('auth')
route.post('/api/_credentials/projects/{project}/keys/{key}/role-race', new Action({ name: 'Fixture admin role changes before workspace mutation', method: 'POST', apiResponse: false, async handle(request) {
  const account = await request.user(), project = await agentProject(Number(account!.id), request.getParam('project'), ['owner', 'admin'])
  roleEntered.resolve(); await roleRelease.promise
  try { return Response.json(await rotateProjectKey(project, request.getParam('key'), Number(account!.id), { idempotencyKey: request.get('idempotencyKey') })) }
  catch (error) { return Response.json({ refused: true }, { status: Number(object(error).status || 503) }) }
} })).middleware('auth')
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
let checks = 0, csrf = '', cookie = ''
const secrets: string[] = []
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, bearer?: string, extra: RequestInit = {}) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(extra.headers || {}) }, ...(body ? { body: JSON.stringify(body) } : {}), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) })
  return { status: response.status, data: await response.json() as any, headers: response.headers }
}
async function account(email: string) {
  check((await http('/register', 'POST', { name: 'Key Owner', email, password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })).status < 300, 'native account registers')
  const login = await http('/login', 'POST', { email, password: 'SecureSupport2026!' })
  const user = (await one('SELECT id FROM users WHERE email = ?', [email]))!
  return { id: Number(user.id), token: login.data.access_token ?? login.data.token }
}
function remember(result: any) { for (const name of ['ingestKey', 'readKey', 'secret']) if (result[name]) secrets.push(String(result[name])); return result }
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const owner = await account('key-owner@example.test'), outsider = await account('key-outsider@example.test'), agent = await account('key-agent@example.test'), admin = await account('key-admin@example.test')
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Keys' }, owner.token)).data.workspace
  const foreign = (await http('/support/workspaces', 'POST', { name: 'Other Keys' }, outsider.token)).data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Lifecycle app' }, owner.token)).data.project
  const other = (await http(`/support/workspaces/${foreign.id}/projects`, 'POST', { name: 'Foreign app' }, outsider.token)).data.project
  for (const [user, role] of [[agent, 'agent'], [admin, 'admin']] as const) await insert('support_memberships', { workspace_id: workspace.id, user_id: user.id, email: role + '@example.test', role, status: 'active' })
  const path = `/support/projects/${project.public_id}`, sdk = `/v1/projects/${project.public_id}`, widget = `/widget/projects/${project.public_id}`
  const pair = remember((await http(path + '/keys', 'POST', { idempotencyKey: 'pair-one' }, owner.token)).data)
  check(pair.revealed && pair.issuedKeys.length === 2 && pair.ingestKey !== pair.readKey, 'key pair is issued once with explicit scoped metadata')
  check((await http(path + '/keys', 'POST', {}, agent.token)).status === 403, 'agent cannot issue keys')
  check((await http(path + '/keys', 'GET', undefined, outsider.token)).status === 403, 'foreign user cannot list credential metadata')
  check((await http(path + '/keys', 'GET', undefined, pair.readKey)).status === 401, 'project read key is not native admin authentication')
  check((await http(path + '/keys', 'GET', undefined, agent.token)).status === 403, 'agent cannot list credentials')
  const listed = await http(path + '/keys', 'GET', undefined, owner.token)
  check(listed.status === 200 && listed.data.keys.length === 2 && !JSON.stringify(listed.data).includes('digest') && secrets.every(secret => !JSON.stringify(listed.data).includes(secret)), 'list exposes only safe metadata and no digest/raw credential')
  const replay = await http(path + '/keys', 'POST', { idempotencyKey: 'pair-one' }, owner.token)
  check(!replay.data.ingestKey && !replay.data.readKey && !replay.data.revealed && replay.data.replayed && (await query('SELECT id FROM support_api_keys WHERE project_id = ?', [project.id])).length === 2, 'pair creation retry returns metadata without plaintext replay or new keys')
  const writeId = pair.issuedKeys.find((key: any) => key.scope === 'write').id, readId = pair.issuedKeys.find((key: any) => key.scope === 'read').id
  check((await http(path + `/keys/${writeId}/rotate`, 'POST', { idempotencyKey: 'agent' }, agent.token)).status === 403, 'agent cannot rotate a key')
  check((await http(path + `/keys/${writeId}/revoke`, 'POST', {}, agent.token)).status === 403 && (await http(path + `/keys/${writeId}/revoke`, 'POST', {}, pair.readKey)).status === 401, 'agent and project read key cannot revoke administrative credentials')
  check((await http(`/support/projects/${other.public_id}/keys/${writeId}/revoke`, 'POST', {}, outsider.token)).status === 404, 'forged key ID from another project cannot be revoked')
  check((await http(path + `/keys/${readId}/rotate`, 'POST', { idempotencyKey: 'scope-escalation', scope: 'write' }, owner.token)).status === 422, 'rotation cannot silently upgrade a read scope')
  check((await http(path + `/keys/${writeId}/rotate`, 'POST', {}, owner.token)).status === 422, 'rotation requires a stable client operation ID')
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => http(path + `/keys/${writeId}/rotate`, 'POST', { idempotencyKey: 'rotate-write-once' }, admin.token)))
  const first = remember(concurrent.find(result => result.data.revealed)?.data || {})
  check(concurrent.every(result => result.status === 200) && concurrent.filter(result => result.data.secret).length === 1 && concurrent.filter(result => result.data.replayed).length === 7, 'concurrent same-operation rotations have one effect and one secret-bearing response')
  check((await query('SELECT id FROM support_api_keys WHERE project_id = ?', [project.id])).length === 3 && (await query("SELECT id FROM support_outbox WHERE project_id = ? AND kind = 'api_key.rotated'", [project.id])).length === 1, 'rotation commits one replacement and one metadata-only audit intent')
  check((await http(sdk + '/sessions', 'POST', { externalId: 'blocked-old-key' }, pair.ingestKey)).status === 401, 'revoked write key cannot authenticate a new request')
  check((await http(sdk + '/sessions', 'POST', { externalId: 'customer-one' }, first.secret)).status === 200, 'replacement write key is immediately usable')
  check((await http(path + `/keys/${writeId}/rotate`, 'POST', { idempotencyKey: 'different-operation' }, owner.token)).status === 409, 'fresh operation cannot mint another replacement from a revoked original')
  const readRotation = remember((await http(path + `/keys/${readId}/rotate`, 'POST', { idempotencyKey: 'rotate-read' }, owner.token)).data)
  check(readRotation.key.scope === 'read' && (await http(sdk + '/sessions', 'POST', { externalId: 'read-cannot-write' }, readRotation.secret)).status === 401, 'read replacement retains read-only authority')
  check((await http('/v1/usage', 'GET', undefined, pair.readKey)).status === 401 && (await http('/v1/usage', 'GET', undefined, readRotation.secret)).status === 200, 'native HQ read principal observes revocation on every new request')
  const cookieLogin = await http('/login', 'POST', { email: 'key-owner@example.test', password: 'SecureSupport2026!' })
  const browser = await startBrowserSession(cookieLogin.data.access_token ?? cookieLogin.data.token)
  check(browser, 'native browser session is created from a fresh sign-in credential')
  const browserCookie = browserSessionCookie(browser!).split(';')[0]!
  const noCsrf = await fetch(base + path + `/keys/${readRotation.key.id}/revoke`, { method: 'POST', headers: { accept: 'application/json', cookie: `${cookie}; ${browserCookie}`, 'content-type': 'application/json' }, body: '{}' })
  check(noCsrf.status === 403 && !Number((await one('SELECT revoked_at FROM support_api_keys WHERE id = ?', [readRotation.key.id]))?.revoked_at), 'native browser authentication cannot mutate without matching CSRF header')
  const csrfRevoke = await http(path + `/keys/${readRotation.key.id}/revoke`, 'POST', {}, undefined, { headers: { cookie: `${cookie}; ${browserCookie}` } })
  check(csrfRevoke.status === 200 && csrfRevoke.data.key.status === 'revoked', 'native browser cookie plus CSRF can revoke without bearer authentication')
  const revoked = await http(path + `/keys/${readRotation.key.id}/revoke`, 'POST', {}, owner.token)
  const revokedAgain = await http(path + `/keys/${readRotation.key.id}/revoke`, 'POST', {}, owner.token)
  check(revoked.data.key.status === 'revoked' && revokedAgain.data.key.revokedAt === revoked.data.key.revokedAt, 'repeated revoke is idempotent and keeps the original timestamp')
  const controller = new AbortController()
  const lost = http(`/_credentials/projects/${project.public_id}/keys/${first.key.id}/lost-response`, 'POST', { idempotencyKey: 'lost-response' }, owner.token, { signal: controller.signal }).catch(error => error)
  await lostEntered.promise; controller.abort(); await lost; lostRelease.resolve()
  const recovered = await http(path + `/keys/${first.key.id}/rotate`, 'POST', { idempotencyKey: 'lost-response' }, owner.token)
  check(recovered.status === 200 && recovered.data.replayed && !recovered.data.secret && !recovered.data.revealed && recovered.data.key.status === 'active', 'lost committed response retries only replacement metadata, never raw secret or a second rotation')
  const explicitRecovery = remember((await http(path + `/keys/${recovered.data.key.id}/rotate`, 'POST', { idempotencyKey: 'explicit-recovery' }, owner.token)).data)
  check(explicitRecovery.revealed && explicitRecovery.key.scope === 'write', 'explicit rotation of the active lost replacement recovers usable access')
  const originalReplay = await http(path + `/keys/${first.key.id}/rotate`, 'POST', { idempotencyKey: 'lost-response' }, owner.token)
  check(originalReplay.data.key.status === 'revoked' && !originalReplay.data.secret, 'old operation retry reports live replacement status after later rotation')
  const roleRequest = http(`/_credentials/projects/${project.public_id}/keys/${explicitRecovery.key.id}/role-race`, 'POST', { idempotencyKey: 'role-race' }, admin.token)
  await roleEntered.promise; await query("UPDATE support_memberships SET role = 'agent' WHERE workspace_id = ? AND user_id = ?", [workspace.id, admin.id]); roleRelease.resolve()
  check((await roleRequest).status === 403 && !Number((await one('SELECT revoked_at FROM support_api_keys WHERE id = ?', [explicitRecovery.key.id]))?.revoked_at), 'mutation reauthorizes native admin membership after earlier authority was revoked')
  const customerOne = (await http(sdk + '/sessions', 'POST', { externalId: 'customer-one' }, explicitRecovery.secret)).data
  const customerTwo = (await http(sdk + '/sessions', 'POST', { externalId: 'customer-two' }, explicitRecovery.secret)).data
  secrets.push(customerOne.token, customerTwo.token)
  const foreignPair = remember((await http(`/support/projects/${other.public_id}/keys`, 'POST', { idempotencyKey: 'foreign-keys' }, outsider.token)).data)
  const foreignCustomer = (await http(`/v1/projects/${other.public_id}/sessions`, 'POST', { externalId: 'foreign' }, foreignPair.ingestKey)).data
  secrets.push(foreignCustomer.token)
  await query('UPDATE support_projects SET allowed_origins = ? WHERE id IN (?, ?)', [JSON.stringify(['https://customer.example.test']), project.id, other.id])
  const customerRequest = (route: string, method = 'GET', body?: unknown, token = customerOne.token, origin = 'https://customer.example.test') => http(route, method, body, token, { headers: { origin } })
  check((await customerRequest(widget + '/conversations')).status === 200, 'customer credential authenticates its own project before logout')
  check((await customerRequest(widget + '/session/revoke', 'POST', { contactId: customerTwo.contact.id }, customerOne.token, 'https://evil.example.test')).status === 403, 'cross-origin logout cannot mutate customer sessions')
  check((await customerRequest(widget + '/session/revoke', 'POST', { token: customerTwo.token }, foreignCustomer.token)).status === 401, 'another project credential cannot revoke this project sessions')
  const logout = await customerRequest(widget + '/session/revoke', 'POST', { token: customerTwo.token, contactId: customerTwo.contact.id })
  check(logout.status === 200 && logout.data.revoked && (await customerRequest(widget + '/conversations')).status === 401, 'explicit logout revokes only the presented bearer credential; later polls fail')
  check((await customerRequest(widget + '/conversations', 'GET', undefined, customerTwo.token)).status === 200, 'caller-supplied other identity does not revoke another customer')
  check((await customerRequest(widget + '/session/revoke', 'POST', {})).status === 200, 'repeated self-logout is harmless even after expiry')
  const renewed = (await http(sdk + '/sessions', 'POST', { externalId: 'customer-one' }, explicitRecovery.secret)).data; secrets.push(renewed.token)
  check((await http(path + `/customers/${customerOne.contact.id}/sessions/revoke`, 'POST', {}, agent.token)).status === 403, 'agent cannot revoke customer sessions')
  check((await http(`/support/projects/${other.public_id}/customers/${customerOne.contact.id}/sessions/revoke`, 'POST', {}, outsider.token)).status === 404, 'forged contact cannot cross the project session perimeter')
  const revokeAll = await http(path + `/customers/${customerOne.contact.id}/sessions/revoke`, 'POST', {}, owner.token)
  check(revokeAll.status === 200 && revokeAll.data.revoked >= 1 && (await customerRequest(widget + '/conversations', 'GET', undefined, renewed.token)).status === 401, 'admin session revocation expires all current credentials for exactly this contact')
  check((await customerRequest(widget + '/conversations', 'GET', undefined, customerTwo.token)).status === 200, 'admin customer revocation preserves another contact session')
  const competingPair = remember((await http(path + '/keys', 'POST', { idempotencyKey: 'competing-pair' }, owner.token)).data)
  const competingId = competingPair.issuedKeys.find((key: any) => key.scope === 'write').id
  const competing = await Promise.all(['competing-a', 'competing-b'].map(idempotencyKey => http(path + `/keys/${competingId}/rotate`, 'POST', { idempotencyKey }, owner.token)))
  competing.forEach(result => remember(result.data))
  check(competing.filter(result => result.status === 200 && result.data.revealed).length === 1 && competing.filter(result => result.status === 409).length === 1, 'different concurrent operation IDs cannot both replace one key')
  check((await http(path + `/keys/${first.key.id}/rotate`, 'POST', { idempotencyKey: 'rotate-write-once' }, admin.token)).status === 403, 'demoted actor cannot replay previously authorized secret metadata')
  const challenge = (await http('/cli/connect', 'POST', { app: 'Lifecycle app' })).data
  check((await http(`/support/connect/${challenge.code}/approve`, 'POST', { confirmCode: challenge.confirmCode, workspaceId: workspace.id }, owner.token)).status === 200, 'native Buddy grant approval remains unchanged')
  const grant = (await one('SELECT sealed_grant FROM hq_connect_codes ORDER BY id DESC LIMIT 1'))!
  const lateKeys = (await http(path + '/keys', 'GET', undefined, owner.token)).data.keys.filter((key: any) => key.status === 'active' && key.id !== String(explicitRecovery.key.id))
  for (const key of lateKeys) await http(path + `/keys/${key.id}/revoke`, 'POST', {}, owner.token)
  const collected = remember((await http(`/cli/connect/${challenge.code}`)).data)
  check(collected.ingestKey && collected.readKey && !String(grant.sealed_grant).includes(collected.ingestKey) && !String(grant.sealed_grant).includes(collected.readKey), 'native encrypted one-use grant never stores plaintext')
  check((await http(sdk + '/sessions', 'POST', { externalId: 'late-grant' }, collected.ingestKey)).status === 401 && (await http('/v1/usage', 'GET', undefined, collected.readKey)).status === 401, 'late native grant collection cannot revive keys revoked before polling')
  check((await http(`/cli/connect/${challenge.code}`)).status === 404, 'native grant remains one-use')
  check((await http(`/v1/projects/${other.public_id}/sessions`, 'POST', { externalId: 'foreign-after-revocation' }, foreignPair.ingestKey)).status === 200 && (await http('/support/me', 'GET', undefined, owner.token)).status === 200, 'project key revocation preserves other workspace keys and native human credentials')
  const receipts = await query("SELECT response FROM support_idempotency WHERE operation LIKE 'key.%'")
  check(receipts.length > 0 && receipts.every(row => Object.keys(JSON.parse(String(row.response))).every(key => ['keyIds', 'replacedKeyId'].includes(key))), 'credential replay receipts have an explicit metadata-only shape')
  if (process.env.SUPPORT_CREDENTIAL_BROWSER === '1') await (await import('./credentials-browser')).qualifyCredentialSettings({ api: base.replace(/\/api$/, ''), browserCookie: browserSessionCookie(browser!), project: project.public_id, projectId: Number(project.id), keyId: String(explicitRecovery.key.id), oldKey: explicitRecovery.secret })
  for (let index = 0; index < 205; index++) await insert('support_api_keys', { workspace_id: workspace.id, project_id: project.id, digest: digest(`fixture-pagination-${index}`), scope: 'read' })
  const pageOne = await http(path + '/keys', 'GET', undefined, owner.token)
  const pageTwo = await http(path + `/keys?cursor=${pageOne.data.nextCursor}`, 'GET', undefined, owner.token)
  check(pageOne.data.keys.length === 200 && pageOne.data.nextCursor && pageTwo.data.keys.some((key: any) => key.id === String(writeId)) && new Set([...pageOne.data.keys, ...pageTwo.data.keys].map((key: any) => key.id)).size === (await query('SELECT id FROM support_api_keys WHERE project_id = ?', [project.id])).length, 'cursor pagination exposes old keys without duplicates or truncating revocation controls')
  check((await http(path + '/keys?cursor=1&cursor=2', 'GET', undefined, owner.token)).status === 422, 'ambiguous credential pagination is rejected')
  check(pageOne.headers.get('cache-control') === 'no-store' && pageTwo.headers.get('cache-control') === 'no-store', 'credential metadata responses are never cached')
  process.env.STACKS_RATE_LIMIT_SCALE = '0.01'
  const limited = await Promise.all([http(path + '/keys', 'GET', undefined, owner.token), http(path + '/keys', 'GET', undefined, owner.token)])
  check(limited.some(result => result.status === 429 && Number(result.headers.get('retry-after')) > 0), 'native route budget actually blocks excess requests with Retry-After')
  process.env.STACKS_RATE_LIMIT_SCALE = '100'
  const persistent = JSON.stringify(await query('SELECT * FROM support_api_keys')) + JSON.stringify(await query('SELECT * FROM support_idempotency')) + JSON.stringify(await query('SELECT * FROM support_customer_sessions')) + JSON.stringify(await query('SELECT * FROM support_outbox'))
  check(secrets.every(secret => !persistent.includes(secret)), 'SQL key/session/idempotency/audit records never retain issued raw secrets')
  console.log(`PASS credential HTTP (${checks} checks)`)
}
finally { lostRelease.resolve(); roleRelease.resolve(); server.stop(true) }
