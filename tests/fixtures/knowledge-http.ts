import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { one, query } from '../../app/Support/database'
import { usage } from '../../app/Support/service'
import { route } from '@stacksjs/router'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let csrfToken = '', csrfCookie = '', checks = 0, calls = 0, mode = 'answer'
let releaseProvider: (() => void) | undefined
let providerStarted: (() => void) | undefined
const prompts: string[] = []
const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
  calls++
  assert.equal(new URL(request.url).pathname, '/v1/chat/completions')
  assert.equal(request.headers.get('authorization'), 'Bearer test-provider')
  const body = await request.json() as { messages: { role: string, content: string }[], max_tokens: number }
  assert.equal(body.max_tokens, 1024)
  const payload = JSON.parse(body.messages.find(message => message.role === 'user')!.content)
  prompts.push(JSON.stringify(payload))
  if (mode === 'failure') return Response.json({ error: 'provider temporarily offline' }, { status: 503 })
  if (mode === 'blocked') { providerStarted?.(); await new Promise<void>(resolve => { releaseProvider = resolve }) }
  const grounded = mode !== 'invalid-citation'
  const content = JSON.stringify(mode === 'handoff' ? { answer: '', sourceIds: [], handoff: true } : { answer: 'Open account settings and select Reset password.', sourceIds: [grounded ? payload.excerpts[0].id : '999999'], handoff: false })
  return Response.json({ model: 'test-grounded-model', choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: mode === 'invalid-usage' ? 99999 : 200 } })
} })
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++ }
async function request(path: string, method = 'GET', body?: unknown, token?: string, origin?: string) {
  const result = await fetch(base + path, { method, headers: { accept: 'application/json', ...(csrfCookie ? { cookie: csrfCookie, 'x-csrf-token': csrfToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await result.json() as any
  return { status: result.status, data, headers: result.headers }
}
try {
  const csrf = await request('/csrf-token'); csrfToken = csrf.data.token; csrfCookie = csrf.headers.get('set-cookie')!.split(';')[0]!
  async function account(email: string) {
    const registration = await request('/register', 'POST', { name: 'Knowledge owner', email, password: 'KnowledgeSecure2026!', password_confirmation: 'KnowledgeSecure2026!' })
    check(registration.status < 300, 'native registration works')
    const login = await request('/login', 'POST', { email, password: 'KnowledgeSecure2026!' })
    return login.data.token ?? login.data.access_token ?? login.data.data?.token
  }
  const token = await account('knowledge@example.test'), otherToken = await account('other-knowledge@example.test')
  const workspace = (await request('/support/workspaces', 'POST', { name: 'Knowledge workspace' }, token)).data.workspace
  const projectResult = await request(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Knowledge app' }, token)
  check(projectResult.status === 201, `project created ${JSON.stringify(projectResult.data)}`)
  const project = projectResult.data.project, agent = `/support/projects/${project.public_id}`, widget = `/widget/projects/${project.public_id}`, publicHelp = `/help/projects/${project.public_id}/articles`, origin = 'https://knowledge.example'
  await request(agent, 'PATCH', { allowedOrigins: [origin], anonymousEnabled: false }, token)
  const keys = (await request(agent + '/keys', 'POST', {}, token)).data
  const customer = (await request(`/v1/projects/${project.public_id}/sessions`, 'POST', { externalId: 'knowledge-customer' }, keys.ingestKey)).data
  const stranger = (await request(`/v1/projects/${project.public_id}/sessions`, 'POST', { externalId: 'stranger' }, keys.ingestKey)).data
  async function newConversation(key: string) {
    const result = await request(widget + '/conversations', 'POST', { subject: 'Password help', body: 'How do I reset my password?', idempotencyKey: key }, customer.token, origin)
    check(result.status === 201, `conversation created ${JSON.stringify(result.data)}`)
    return result.data.conversation.id
  }
  const thread = await newConversation('first-thread')
  const imported = await request(agent + '/knowledge/import', 'POST', { slug: 'reset-password', title: 'Reset password', body: '<h1>Reset password</h1><p>Open account settings and select Reset password.</p><script>SECRET_SCRIPT_ATTACK()</script><img src="https://remote.test/a" onerror="attack()">', format: 'html' }, token)
  check(imported.status === 201, `HTML import saved ${JSON.stringify(imported.data)}`)
  const article = imported.data.article
  check(!article.body.includes('SECRET_SCRIPT') && !article.body.includes('<') && !article.body.includes('onerror'), 'HTML imports store safe plain text without active content')
  check((await request(publicHelp)).data.articles.length === 0, 'draft articles never appear publicly')
  const published = await request(`${agent}/knowledge/${article.id}`, 'PATCH', { revision: 1, status: 'published' }, token)
  check(published.status === 200 && published.data.article.revision === 2, `publishing advances revision ${JSON.stringify(published)}`)
  check((await request(`${agent}/knowledge/${article.id}`, 'PATCH', { revision: 1, title: 'Stale edit' }, token)).status === 409, 'stale edits cannot overwrite published revisions')
  const revisions = await request(`${agent}/knowledge/${article.id}/revisions`, 'GET', undefined, token)
  check(revisions.data.revisions.length === 2 && revisions.data.revisions[1].snapshot.status === 'draft', 'durable revision history preserves each version')
  const internal = await request(agent + '/knowledge/import', 'POST', { slug: 'private-reset', title: 'Private reset password', body: '# Private reset password\nINTERNAL_SECRET verify the customer account. [unsafe](javascript:alert(1))', format: 'markdown', visibility: 'internal', status: 'published' }, token)
  check(internal.status === 201 && !internal.data.article.body.includes('javascript:'), 'markdown import removes link targets and preserves text')
  check((await request(publicHelp + '?q=reset%20password')).data.articles.length === 1, 'public lexical retrieval filters published and public articles')
  check((await request(publicHelp + '/private-reset')).status === 404, 'internal article slug is not a public document')
  check((await request(agent + '/knowledge?q=reset%20password', 'GET', undefined, token)).data.articles.length === 2, 'agents can search internal published knowledge')
  check((await request(agent + '/knowledge', 'GET', undefined, otherToken)).status === 403, 'cross-workspace knowledge access is denied')
  check((await request(`${agent}/knowledge/${article.id}/revisions`, 'GET', undefined, otherToken)).status === 403, 'cross-workspace revision access is denied')
  check((await request(widget + '/knowledge', 'GET', undefined, customer.token, 'https://evil.example')).status === 403, 'knowledge widget verifies origin')
  check((await request(widget + '/knowledge', 'GET', undefined, undefined, origin)).status === 401, 'widget retrieval requires a scoped customer session')
  const payload = { question: 'How do I reset my password?', idempotencyKey: 'answer-1' }, endpoint = `${widget}/conversations/${thread}/ai`
  config.ai.default = 'openai'; config.ai.drivers = { openai: {} }
  const unavailable = await request(endpoint, 'POST', payload, customer.token, origin)
  check(unavailable.status === 503 && unavailable.data.error.code === 'ai_unavailable' && await usage(workspace.id, 'ai') === 0, `missing provider is explicit and free ${JSON.stringify(unavailable.data)}`)
  config.ai.drivers = { openai: { apiKey: 'test-provider', baseUrl: `http://127.0.0.1:${provider.port}/v1` } }
  check((await request(endpoint, 'POST', payload, stranger.token, origin)).status === 404, 'AI rejects other contacts conversation')
  check((await request(endpoint, 'POST', payload, customer.token, 'https://evil.example')).status === 403, 'AI rejects unlisted origins')
  const answered = await request(endpoint, 'POST', payload, customer.token, origin)
  check(answered.status === 200 && answered.data.answer && answered.data.sources.length === 1 && answered.data.sources[0].revision === 2, `native provider returns source-backed answer ${JSON.stringify(answered.data)}`)
  check(!prompts.at(-1)!.includes('INTERNAL_SECRET'), 'customer AI prompt never includes internal knowledge')
  check(new URL(answered.data.sources[0].url).pathname === '/help/article', 'customer citation links are absolute help-center URLs usable from embedded customer sites')
  check(answered.headers.get('access-control-allow-origin') === origin, 'AI response returns exact allowed origin')
  const callsBeforeReplay = calls
  const replay = await request(endpoint, 'POST', payload, customer.token, origin)
  check(replay.data.messageId === answered.data.messageId && calls === callsBeforeReplay && await usage(workspace.id, 'ai') === 1, 'completed AI retries neither call provider nor charge twice')
  check((await request(endpoint, 'POST', { ...payload, question: 'Changed input' }, customer.token, origin)).status === 409, 'AI replay enforces payload fingerprint')
  check(Number((await one("SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ? AND author_type = 'ai'", [Number(thread)]))?.n) === 1, 'AI answer and citations persist once as a public message')
  const noEvidence = await request(endpoint, 'POST', { question: 'unfindable-astronaut', idempotencyKey: 'no-evidence' }, customer.token, origin)
  check(noEvidence.status === 200 && noEvidence.data.handoff && noEvidence.data.reason === 'no_sources' && calls === callsBeforeReplay, 'missing knowledge hands off without fabricated provider output')
  const copilot = await request(`${agent}/conversations/${thread}/copilot`, 'POST', { question: 'Private reset password', idempotencyKey: 'copilot' }, token)
  check(await usage(workspace.id, 'copilot_requests') === 1 && await usage(workspace.id, 'copilot_tokens') === 200 && await usage(workspace.id, 'ai') === 1, 'copilot uses its separate request and token meters')
  check(copilot.status === 200 && copilot.data.sources[0].id === String(internal.data.article.id) && prompts.at(-1)!.includes('INTERNAL_SECRET'), 'native-auth copilot can use internal knowledge')
  check(Number((await one("SELECT COUNT(*) AS n FROM support_messages WHERE conversation_id = ? AND author_type = 'ai'", [Number(thread)]))?.n) === 1, 'copilot suggestions are never sent automatically')
  const failureThread = await newConversation('provider-failure')
  const failureEndpoint = `${widget}/conversations/${failureThread}/ai`
  mode = 'failure'
  const failed = await request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'retry-failed' }, customer.token, origin)
  check(failed.status === 503 && await usage(workspace.id, 'ai') === 1, 'provider failure releases newly reserved AI unit')
  const afterFailure = await one('SELECT ai_turns, ai_tokens, ai_charged_period FROM support_conversations WHERE id = ?', [Number(failureThread)])
  check(Number(afterFailure!.ai_turns) === 0 && Number(afterFailure!.ai_tokens) === 0 && afterFailure!.ai_charged_period === '', 'failed attempts release turn and token reservations')
  mode = 'handoff'
  const handoff = await request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'human-handoff' }, customer.token, origin)
  check(handoff.status === 200 && handoff.data.handoff && await usage(workspace.id, 'ai') === 1, 'provider handoff releases the unit because no AI reply was delivered')
  mode = 'invalid-citation'
  check((await request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'bad-source' }, customer.token, origin)).status === 502 && await usage(workspace.id, 'ai') === 1, 'unretrieved citations are rejected and reservation released')
  mode = 'invalid-usage'
  check((await request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'bad-usage' }, customer.token, origin)).status === 502 && await usage(workspace.id, 'ai') === 1, 'unbounded provider token usage is rejected without consuming allowance')
  mode = 'blocked'
  let started!: () => void
  const waiting = new Promise<void>(resolve => { started = resolve }); providerStarted = started
  const inFlight = request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'retry-failed' }, customer.token, origin)
  await waiting
  check((await request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'retry-failed' }, customer.token, origin)).status === 409, 'concurrent retry sees durable pending request')
  const editWhileWaiting = await request(`${agent}/knowledge/${article.id}`, 'PATCH', { revision: 2, title: 'Reset password safely' }, token)
  check(editWhileWaiting.status === 200, 'provider network wait holds no workspace database transaction')
  releaseProvider!(); const withdrawn = await inFlight
  check(withdrawn.status === 409 && withdrawn.data.error.code === 'knowledge_changed' && await usage(workspace.id, 'ai') === 1, 'changed knowledge invalidates running answer and releases unit')
  mode = 'answer'
  const recovered = await request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'retry-failed' }, customer.token, origin)
  check(recovered.status === 200 && recovered.data.sources[0].revision === 3 && await usage(workspace.id, 'ai') === 2, 'same failed key recovers using fresh knowledge and charges once')
  const afterRecovery = await one('SELECT ai_turns, ai_tokens FROM support_conversations WHERE id = ?', [Number(failureThread)])
  check(Number(afterRecovery!.ai_turns) === 1 && Number(afterRecovery!.ai_tokens) === 200, 'finalization replaces conservative reservation with actual provider usage')
  mode = 'blocked'
  const leaseWaiting = new Promise<void>(resolve => { providerStarted = resolve })
  const expiredAttempt = request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'expired-attempt' }, customer.token, origin)
  await leaseWaiting
  await query("UPDATE support_ai_runs SET lease_until = ? WHERE project_id = ? AND key = ?", [Date.now() - 1, project.id, 'expired-attempt'])
  mode = 'answer'
  const successor = await request(failureEndpoint, 'POST', { ...payload, idempotencyKey: 'expired-attempt' }, customer.token, origin)
  check(successor.status === 200, 'expired durable attempt is recoverable with the same key')
  releaseProvider!()
  const staleWorker = await expiredAttempt
  check(staleWorker.status === 409 && staleWorker.data.error.code === 'ai_lease_lost', 'expired worker cannot publish after its successor')
  const successorRun = await one('SELECT status, response FROM support_ai_runs WHERE project_id = ? AND key = ?', [project.id, 'expired-attempt'])
  check(successorRun!.status === 'succeeded' && JSON.parse(String(successorRun!.response)).messageId === successor.data.messageId, 'expired worker cannot release or overwrite successor reservation')
  await query("UPDATE support_workspaces SET plan = 'free', stacks_verified = ?, deployment_verified = ? WHERE id = ?", [true, true, workspace.id])
  for (let index = 0; index < 8; index++) {
    const id = await newConversation(`unit-${index}`)
    const result = await request(`${widget}/conversations/${id}/ai`, 'POST', { ...payload, idempotencyKey: `unit-answer-${index}` }, customer.token, origin)
    check(result.status === 200, `AI unit ${index + 3} is admitted`)
  }
  const extraThread = await newConversation('eleventh-ai')
  const eleventh = await request(`${widget}/conversations/${extraThread}/ai`, 'POST', { ...payload, idempotencyKey: 'unit-eleven' }, customer.token, origin)
  check(eleventh.status === 402 && eleventh.data.error.code === 'ai_limit' && await usage(workspace.id, 'ai') === 10, 'eleventh free AI-handled conversation is refused exactly')
  const copilotOnly = await newConversation('copilot-only')
  const isolatedCopilot = await request(`${agent}/conversations/${copilotOnly}/copilot`, 'POST', { question: 'Private reset password', idempotencyKey: 'copilot-only-answer' }, token)
  const copilotRow = await one('SELECT ai_turns, ai_tokens, ai_charged_period FROM support_conversations WHERE id = ?', [Number(copilotOnly)])
  check(isolatedCopilot.status === 200 && Number(copilotRow!.ai_turns) === 0 && Number(copilotRow!.ai_tokens) === 0 && copilotRow!.ai_charged_period === '' && await usage(workspace.id, 'ai') === 10, 'copilot remains usable at customer AI cap without consuming a customer conversation unit')
  const copilotRequestsBefore = await usage(workspace.id, 'copilot_requests'), copilotTokensBefore = await usage(workspace.id, 'copilot_tokens')
  mode = 'failure'
  const copilotFailure = await request(`${agent}/conversations/${copilotOnly}/copilot`, 'POST', { question: 'Private reset password', idempotencyKey: 'copilot-retry-failure' }, token)
  check(copilotFailure.status === 503 && await usage(workspace.id, 'copilot_requests') === copilotRequestsBefore && await usage(workspace.id, 'copilot_tokens') === copilotTokensBefore && await usage(workspace.id, 'ai') === 10, 'copilot provider failure releases its own request and token reservation without changing customer AI usage')
  mode = 'answer'
  await query("UPDATE support_usage SET used = 99999 WHERE workspace_id = ? AND meter = 'copilot_tokens'", [workspace.id])
  const beforeCopilotTokenCap = calls
  const copilotTokenCap = await request(`${agent}/conversations/${copilotOnly}/copilot`, 'POST', { question: 'Private reset password', idempotencyKey: 'copilot-token-cap' }, token)
  check(copilotTokenCap.status === 402 && copilotTokenCap.data.error.code === 'copilot_limit' && calls === beforeCopilotTokenCap, 'copilot token budget rejects provider work independently of request count')
  await query("UPDATE support_usage SET used = ? WHERE workspace_id = ? AND meter = 'copilot_tokens'", [copilotTokensBefore, workspace.id])
  await query("UPDATE support_usage SET used = 100 WHERE workspace_id = ? AND meter = 'copilot_requests'", [workspace.id])
  const copilotCapped = await request(`${agent}/conversations/${copilotOnly}/copilot`, 'POST', { question: 'Private reset password', idempotencyKey: 'copilot-over-cap' }, token)
  check(copilotCapped.status === 402 && copilotCapped.data.error.code === 'copilot_limit', 'free copilot request budget is independently bounded')
  const capabilities = await request(`${agent}/ai/capabilities`, 'GET', undefined, token)
  check(capabilities.status === 200 && capabilities.data.copilot.limits.requests === 100 && capabilities.data.copilot.remaining.requests === 0 && capabilities.data.customerAi.limit === 10 && capabilities.data.customerAi.copilotIncluded === false, 'UI capabilities expose separate copilot and customer AI budgets')
  await query('UPDATE support_conversations SET ai_turns = 19, ai_tokens = 0 WHERE id = ?', [Number(thread)])
  check((await request(endpoint, 'POST', { ...payload, idempotencyKey: 'turn-20' }, customer.token, origin)).status === 200, 'twentieth AI turn allowed in existing unit after monthly cap')
  check((await request(endpoint, 'POST', { ...payload, idempotencyKey: 'turn-21' }, customer.token, origin)).data.error.code === 'ai_unit_limit', 'twenty-first AI turn denied')
  await query('UPDATE support_conversations SET ai_turns = 1, ai_tokens = 19900 WHERE id = ?', [Number(thread)])
  check((await request(endpoint, 'POST', { ...payload, idempotencyKey: 'token-cap' }, customer.token, origin)).data.error.code === 'ai_unit_limit', '20,000-token ceiling accounts for the next full provider reservation')
  console.log(`PASS knowledge HTTP ${checks} checks`)
}
finally { releaseProvider?.(); await server.stop(true); await provider.stop(true) }
