import assert from 'node:assert/strict'
import { startBrowserSession, browserSessionCookie } from '@stacksjs/auth'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import corsMiddleware from '../../app/Middleware/Cors'
import { insert, one, query } from '../../app/Support/database'

await overridesReady
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
route.use(corsMiddleware.toRouterHandler())
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
let cookie = '', csrf = '', checks = 0
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++ }
async function http(path: string, token?: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any }
}
try {
  const seed = await fetch(base + '/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const password = 'CustomerFeedback2026!'
  async function owner(name: string) {
    const email = name + '@csat.example.test'
    assert.equal((await http('/register', undefined, 'POST', { name, email, password, password_confirmation: password })).status, 200)
    const login = await http('/login', undefined, 'POST', { email, password })
    const token = login.data.access_token ?? login.data.token
    const workspace = (await http('/support/workspaces', token, 'POST', { name })).data.workspace
    return { token, workspace, id: Number((await one('SELECT id FROM users WHERE email = ?', [email]))!.id) }
  }
  const first = await owner('owner'), outsider = await owner('outsider'), agent = await owner('agent')
  await insert('support_memberships', { workspace_id: first.workspace.id, user_id: agent.id, email: 'agent@csat.example.test', role: 'agent', status: 'active' })
  const project = (await http(`/support/workspaces/${first.workspace.id}/projects`, first.token, 'POST', { name: 'Feedback app' })).data.project
  const sibling = (await http(`/support/workspaces/${first.workspace.id}/projects`, first.token, 'POST', { name: 'Sibling app' })).data.project
  const prefix = `/support/projects/${project.public_id}`, widget = `/widget/projects/${project.public_id}`
  const keys = (await http(prefix + '/keys', first.token, 'POST', {})).data
  const origin = 'https://customer.example.test'
  const nativePreflight = await fetch(base + '/login', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' } })
  check(nativePreflight.status === 204 && nativePreflight.headers.get('access-control-allow-origin') === '*', 'other API routes retain the native CORS policy')
  assert.equal((await http(prefix, first.token, 'PATCH', { allowedOrigins: [origin] })).status, 200)
  async function session(externalId: string) { return (await http(`/v1/projects/${project.public_id}/sessions`, keys.ingestKey, 'POST', { externalId })).data.token as string }
  const customer = await session('customer'), stranger = await session('stranger')
  async function customerRequest(path: string, token = customer, body?: unknown, allowedOrigin = origin) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, origin: allowedOrigin, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() as any, headers: response.headers }
  }
  async function create() { return (await http(`/v1/projects/${project.public_id}/conversations`, keys.ingestKey, 'POST', { externalId: 'customer', subject: 'Please help', body: 'Customer support question', idempotencyKey: crypto.randomUUID() })).data.conversation.id as string }
  const id = await create(), path = widget + '/conversations/' + id + '/csat', settings = prefix + '/csat-settings'
  const initial = await http(settings, first.token)
  check(initial.status === 200 && initial.data.settings.enabled === false && initial.data.settings.revision === 0, 'CSAT is opt-in without a read causing a settings write')
  check((await customerRequest(path)).data.available === false, 'disabled survey is unavailable to its own customer')
  check((await http(settings, agent.token, 'PATCH', { enabled: true, question: 'How did we do?', expectedRevision: 0 })).status === 403, 'ordinary agent cannot enable or edit project surveys')
  check((await http(settings, outsider.token)).status === 403, 'other workspace cannot read survey configuration')
  const login = await http('/login', undefined, 'POST', { email: 'owner@csat.example.test', password })
  const browser = await startBrowserSession(login.data.access_token ?? login.data.token), browserCookie = browserSessionCookie(browser!).split(';')[0]!
  const configurationBody = JSON.stringify({ enabled: true, question: 'How did we do?', expectedRevision: 0 })
  const withoutCsrf = await fetch(base + settings, { method: 'PATCH', headers: { cookie: `${cookie}; ${browserCookie}`, 'content-type': 'application/json' }, body: configurationBody })
  check(withoutCsrf.status === 403 && !await one('SELECT id FROM support_csat_settings WHERE project_id = ?', [project.id]), 'native browser authentication cannot enable surveys without CSRF')
  const configured = await fetch(base + settings, { method: 'PATCH', headers: { cookie: `${cookie}; ${browserCookie}`, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: configurationBody })
  const enabled = { status: configured.status, data: await configured.json() as any }
  check(enabled.status === 200 && enabled.data.settings.revision === 1, 'owner enables the first persisted question revision')
  check((await customerRequest(path)).data.reason === 'conversation_open', 'survey is not offered on an unresolved conversation')
  await http(prefix + '/conversations/' + id, first.token, 'PATCH', { status: 'closed' })
  const offered = await customerRequest(path)
  check(offered.status === 200 && offered.data.available && offered.data.survey.question === 'How did we do?' && offered.headers.get('access-control-allow-origin') === origin, 'resolved own conversation receives exact current question and origin-scoped response')
  const preflight = await fetch(base + path, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type' } })
  check(preflight.status === 204 && preflight.headers.get('access-control-allow-origin') === origin, 'the real native cross-origin customer request has a permitted bearer preflight')
  const invalidOrigin = 'https://unapproved.example.test'
  const refusedPreflight = await fetch(base + path, { method: 'OPTIONS', headers: { origin: invalidOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Content-Type' } })
  check(refusedPreflight.status === 403 && !refusedPreflight.headers.has('access-control-allow-origin'), 'an unapproved project origin receives no browser preflight grant')
  check((await customerRequest(path, stranger)).status === 404, 'another customer cannot inspect or rate this conversation')
  const refusedRequest = await customerRequest(path, customer, undefined, invalidOrigin)
  check(refusedRequest.status === 403 && !refusedRequest.headers.has('access-control-allow-origin'), 'bearer token does not bypass exact origin policy')
  check((await customerRequest(`/widget/projects/${sibling.public_id}/conversations/${id}/csat`)).status === 403, 'sibling project cannot reuse this origin or customer token')
  const input = { score: 5, comment: 'Helpful support.', revision: 1, idempotencyKey: 'once-only-rating' }
  for (const score of [0, 6, 1.5, true, '5']) check((await customerRequest(path, customer, { ...input, score })).status === 422, 'score requires a whole number from one through five')
  check((await customerRequest(path, customer, { ...input, comment: 'x'.repeat(2001) })).status === 422, 'comment bound is checked before persistence')
  check((await customerRequest(path, customer, { ...input, contactId: 9999 })).status === 422, 'body identity fields cannot widen the customer grant')
  const usageBefore = JSON.stringify(await query('SELECT * FROM support_usage ORDER BY id'))
  const sent = await Promise.all([customerRequest(path, customer, input), customerRequest(path, customer, { ...input, score: 4, idempotencyKey: 'competing-rating' })])
  check(sent.filter(item => item.status === 201).length === 1 && sent.filter(item => item.status === 409).length === 1, 'competing submissions commit exactly one immutable response')
  const answer = (await one('SELECT * FROM support_csat_responses WHERE conversation_id = ?', [id]))!
  const winner = Number(answer.score) === 5 ? input : { ...input, score: 4, idempotencyKey: 'competing-rating' }
  const replay = await customerRequest(path, customer, winner)
  check(replay.status === 201 && Number(replay.data.response.score) === Number(answer.score) && Number((await one('SELECT COUNT(*) AS n FROM support_csat_responses'))!.n) === 1, 'same-operation replay returns the original answer without a duplicate record')
  check((await customerRequest(path, customer, { ...winner, score: 3 })).status === 409, 'a retry key cannot change a committed rating')
  check(JSON.stringify(await query('SELECT * FROM support_usage ORDER BY id')) === usageBefore, 'feedback consumes no conversation or AI units')
  check((await customerRequest(path, stranger, winner)).status === 404, 'stranger cannot use an existing operation receipt as a grant')
  await http(settings, first.token, 'PATCH', { enabled: true, question: 'A newer question', expectedRevision: 1 })
  const retained = await customerRequest(path)
  check(retained.data.reason === 'answered' && retained.data.response.question === 'How did we do?' && retained.data.response.revision === 1, 'later settings changes preserve the historical question and answer')
  check((await http(settings, first.token, 'PATCH', { enabled: false, question: 'Lost race', expectedRevision: 1 })).status === 409, 'stale settings revisions cannot overwrite another administrator change')
  const second = await create(); await http(prefix + '/conversations/' + second, first.token, 'PATCH', { status: 'closed' })
  check((await customerRequest(widget + '/conversations/' + second + '/csat', customer, input)).status === 409, 'submission with an outdated offered question must refresh before rating')
  const report = await http(prefix + '/csat-report', agent.token)
  check(report.status === 200 && report.data.responses === 1 && report.data.distribution.reduce((sum: number, row: any) => sum + row.count, 0) === 1 && report.data.averageScore === Number(answer.score), 'authorized report reconciles exactly to persisted response rows')
  check(!JSON.stringify(report.data).includes('Helpful support.') && !JSON.stringify(report.data).includes('customer_id'), 'aggregate reporting omits raw comments and customer identities')
  check((await http(`/support/projects/${sibling.public_id}/csat-report`, first.token)).data.responses === 0, 'same-workspace sibling report cannot see another project')
  check((await http(prefix + '/csat-report', outsider.token)).status === 403, 'foreign workspace cannot query aggregate feedback')
  check((await http(prefix + '/csat-report', keys.readKey)).status === 401, 'integration summary keys cannot impersonate an agent report session')
  await http(settings, first.token, 'PATCH', { enabled: false, question: 'A newer question', expectedRevision: 2 })
  check((await customerRequest(widget + '/conversations/' + second + '/csat')).data.reason === 'disabled', 'disabling surveys immediately closes new submission opportunities')
  check((await customerRequest(widget + '/conversations/' + second + '/csat', customer, { ...input, revision: 3 })).status === 409, 'disabled survey rejects a previously cached submission')
  check((await one('SELECT question FROM support_csat_responses WHERE conversation_id = ?', [id]))!.question === 'How did we do?', 'configuration revocation never rewrites an existing rating')
  await query('UPDATE support_csat_responses SET created_at = ? WHERE id = ?', ['2026-01-31T23:59:59.999Z', answer.id])
  const contact = (await one('SELECT contact_id FROM support_conversations WHERE id = ?', [second]))!
  const boundary = await insert('support_csat_responses', { workspace_id: first.workspace.id, project_id: project.id, conversation_id: second, contact_id: contact.contact_id, setting_revision: 2, question: 'A newer question', score: 1, comment: '' })
  await query('UPDATE support_csat_responses SET created_at = ? WHERE id = ?', ['2026-02-01T00:00:00.000Z', boundary.id])
  const january = await http(prefix + '/csat-report?period=2026-01', first.token), february = await http(prefix + '/csat-report?period=2026-02', first.token)
  check(january.data.responses === 1 && january.data.averageScore === Number(answer.score) && february.data.responses === 1 && february.data.averageScore === 1, 'report windows partition exactly at the UTC month boundary')
  for (const period of ['2026-13', '2026-00', '2026-1', '2026-01&period=2026-02']) check((await http(prefix + '/csat-report?period=' + period, first.token)).status === 422, 'invalid or repeated report periods are rejected')
  await query("UPDATE support_memberships SET status = 'inactive' WHERE workspace_id = ? AND user_id = ?", [first.workspace.id, agent.id])
  check((await http(prefix + '/csat-report', agent.token)).status === 403, 'revoked membership cannot continue reading feedback aggregates')
  const selfLogout = await customerRequest(widget + '/session/revoke', customer, {})
  check(selfLogout.status === 200 && (await customerRequest(path, customer, winner)).status === 401, 'a revoked customer session cannot replay its earlier survey receipt')
  console.info(`PASS CSAT HTTP (${checks} checks)`)
}
finally { server.stop(true) }
