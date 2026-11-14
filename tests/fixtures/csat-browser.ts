import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { startBrowserSession, browserSessionCookie } from '@stacksjs/auth'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { generateStaticSite } from '@stacksjs/stx/ssg'
import { launch, navigate, waitFor, closeSharedBrowsers } from '@stacksjs/testing/browser'
import { insert, one } from '../../app/Support/database'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true); assert.equal((await runDatabaseMigration()).isOk, true); assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports(); await route.importRoutes()
const api = await route.serve({ port: 0, hostname: '127.0.0.1' }), apiOrigin = `http://127.0.0.1:${api.port}`
const root = resolve(import.meta.dir, '../..'), output = await mkdtemp(resolve(tmpdir(), 'hq-support-csat-browser-')), artifacts = resolve(root, 'storage/framework/runtime/csat-browser')
let host: ReturnType<typeof Bun.serve> | undefined, boundary: ReturnType<typeof Bun.serve> | undefined, browser: Awaited<ReturnType<typeof launch>> | undefined
let cookie = '', csrf = '', loseFeedback = false, loseSettings = false
const submissions: any[] = [], widgetCookies: string[] = [], assertions: string[] = [], runtimeErrors: string[] = []
let heldFeedback: { token: string, entered: ReturnType<typeof Promise.withResolvers<void>>, release: ReturnType<typeof Promise.withResolvers<void>>, used: boolean, beforeNative?: boolean } | undefined
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions.push(message) }
async function http(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(apiOrigin + '/api' + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any }
}
async function account(name: string) {
  const email = `${name}@csat-browser.example.test`, password = 'CsatBrowserFixture2026!'
  assert.equal((await http('/register', 'POST', { name, email, password, password_confirmation: password })).status, 200)
  const login = await http('/login', 'POST', { email, password })
  return { token: login.data.access_token ?? login.data.token, id: Number((await one('SELECT id FROM users WHERE email = ?', [email]))!.id) }
}
try {
  const seed = await fetch(apiOrigin + '/api/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const owner = await account('owner'), agent = await account('agent')
  const workspace = (await http('/support/workspaces', 'POST', { name: 'CSAT browser workspace' }, owner.token)).data.workspace
  await insert('support_memberships', { workspace_id: workspace.id, user_id: agent.id, email: 'agent@csat-browser.example.test', role: 'agent', status: 'active' })
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Feedback brand' }, owner.token)).data.project, prefix = `/support/projects/${project.public_id}`
  const sibling = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Other feedback brand' }, owner.token)).data.project
  const keys = (await http(prefix + '/keys', 'POST', {}, owner.token)).data
  const a = (await http(`/v1/projects/${project.public_id}/sessions`, 'POST', { externalId: 'customer-a' }, keys.ingestKey)).data
  const b = (await http(`/v1/projects/${project.public_id}/sessions`, 'POST', { externalId: 'customer-b' }, keys.ingestKey)).data
  async function conversation(externalId: string, subject: string, closed = true) { const created = await http(`/v1/projects/${project.public_id}/conversations`, 'POST', { externalId, subject, body: 'A real customer message', idempotencyKey: subject }, keys.ingestKey); assert.equal(created.status, 201); if (closed) assert.equal((await http(prefix + `/conversations/${created.data.conversation.id}`, 'PATCH', { status: 'closed' }, owner.token)).status, 200); return created.data.conversation }
  const ca = await conversation('customer-a', 'Resolved customer A'), cb = await conversation('customer-b', 'Resolved customer B')
  async function browserCookie(name: string) { const login = await http('/login', 'POST', { email: `${name}@csat-browser.example.test`, password: 'CsatBrowserFixture2026!' }); const session = await startBrowserSession(login.data.access_token ?? login.data.token); assert.ok(session); return browserSessionCookie(session!) }
  const ownerCookie = await browserCookie('owner'), agentCookie = await browserCookie('agent')
  async function configure(question: string, enabled: boolean) { const current = (await http(prefix + '/csat-settings', 'GET', undefined, owner.token)).data.settings; const result = await http(prefix + '/csat-settings', 'PATCH', { question, enabled, expectedRevision: current.revision }, owner.token); assert.equal(result.status, 200); return result.data.settings }
  const compiled = await generateStaticSite({ pagesDir: resolve(root, 'resources/views'), outputDir: output, publicDir: resolve(root, 'public'), partialsDir: resolve(root, 'resources/partials'), componentsDir: resolve(root, 'resources/components'), router: { enabled: false }, minify: false, cache: false, sitemap: false, robots: false }); assert.equal(compiled.failedCount, 0)
  boundary = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.headers.get('cookie')) widgetCookies.push(request.headers.get('cookie')!)
    const url = new URL(request.url), body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().text()
    if (request.method === 'POST' && url.pathname.endsWith('/csat')) submissions.push(JSON.parse(body!))
    const headers = new Headers(request.headers); headers.delete('host')
    const before = heldFeedback
    if (request.method === 'GET' && url.pathname.endsWith('/csat') && before?.beforeNative && !before.used && request.headers.get('authorization') === `Bearer ${before.token}`) { before.used = true; before.entered.resolve(); await before.release.promise }
    const response = await fetch(new URL(url.pathname + url.search, apiOrigin), { method: request.method, headers, ...(body === undefined ? {} : { body }) })
    const outgoing = new Headers(response.headers); outgoing.delete('content-encoding'); outgoing.delete('content-length')
    const held = heldFeedback
    if (request.method === 'GET' && url.pathname.endsWith('/csat') && held && !held.used && request.headers.get('authorization') === `Bearer ${held.token}`) { held.used = true; held.entered.resolve(); await held.release.promise }
    if (loseFeedback && request.method === 'POST' && url.pathname.endsWith('/csat') && response.ok) { loseFeedback = false; await response.arrayBuffer(); return Response.json({ error: { message: 'Fixture feedback response lost after native commit.' } }, { status: 503, headers: { 'Access-Control-Allow-Origin': request.headers.get('origin')!, Vary: 'Origin' } }) }
    return new Response(response.body, { status: response.status, headers: outgoing })
  } })
  const manifest = await Bun.file(resolve(root, 'public/widgets/manifest.json')).json()
  host = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/_fixture/')) return new Response(null, { status: 303, headers: { location: '/app/customer-satisfaction', 'set-cookie': url.pathname.endsWith('/agent') ? agentCookie : ownerCookie } })
    if (url.pathname.startsWith('/api/')) { const headers = new Headers(request.headers); headers.delete('host'); const response = await fetch(new URL(url.pathname + url.search, apiOrigin), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body }); const outgoing = new Headers(response.headers); outgoing.delete('content-encoding'); outgoing.delete('content-length'); if (loseSettings && request.method === 'PATCH' && url.pathname.endsWith('/csat-settings') && response.ok) { loseSettings = false; await response.arrayBuffer(); return Response.json({ error: { message: 'Fixture settings acknowledgement lost after native commit.' } }, { status: 503 }) }; return new Response(response.body, { status: response.status, headers: outgoing }) }
    if (url.pathname === '/widget') return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Native CSAT customer proof</title></head><body><h1>Customer support feedback</h1><hq-support-messenger></hq-support-messenger><script type="module" src="/widget-entry.js"></script></body></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': `default-src 'none'; script-src 'self'; style-src ${manifest.csp.styleSrc.join(' ')}; connect-src 'self' ${boundary!.url.origin}; img-src 'self'; base-uri 'none'; object-src 'none'` } })
    if (url.pathname === '/widget-entry.js') return new Response(`
      // Observe real timers without cancelling, delaying or replacing callbacks.
      const activeIntervals = new Set()
      const nativeSetInterval = globalThis.setInterval.bind(globalThis)
      const nativeClearInterval = globalThis.clearInterval.bind(globalThis)
      globalThis.setInterval = (...args) => { const id = nativeSetInterval(...args); activeIntervals.add(id); document.body.dataset.activeIntervals = String(activeIntervals.size); return id }
      globalThis.clearInterval = id => { nativeClearInterval(id); activeIntervals.delete(id); document.body.dataset.activeIntervals = String(activeIntervals.size) }
      const messenger = document.querySelector('hq-support-messenger')
      for (const event of ['ready', 'unread', 'delivery']) messenger.addEventListener(event, () => { messenger.dataset[event + 'Count'] = String(Number(messenger.dataset[event + 'Count'] || 0) + 1) })
      await import('/widgets/bundle.js')
    `, { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
    const path = url.pathname === '/app/customer-satisfaction' ? '/app/customer-satisfaction.html' : url.pathname, file = resolve(output, '.' + decodeURIComponent(path))
    if (!file.startsWith(output + sep)) return new Response('Forbidden', { status: 403 })
    return await Bun.file(file).exists() ? new Response(Bun.file(file), { headers: path.endsWith('.html') ? { 'content-type': 'text/html', 'cache-control': 'no-store' } : {} }) : new Response('Not found', { status: 404 })
  } })
  const origin = host.url.origin
  assert.equal((await http(prefix, 'PATCH', { allowedOrigins: [origin], anonymousEnabled: false }, owner.token)).status, 200)
  browser = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH, startTimeoutMs: 60000, commandTimeoutMs: 20000 })
  const cdp = browser.cdp
  cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(String(event.exceptionDetails.exception?.description || event.exceptionDetails.text)))
  await cdp.intercept([{ urlPattern: '*' }], async (event, session) => { const url = new URL(event.request.url); if (['http:', 'https:'].includes(url.protocol) && ![origin, boundary!.url.origin].includes(url.origin)) await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' }); else await session.send('Fetch.continueRequest', { requestId: event.requestId }) })
  const evaluate = (expression: string) => cdp.evaluate(expression)
  const input = (selector: string, value: string) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  const click = (label: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(label)})?.click()`)
  const text = (value: string) => waitFor(() => evaluate(`document.body.textContent.includes(${JSON.stringify(value)})`), 15000, { label: value })
  const widget = `document.querySelector('hq-support-messenger')`
  const widgetRoot = `${widget}.shadowRoot`
  const widgetText = (value: string) => waitFor(() => evaluate(`${widgetRoot}.textContent.includes(${JSON.stringify(value)})`), 15000, { label: value })
  const widgetClick = (label: string) => evaluate(`Array.from(${widgetRoot}.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(label)})?.click()`)
  async function boot(token: string) { await evaluate(`(async()=>{const messenger=${widget};await customElements.whenDefined('hq-support-messenger');await messenger.boot({url:${JSON.stringify(boundary.url.origin)},project:${JSON.stringify(project.public_id)},token:${JSON.stringify(token)}});messenger.open()})()`); await waitFor(() => evaluate(`${widgetRoot}.querySelector('.messages') !== null`), 15000, { label: 'Native Messenger connected' }) }
  async function answer(score: number, comment: string) { await evaluate(`(()=>{const root=${widgetRoot};root.querySelector('input[name="score"][value="${score}"]').click();const field=root.querySelector('#csat-comment');field.value=${JSON.stringify(comment)};field.dispatchEvent(new Event('input',{bubbles:true}));})()`) }
  await navigate(cdp, origin + '/widget', { quietMs: 100, timeoutMs: 20000 }); await boot(a.token)
  check(await evaluate(`!${widgetRoot}.querySelector('.csat-form') && !${widgetRoot}.querySelector('.csat-answer')`) && Number((await one('SELECT COUNT(*) AS count FROM support_csat_settings WHERE project_id = ?', [project.id]))!.count) === 0, 'resolved conversation without opt-in shows no survey and creates no settings row')
  const firstWidgetErrorCount = runtimeErrors.length
  check(firstWidgetErrorCount === 0, 'compiled native Messenger loads under strict CSP without runtime errors')
  await navigate(cdp, origin + '/_fixture/owner', { quietMs: 100, timeoutMs: 20000 }); await waitFor(() => evaluate(`document.querySelector('#csat-question') !== null`), 15000, { label: 'Native owner CSAT editor' })
  check(await evaluate(`!document.querySelector('#csat-enabled').checked && document.body.textContent.includes('Saved revision 0') && document.body.textContent.includes('No satisfaction responses')`), 'owner sees disabled opt-in and honest empty aggregate values')
  const originalQuestion = 'How helpful was this support conversation?'
  await input('#csat-question', originalQuestion); await evaluate(`document.querySelector('#csat-enabled').click()`); await click('Save satisfaction settings'); await text('Satisfaction settings saved for this project.')
  check((await http(prefix + '/csat-settings', 'GET', undefined, owner.token)).data.settings.revision === 1, 'compiled owner editor enables an actual revisioned project question')
  await navigate(cdp, origin + '/widget', { quietMs: 100, timeoutMs: 20000 }); const beforeWidgetErrors = runtimeErrors.length; await boot(a.token); await widgetText(originalQuestion)
  check(await evaluate(`${widgetRoot}.querySelectorAll('input[type="radio"][name="score"]').length === 5 && ${widgetRoot}.querySelector('legend').textContent === ${JSON.stringify(originalQuestion)} && ${widgetRoot}.textContent.includes('Question revision 1')`), 'eligible own resolved conversation offers a labelled five-score form with its exact question and revision')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
  check(await evaluate(`document.documentElement.scrollWidth <= 375 && Array.from(${widgetRoot}.querySelectorAll('.csat-score')).every(el=>el.getBoundingClientRect().width >= 40) && ${widgetRoot}.querySelector('fieldset').querySelector('legend') !== null`), '375px Messenger keeps five labelled native radio targets visible without horizontal overflow')
  await evaluate(`${widgetRoot}.querySelector('input[value="1"]').focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
  check(await evaluate(`${widgetRoot}.querySelector('input[value="2"]').checked && ${widgetRoot}.activeElement?.value === '2'`), 'native grouped radio controls support keyboard arrow selection and focus')
  await mkdir(artifacts, { recursive: true })
  const messengerImage = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); await Bun.write(resolve(artifacts, 'messenger-375.png'), Buffer.from(messengerImage.data, 'base64'))
  const originalComment = 'PRIVATE-COMMENT-MARKER <b>Helpful original response</b>'
  const messagesBefore = Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ?', [project.id]))!.count)
  await answer(4, originalComment); loseFeedback = true; await widgetClick('Send feedback'); await widgetText('Fixture feedback response lost after native commit.')
  check(await evaluate(`${widgetRoot}.querySelector('#csat-comment').value === ${JSON.stringify(originalComment)} && ${widgetRoot}.querySelector('input[value="4"]').checked && ${widgetRoot}.querySelector('legend').textContent === ${JSON.stringify(originalQuestion)}`), 'lost committed feedback response preserves the score, comment and offered question draft')
  await configure('A later disabled question', false)
  await widgetClick('Send feedback'); await widgetText('Feedback received')
  const savedA = (await one('SELECT * FROM support_csat_responses WHERE conversation_id = ?', [ca.id]))!
  check(submissions.length === 2 && submissions[0].idempotencyKey === submissions[1].idempotencyKey && savedA.question === originalQuestion && Number(savedA.setting_revision) === 1 && Number((await one('SELECT COUNT(*) AS count FROM support_csat_responses WHERE conversation_id = ?', [ca.id]))!.count) === 1, 'same-payload retry reuses the operation key and immutable original question after later configuration changes')
  check(await evaluate(`${widgetRoot}.querySelector('.csat-answer').textContent.includes(${JSON.stringify(originalComment)}) && !${widgetRoot}.querySelector('.csat-answer b') && !${widgetRoot}.querySelector('.csat-form')`), 'saved feedback renders own immutable response as text without a second rating form')
  await evaluate(`${widget}.update({token:${JSON.stringify(b.token)}})`)
  check(await evaluate(`!${widgetRoot}.querySelector('.csat-form') && !${widgetRoot}.querySelector('.csat-answer') && !${widgetRoot}.textContent.includes('PRIVATE-COMMENT-MARKER')`), 'account switch clears the previous response and disabled customer B sees no feedback form')
  const beforeIsolation = Number((await one('SELECT COUNT(*) AS count FROM support_csat_responses'))!.count)
  await evaluate(`(async()=>{const messenger=${widget};messenger.conversationId=${JSON.stringify(String(ca.id))};await messenger.refreshCsat()})()`)
  check(await evaluate(`!${widgetRoot}.querySelector('.csat-answer')`) && Number((await one('SELECT COUNT(*) AS count FROM support_csat_responses'))!.count) === beforeIsolation, 'another customer conversation grants no feedback history or mutation authority')
  const questionB = await configure('Question offered to customer B', true)
  await evaluate(`${widget}.update({token:${JSON.stringify(b.token)}})`); await widgetText(questionB.question); await answer(2, 'Draft preserved through a question conflict')
  const questionC = await configure('Revised question for review', true)
  await widgetClick('Send feedback'); await widgetText('The question changed.')
  check(await evaluate(`${widgetRoot}.querySelector('legend').textContent === ${JSON.stringify(questionB.question)} && ${widgetRoot}.querySelector('#csat-comment').value === 'Draft preserved through a question conflict'`) && !await one('SELECT id FROM support_csat_responses WHERE conversation_id = ?', [cb.id]), 'stale-question rejection keeps the original offered revision and draft without a response write')
  await widgetClick('Review current question'); await widgetText(questionC.question)
  check(await evaluate(`${widgetRoot}.querySelector('#csat-comment').value === 'Draft preserved through a question conflict' && ${widgetRoot}.textContent.includes('Question revision ${questionC.revision}')`), 'explicit question review adopts the new revision while retaining editable customer context')
  await widgetClick('Send feedback'); await widgetText('Feedback received')
  check((await one('SELECT question FROM support_csat_responses WHERE conversation_id = ?', [cb.id]))!.question === questionC.question && Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ?', [project.id]))!.count) === messagesBefore, 'feedback commits the reviewed question and creates no outbound survey or chat message')
  const open = await conversation('customer-b', 'Still-open conversation', false)
  await evaluate(`${widget}.update({token:${JSON.stringify(b.token)}})`)
  check(await evaluate(`!${widgetRoot}.querySelector('.csat-form')`), 'open conversation has no rating opportunity')
  await http(prefix + `/conversations/${open.id}`, 'PATCH', { status: 'closed' }, owner.token); await evaluate(`${widget}.refresh()`); await widgetText(questionC.question)
  check(await evaluate(`${widgetRoot}.querySelector('.csat-form') !== null`), 'actual own conversation resolution makes the opt-in form eligible during refresh')
  await answer(3, 'Draft before survey is disabled'); await configure('Disabled while drafting', false); await widgetClick('Send feedback'); await widgetText('This survey is no longer accepting a response.')
  check(!await one('SELECT id FROM support_csat_responses WHERE conversation_id = ?', [open.id]) && await evaluate(`!${widgetRoot}.querySelector('.csat-form')`), 'disabling an offered survey refuses a new response honestly')
  await evaluate(`for(const event of ['ready','unread','delivery']) ${widget}.dataset[event + 'Count'] = '0'`)
  heldFeedback = { token: a.token, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), used: false }
  const oldBoot = evaluate(`${widget}.update({token:${JSON.stringify(a.token)}})`); await heldFeedback.entered.promise
  await evaluate(`${widget}.update({token:${JSON.stringify(b.token)}})`); heldFeedback.release.resolve(); await oldBoot; await Bun.sleep(100)
  check(await evaluate(`!${widgetRoot}.textContent.includes('PRIVATE-COMMENT-MARKER') && !${widgetRoot}.querySelector('.csat-answer')`), 'late customer A feedback receipt cannot restore history after switching to B')
  check(await evaluate(`${widget}.dataset.readyCount === '1' && ${widget}.dataset.unreadCount === '1' && document.body.dataset.activeIntervals === '1'`), 'stale customer boot emits no ready/unread events and installs no competing poll interval')
  await boot(a.token)
  heldFeedback = { token: a.token, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), used: false }
  await evaluate(`${widget}.dataset.deliveryCount = '0'`)
  await evaluate(`(()=>{const field=${widgetRoot}.querySelector('#support-body');field.value='Message committed before customer switch';field.dispatchEvent(new Event('input',{bubbles:true}));field.form.requestSubmit()})()`)
  await heldFeedback.entered.promise
  await evaluate(`${widget}.update({token:${JSON.stringify(b.token)}})`); heldFeedback.release.resolve(); await Bun.sleep(100)
  check(await evaluate(`${widget}.dataset.deliveryCount === '0'`) && Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ? AND body = ?', [ca.id, 'Message committed before customer switch']))!.count) === 1, 'committed previous-customer message cannot emit delivery after a held feedback read outlives its session')
  check(await evaluate(`document.body.dataset.activeIntervals === '1'`), 'message-session switch retains exactly the current customer polling interval')
  await evaluate(`${widget}.shutdown()`)
  check(await evaluate(`${widget}.sessionToken === '' && !${widgetRoot}.querySelector('.csat-form') && !${widgetRoot}.querySelector('.csat-answer') && !${widget}.hasAttribute('session-token') && !${widget}.hasAttribute('csat')`), 'shutdown clears feedback and identity without reflecting tokens or comments into attributes')
  check(await evaluate(`document.body.dataset.activeIntervals === '0'`), 'shutdown clears every observed native Messenger interval after stale boot and send continuations')
  heldFeedback = { token: a.token, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>(), used: false, beforeNative: true }
  await evaluate(`${widget}.dataset.readyCount = '0'`)
  const revokedBoot = evaluate(`${widget}.update({token:${JSON.stringify(a.token)}})`); await heldFeedback.entered.promise
  const revokedA = await fetch(apiOrigin + `/api/widget/projects/${project.public_id}/session/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: 'Bearer ' + a.token }, body: '{}' }); assert.equal(revokedA.status, 200)
  heldFeedback.release.resolve(); await revokedBoot
  check(await evaluate(`${widget}.sessionToken === '' && ${widget}.dataset.readyCount === '0' && document.body.dataset.activeIntervals === '0'`), 'native CSAT revocation during boot clears identity without scheduling a poll or emitting ready')
  await boot(b.token)
  const revoked = await fetch(apiOrigin + `/api/widget/projects/${project.public_id}/session/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: 'Bearer ' + b.token }, body: '{}' }); assert.equal(revoked.status, 200)
  await evaluate(`${widget}.refresh()`)
  check(await evaluate(`${widget}.sessionToken === '' && !${widgetRoot}.querySelector('.csat-form') && !${widgetRoot}.querySelector('.csat-answer')`), 'current native session revocation clears Messenger feedback and private identity')
  check(widgetCookies.length === 0, 'compiled customer flow uses bearer identity without ambient customer cookies')
  const customerRuntimeErrors = runtimeErrors.slice(beforeWidgetErrors)
  await mkdir(artifacts, { recursive: true })
  await navigate(cdp, origin + '/_fixture/owner', { quietMs: 100, timeoutMs: 20000 }); await waitFor(() => evaluate(`document.querySelector('#csat-question') !== null`), 15000, { label: 'Owner settings return' })
  await input('#csat-question', 'Owner draft after another administrator edits'); await configure('Other administrator saved question', false); await click('Save satisfaction settings'); await text('Survey settings changed.')
  check(await evaluate(`document.querySelector('#csat-question').value === 'Owner draft after another administrator edits' && document.body.textContent.includes('Other administrator saved question') && document.body.textContent.includes('Your draft is preserved')`), 'settings revision conflict shows current saved question and preserves the local owner draft')
  await click('Keep draft against current revision'); await click('Save satisfaction settings'); await text('Satisfaction settings saved for this project.')
  check((await http(prefix + '/csat-settings', 'GET', undefined, owner.token)).data.settings.question === 'Owner draft after another administrator edits', 'explicit reviewed revision rebase saves through native optimistic concurrency')
  await input('#csat-question', 'Recover acknowledgement-only settings draft'); loseSettings = true; await click('Save satisfaction settings'); await text('Fixture settings acknowledgement lost after native commit.')
  const lostRevision = (await http(prefix + '/csat-settings', 'GET', undefined, owner.token)).data.settings.revision
  check(await evaluate(`document.querySelector('#csat-question').value === 'Recover acknowledgement-only settings draft' && document.body.textContent.includes('The saved settings changed')`), 'lost settings acknowledgement preserves draft and requires explicit current-revision reconciliation')
  await click('Use current saved settings')
  check((await http(prefix + '/csat-settings', 'GET', undefined, owner.token)).data.settings.revision === lostRevision, 'settings acknowledgement recovery does not repeat the already committed update')
  await click('Refresh satisfaction totals'); await waitFor(() => evaluate(`document.querySelector('[aria-label="Satisfaction totals"]')?.textContent.includes('2')`), 15000, { label: 'Aggregate satisfaction report' })
  check(await evaluate(`document.querySelector('[aria-label="Satisfaction totals"]').textContent.includes('3.00') && document.querySelector('[aria-label="Satisfaction totals"]').textContent.includes('50%') && !document.body.textContent.includes('PRIVATE-COMMENT-MARKER')`), 'project report renders exact aggregate counts/average/satisfaction without raw comments')
  await input('#csat-project', String(sibling.public_id)); await text('No satisfaction responses were recorded')
  check(await evaluate(`document.querySelector('[aria-label="Satisfaction totals"]').textContent.includes('No responses') && !document.body.textContent.includes('PRIVATE-COMMENT-MARKER')`), 'sibling project has independent empty aggregates without raw response leakage')
  await navigate(cdp, origin + '/_fixture/agent', { quietMs: 100, timeoutMs: 20000 }); await waitFor(() => evaluate(`document.querySelector('[aria-label="Satisfaction totals"]') !== null`), 15000, { label: 'Agent aggregate report' })
  check(await evaluate(`!document.querySelector('#csat-question') && !document.querySelector('#csat-enabled') && document.body.textContent.includes('Owners and admins configure')`), 'active agent reads aggregate reports without configuration controls')
  const image = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); await Bun.write(resolve(artifacts, 'report.png'), Buffer.from(image.data, 'base64'))
  console.info(`PASS CSAT browser functional (${assertions.length} checks)`)
  await Bun.write(resolve(artifacts, 'report.json'), JSON.stringify({ passed: runtimeErrors.length === 0, functionalPassed: true, assertions, runtimeErrors, customerRuntimeErrors, submissions: submissions.map(row => ({ score: row.score, revision: row.revision })), browser: (await cdp.send('Browser.getVersion')).product }, null, 2))
  assert.deepEqual(runtimeErrors, [], 'No browser runtime errors: retain native SSG compiler qualification gate')
  console.info('PASS CSAT browser qualification')
}
finally {
  heldFeedback?.release.resolve()
  if (browser) { await mkdir(artifacts, { recursive: true }); const state = await Promise.allSettled([browser.cdp.evaluate(`({text:document.body.textContent,widget:document.querySelector('hq-support-messenger')?.shadowRoot?.textContent,inputs:Array.from(document.querySelector('hq-support-messenger')?.shadowRoot?.querySelectorAll('input')||[]).map(el=>el.outerHTML)})`), browser.cdp.send('Page.captureScreenshot', { format: 'png' })]); await Bun.write(resolve(artifacts, 'diagnostic.json'), JSON.stringify({ assertions, runtimeErrors, state: state[0].status === 'fulfilled' ? state[0].value : 'Closed' }, null, 2)); if (state[1].status === 'fulfilled') await Bun.write(resolve(artifacts, 'latest.png'), Buffer.from(state[1].value.data, 'base64')) }
  host?.stop(true); boundary?.stop(true); api.stop(true); await browser?.close(); await closeSharedBrowsers(); await rm(output, { recursive: true, force: true })
}
process.exit(0)
