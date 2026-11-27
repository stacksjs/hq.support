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
import { Storage } from '@stacksjs/storage'
import { upload } from '../../app/Support/attachments'
import { markChannelReady, saveChannel } from '../../app/Support/channels'
import { applyChannelInbound, retainChannelInbound } from '../../app/Support/managed-channels'
import { one, query } from '../../app/Support/database'
import { usage } from '../../app/Support/service'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true); assert.equal((await runDatabaseMigration()).isOk, true); assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports(); await route.importRoutes()
const api = await route.serve({ port: 0, hostname: '127.0.0.1' }), apiOrigin = `http://127.0.0.1:${api.port}`
const root = resolve(import.meta.dir, '../..'), temporary = await mkdtemp(resolve(tmpdir(), 'hq-support-reopening-browser-')), artifacts = resolve(root, 'storage/framework/runtime/reopening-browser')
const output = resolve(temporary, 'site')
await mkdir(artifacts, { recursive: true })
for (const file of ['report.json', 'failure.json', 'failure.png', 'messenger-375.png', 'inbox-1440.png', 'older-messages-375-ar.png', 'agent-latest-messages-1440.png', 'messenger-history-375-dark.png', 'messenger-history-1440-light.png']) await rm(resolve(artifacts, file), { force: true })
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: resolve(temporary, 'private') } } })
let host: ReturnType<typeof Bun.serve> | undefined, boundary: ReturnType<typeof Bun.serve> | undefined, browser: Awaited<ReturnType<typeof launch>> | undefined
let cookie = '', csrf = '', lostAck = false, failHistory = false, failOlderMessages = false, malformedHistory: 'older' | 'recent' | 'cursor' | undefined, attachNext = false, lostImageAck = false
const submissions: { path: string, payload: any, status: number, destination?: string }[] = [], assertions: string[] = [], runtimeErrors: string[] = [], requests: string[] = []
let held: { id: string, release: ReturnType<typeof Promise.withResolvers<void>>, used: boolean, older?: boolean } | undefined
const check = (condition: unknown, message: string) => { assert.ok(condition, message); assertions.push(message) }
async function http(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(apiOrigin + '/api' + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any }
}
try {
  const seed = await fetch(apiOrigin + '/api/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const email = 'owner@reopening-browser.example.test', password = 'ReopeningBrowser2026!'
  assert.equal((await http('/register', 'POST', { name: 'Reopening owner', email, password, password_confirmation: password })).status, 200)
  const login = await http('/login', 'POST', { email, password }), owner = login.data.access_token ?? login.data.token
  const workspaceResult = await http('/support/workspaces', 'POST', { name: 'Continuation browser workspace' }, owner); assert.equal(workspaceResult.status, 201, JSON.stringify(workspaceResult)); const workspace = workspaceResult.data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Continuation product' }, owner)).data.project
  const otherWorkspace = (await http('/support/workspaces', 'POST', { name: 'Isolated workspace' }, owner)).data.workspace
  const other = (await http(`/support/workspaces/${otherWorkspace.id}/projects`, 'POST', { name: 'Isolated product' }, owner)).data.project
  const prefix = `/support/projects/${project.public_id}`, sdk = `/v1/projects/${project.public_id}`
  const keys = (await http(prefix + '/keys', 'POST', {}, owner)).data
  async function create(customer: string, subject: string, ageDays: number) {
    const session = (await http(sdk + '/sessions', 'POST', { externalId: customer }, keys.ingestKey)).data
    const result = await http(sdk + '/conversations', 'POST', { externalId: customer, subject, body: `Original history for ${subject}`, idempotencyKey: subject }, keys.ingestKey)
    assert.equal(result.status, 201); const id = String(result.data.conversation.id)
    assert.equal((await http(prefix + `/conversations/${id}`, 'PATCH', { status: 'closed' }, owner)).status, 200)
    await query('UPDATE support_conversations SET resolved_at = ? WHERE id = ?', [Date.now() - ageDays * 86400000, id])
    return { id, token: session.token }
  }
  const late = await create('late', 'Late original request', 8), recent = await create('recent', 'Recent original request', 6), refused = await create('refused', 'Allowance original request', 8), uncertain = await create('uncertain', 'History original request', 8)
  const settings = (await http(prefix + '/csat-settings', 'GET', undefined, owner)).data.settings
  assert.equal((await http(prefix + '/csat-settings', 'PATCH', { enabled: true, question: 'Original resolved request question', expectedRevision: settings.revision }, owner)).status, 200)
  const projectRow = (await one('SELECT * FROM support_projects WHERE id = ?', [project.id]))!
  const discordSubject = 'Discord browser image reply'
  const fixtureActor = (await http('/support/me', 'GET', undefined, owner)).data.user
  const channel = await saveChannel(projectRow, { provider: 'discord', configuration: { botToken: 'fixture-discord-bot', channelId: '456' } }, Number(fixtureActor.id))
  const ready = await markChannelReady(projectRow, channel.id, { externalId: '456', receipt: 'local browser provider fixture', expectedConfiguration: channel.configuration })
  await retainChannelInbound(projectRow, ready, 'discord-browser-event', { sender: '789', remoteKey: '456:789', body: 'Original Discord request', subject: discordSubject, timestamp: Date.now() }, {})
  await applyChannelInbound((await one('SELECT id FROM support_inbound WHERE project_id = ? AND provider = ?', [project.id, `channel:${ready.id}`]))!.id)
  const discordThread = (await one('SELECT id FROM support_conversations WHERE project_id = ? AND subject = ?', [project.id, discordSubject]))!
  const fixtureImage = resolve(output, 'fixture-image.png')
  const contact = (await one('SELECT * FROM support_contacts WHERE project_id = ? AND external_id = ?', [project.id, 'late']))!
  await upload(projectRow, late.id, new File(['predecessor attachment'], 'original-only.txt', { type: 'text/plain' }), 'original-file', contact)
  const agentFile = (await upload(projectRow, late.id, new File(['team-only attachment'], 'operator-only.txt', { type: 'text/plain' }), 'private-agent-file')).attachment
  for (let index = 0; index < 20; index++)
    await upload(projectRow, late.id, new File([`historic ${index}`], `file-${index}.txt`, { type: 'text/plain' }), `historic-file-${index}`)
  const browserLogin = await http('/login', 'POST', { email, password })
  const ownerCookie = browserSessionCookie((await startBrowserSession(browserLogin.data.access_token ?? browserLogin.data.token))!)
  const compiled = await generateStaticSite({ pagesDir: resolve(root, 'resources/views'), outputDir: output, publicDir: resolve(root, 'public'), partialsDir: resolve(root, 'resources/partials'), componentsDir: resolve(root, 'resources/components'), router: { enabled: false }, minify: false, cache: false, sitemap: false, robots: false }); assert.equal(compiled.failedCount, 0)
  const manifest = await Bun.file(resolve(root, 'public/widgets/manifest.json')).json()
  await Bun.write(fixtureImage, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVgAAAABJRU5ErkJggg==', 'base64'))
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === '/_fixture/owner') return new Response(null, { status: 303, headers: { location: '/app', 'set-cookie': ownerCookie } })
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers(request.headers); headers.delete('host')
      const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
      requests.push(`${request.method} ${url.pathname}${url.search}`)
      const response = await fetch(new URL(url.pathname + url.search, apiOrigin), { method: request.method, headers, ...(body === undefined ? {} : { body }) })
      const outgoing = new Headers(response.headers); outgoing.delete('content-encoding'); outgoing.delete('content-length')
      const pending = held
      const isOlderPage = url.searchParams.has('beforeMessage')
      if (request.method === 'GET' && pending && !pending.used && url.pathname.endsWith(`/conversations/${pending.id}`) && isOlderPage === Boolean(pending.older)) { pending.used = true; const saved = await response.arrayBuffer(); await pending.release.promise; return new Response(saved, { status: response.status, headers: outgoing }) }
      if (request.method === 'GET' && /\/conversations\/[^/]+$/.test(url.pathname) && malformedHistory === (isOlderPage ? 'older' : 'recent')) {
        malformedHistory = undefined
        await response.arrayBuffer()
        return new Response('<!doctype html><title>Gateway fallback</title>', { headers: { 'Content-Type': 'text/html' } })
      }
      if (request.method === 'GET' && malformedHistory === 'cursor' && isOlderPage) {
        malformedHistory = undefined
        return Response.json({ ...await response.json() as object, messagesNextCursor: '1' }, { headers: outgoing })
      }
      if (request.method === 'GET' && failOlderMessages && isOlderPage) {
        failOlderMessages = false
        await response.arrayBuffer()
        return Response.json({ message: 'Older messages temporarily unavailable.' }, { status: 503, headers: outgoing })
      }
      if (request.method === 'POST' && response.ok && lostImageAck && url.pathname.endsWith(`/conversations/${discordThread.id}/attachments`)) {
        lostImageAck = false
        await response.arrayBuffer()
        return Response.json({ message: 'Image stored; acknowledgement lost.' }, { status: 503, headers: outgoing })
      }
      if (request.method === 'POST' && url.pathname.includes('/widget/') && url.pathname.endsWith('/messages')) {
        const result = await response.clone().json() as any
        submissions.push({ path: url.pathname, payload: JSON.parse(new TextDecoder().decode(body)), status: response.status, destination: result.message?.conversation_id })
        if (response.ok && attachNext) { attachNext = false; await upload(projectRow, result.message.conversation_id, new File(['successor attachment'], 'successor-only.txt', { type: 'text/plain' }), 'successor-file', contact) }
        if (response.ok && lostAck) { lostAck = false; await response.arrayBuffer(); return Response.json({ message: 'Native reply committed; acknowledgement lost.' }, { status: 503, headers: outgoing }) }
      }
      if (request.method === 'GET' && failHistory && /\/conversations\/[^/]+$/.test(url.pathname)) { failHistory = false; await response.arrayBuffer(); return Response.json({ message: 'History temporarily unavailable.' }, { status: 503, headers: outgoing }) }
      return new Response(response.body, { status: response.status, headers: outgoing })
    }
    if (url.pathname === '/widget') return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continuation customer proof</title><link rel="stylesheet" href="/host.css"></head><body><h1>Customer support continuation</h1><hq-support-messenger></hq-support-messenger><script type="module" src="/entry.js"></script></body></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self' ${manifest.csp.styleSrc.join(' ')}; connect-src 'self' ${boundary!.url.origin}; base-uri 'none'; object-src 'none'` } })
    if (url.pathname === '/host.css') return new Response('body{font:14px system-ui;background:#fafbf9;color:#20332f}hq-support-messenger{position:fixed;right:16px;bottom:16px}', { headers: { 'content-type': 'text/css' } })
    if (url.pathname === '/entry.js') return new Response(`await import('/widgets/bundle.js'); const messenger=document.querySelector('hq-support-messenger'); messenger.addEventListener('delivery',event=>messenger.dataset.lastDelivery=JSON.stringify(event.detail));`, { headers: { 'content-type': 'text/javascript' } })
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
    const path = url.pathname === '/app' ? '/app.html' : url.pathname, file = resolve(output, '.' + decodeURIComponent(path))
    if (!file.startsWith(output + sep)) return new Response('Forbidden', { status: 403 })
    return await Bun.file(file).exists() ? new Response(Bun.file(file), { headers: path.endsWith('.html') ? { 'content-type': 'text/html', 'cache-control': 'no-store' } : {} }) : new Response('Not found', { status: 404 })
  }
  boundary = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  host = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  const origin = host.url.origin
  assert.equal((await http(prefix, 'PATCH', { allowedOrigins: [origin], anonymousEnabled: false }, owner)).status, 200)
  browser = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH, startTimeoutMs: 60000, commandTimeoutMs: 20000 })
  const cdp = browser.cdp
  cdp.on('Runtime.exceptionThrown', event => runtimeErrors.push(String(event.exceptionDetails.exception?.description || event.exceptionDetails.text)))
  await cdp.intercept([{ urlPattern: '*' }], async (event, session) => { const url = new URL(event.request.url); if (['http:', 'https:'].includes(url.protocol) && ![origin, boundary!.url.origin].includes(url.origin)) await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' }); else await session.send('Fetch.continueRequest', { requestId: event.requestId }) })
  const evaluate = (expression: string) => cdp.evaluate(expression), widget = `document.querySelector('hq-support-messenger')`, shadow = `${widget}.shadowRoot`
  const wait = (expression: string, label: string) => waitFor(() => evaluate(expression), 15000, { label })
  const click = (label: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(label)})?.click()`)
  const input = (selector: string, value: string) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  async function boot(token: string) { await navigate(cdp, origin + '/widget', { quietMs: 100, timeoutMs: 20000 }); await evaluate(`(async()=>{await customElements.whenDefined('hq-support-messenger');await ${widget}.boot({url:${JSON.stringify(boundary!.url.origin)},project:${JSON.stringify(project.public_id)},token:${JSON.stringify(token)}});${widget}.open()})()`); await wait(`${shadow}.querySelector('#support-body') !== null`, 'Messenger ready') }
  async function send(body: string) { await evaluate(`(()=>{const field=${shadow}.querySelector('#support-body');field.value=${JSON.stringify(body)};field.dispatchEvent(new Event('input',{bubbles:true}));${shadow}.querySelector('.send-row button').click()})()`); await wait(`!${widget}.pending`, 'Reply completed') }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
  await boot(late.token)
  await wait(`${shadow}.textContent.includes('Original resolved request question')`, 'Original CSAT shown')
  const typingTab = crypto.randomUUID()
  assert.equal((await http(prefix + `/conversations/${late.id}/presence`, 'POST', { tabId: typingTab, state: 'composing', sequence: 1 }, owner)).status, 200)
  await wait(`${shadow}.querySelector('.typing-status').textContent.trim() === 'Support is typing…'`, 'Server-identified customer sees typing in the original request')
  held = { id: late.id, release: Promise.withResolvers<void>(), used: false }
  await evaluate(`void ${widget}.refresh()`); await waitFor(() => held!.used, 15000, { label: 'Predecessor refresh held after native read' })
  const before = await usage(Number(workspace.id), 'conversations')
  attachNext = true; await send('Late continuation from browser')
  const destination = submissions.at(-1)!.destination!
  check(destination !== late.id && await evaluate(`${widget}.conversationId === ${JSON.stringify(destination)}`), 'late reply selects the actual committed destination')
  check(await evaluate(`${shadow}.querySelector('.typing-status').textContent.trim() === ''`), 'typing from the previous conversation clears when the customer changes conversations')
  assert.equal((await http(prefix + `/conversations/${destination}/presence`, 'POST', { tabId: typingTab, state: 'composing', sequence: 2 }, owner)).status, 200)
  await wait(`${shadow}.querySelector('.typing-status').textContent.trim() === 'Support is typing…'`, 'Signed-in customer tracks new conversation typing')
  check(true, 'the continuation rebinds typing to its own conversation across the widget origin boundary')
  check(await evaluate(`!${shadow}.querySelector('.csat-form') && !${shadow}.querySelector('.csat-answer') && !${shadow}.textContent.includes('Original history for Late original request')`), 'continuation clears predecessor history and CSAT before showing destination history')
  held.release.resolve(); await wait(`!${widget}._refreshRequest`, 'Held predecessor refresh completed')
  check(await evaluate(`${widget}.thread.some(message=>message.body==='Late continuation from browser') && !${widget}.thread.some(message=>message.body==='Original history for Late original request')`), 'held predecessor refresh cannot overwrite the destination thread in the same customer generation')
  check(await evaluate(`${widget}.attachments.some(file=>file.fileName==='successor-only.txt') && !${widget}.attachments.some(file=>file.fileName==='original-only.txt')`), 'destination history fetch loads only its own attachment metadata')
  check(await usage(Number(workspace.id), 'conversations') === before + 1 && (await one('SELECT status FROM support_conversations WHERE id = ?', [late.id]))!.status === 'closed', 'late browser continuation charges one admission and leaves its predecessor resolved')
  await mkdir(artifacts, { recursive: true }); const widgetImage = await cdp.send('Page.captureScreenshot', { format: 'png' }); await Bun.write(resolve(artifacts, 'messenger-375.png'), Buffer.from(widgetImage.data, 'base64'))
  await boot(recent.token); const beforeRecent = await usage(Number(workspace.id), 'conversations'); await send('Recent browser reply')
  check(await evaluate(`${widget}.conversationId === ${JSON.stringify(recent.id)}`) && await usage(Number(workspace.id), 'conversations') === beforeRecent, 'within seven days reopens the original request without new usage')
  // A separate >7-day request loses its native committed acknowledgement, then replays once.
  await boot(uncertain.token); lostAck = true; const beforeRetry = await usage(Number(workspace.id), 'conversations'); await send('Preserved uncertain browser body')
  check(await evaluate(`${shadow}.querySelector('#support-body').value === 'Preserved uncertain browser body' && !!${widget}._sendKey`), 'lost acknowledgement preserves the exact customer draft and retry key')
  const retryStart = submissions.length - 1; await send('Preserved uncertain browser body')
  const original = submissions[retryStart]!, replay = submissions[retryStart + 1]!
  check(JSON.stringify(original.payload) === JSON.stringify(replay.payload) && original.path === replay.path && await usage(Number(workspace.id), 'conversations') === beforeRetry + 1 && Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ? AND body = ?', [replay.destination, replay.payload.body]))!.count) === 1, 'one retry recovers the same committed body, key and destination without a second message or admission')
  // Already linked old URL returns the destination even without continuedFromId.
  await evaluate(`${widget}.conversationId=${JSON.stringify(uncertain.id)}`); await send('Later browser reply through old URL')
  check(await evaluate(`${widget}.conversationId === ${JSON.stringify(replay.destination)}`), 'old URL reply adopts message.conversation_id without relying on continuedFromId')
  failHistory = true; await send('Saved despite read failure')
  check(await evaluate(`${shadow}.textContent.includes('Your message was saved') && ${shadow}.querySelector('#support-body').value === '' && JSON.parse(${widget}.dataset.lastDelivery).status === 'stored'`), 'post-commit history failure reports the actual stored status and clears only the accepted draft')
  await boot(refused.token)
  await query("UPDATE support_workspaces SET plan = 'free', stacks_verified = ?, deployment_verified = ? WHERE id = ?", [true, true, workspace.id]); await query("UPDATE support_usage SET used = 120 WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id])
  await send('Exact allowance-refused draft'); const refusedStart = submissions.length - 1
  const refusedKey = await evaluate(`${widget}._sendKey`); await send('Exact allowance-refused draft')
  check(submissions[refusedStart]!.status === 402 && submissions[refusedStart + 1]!.status === 402 && JSON.stringify(submissions[refusedStart]!.payload) === JSON.stringify(submissions[refusedStart + 1]!.payload) && await evaluate(`${widget}._sendKey === ${JSON.stringify(refusedKey)} && ${shadow}.querySelector('#support-body').value === 'Exact allowance-refused draft' && ${widget}.conversationId === ${JSON.stringify(refused.id)}`) && !(await one('SELECT continuation_id FROM support_conversations WHERE id = ?', [refused.id]))!.continuation_id, 'real 402 allowance refusal preserves the exact body, key and predecessor and creates no successor')
  await query("UPDATE support_workspaces SET plan = 'trial', trial_ends_at = ? WHERE id = ?", [Date.now() + 86400000, workspace.id])
  await query("UPDATE support_usage SET used = 10 WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id])
  const oversized = 'Oversized body '.repeat(1500)
  async function sendOversized() { await evaluate(`(async()=>{const field=${shadow}.querySelector('#support-body');field.value=${JSON.stringify(oversized)};field.dispatchEvent(new Event('input',{bubbles:true}));await ${widget}.send({preventDefault(){},target:field.form})})()`) }
  await sendOversized(); const invalidKey = await evaluate(`${widget}._sendKey`); await sendOversized()
  check(submissions.at(-1)!.status === 422 && JSON.stringify(submissions.at(-1)!.payload) === JSON.stringify(submissions.at(-2)!.payload) && await evaluate(`${widget}._sendKey === ${JSON.stringify(invalidKey)} && ${shadow}.querySelector('#support-body').value === ${JSON.stringify(oversized)}`), 'real 422 payload refusal through the public send method preserves the exact oversized draft and key')
  await query('UPDATE support_conversations SET continuation_id = ? WHERE id = ?', [refused.id, refused.id])
  await send('Exact allowance-refused draft'); const conflictKey = await evaluate(`${widget}._sendKey`); await send('Exact allowance-refused draft')
  check(submissions.at(-1)!.status === 409 && JSON.stringify(submissions.at(-1)!.payload) === JSON.stringify(submissions.at(-2)!.payload) && await evaluate(`${widget}._sendKey === ${JSON.stringify(conflictKey)} && ${shadow}.querySelector('#support-body').value === 'Exact allowance-refused draft'`), 'real 409 invalid lineage preserves the exact refused draft and key')
  await query('UPDATE support_conversations SET continuation_id = NULL, resolved_at = ? WHERE id = ?', [Date.now() - 8 * 86400000, refused.id])

  const screenshot = async (name: string, width?: number, height?: number) => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const png = Buffer.from(image.data, 'base64')
    if (width && height) assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [width, height], name)
    await Bun.write(resolve(artifacts, name + '.png'), png)
  }
  const archiveContact = (await one('SELECT id FROM support_contacts WHERE project_id = ? AND external_id = ?', [project.id, 'recent']))!
  await query("INSERT INTO support_messages (workspace_id, project_id, conversation_id, contact_id, body, visibility, author_type, delivery_status) VALUES (?, ?, ?, ?, 'Staff-only archive note', 'internal', 'agent', 'imported')", [workspace.id, project.id, recent.id, archiveContact.id])
  await query(`WITH RECURSIVE part(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM part WHERE n < 620)
    INSERT INTO support_messages (workspace_id, project_id, conversation_id, contact_id, body, visibility, author_type, delivery_status)
    SELECT ?, ?, ?, ?, 'Imported message ' || n, 'public', 'customer', 'imported' FROM part`,
  [workspace.id, project.id, recent.id, archiveContact.id])
  await boot(recent.token)
  const history = `${shadow}.querySelector('#support-history')`
  const olderButton = `${shadow}.querySelector('#support-older-messages')`
  const olderRequests = () => requests.filter(path => path.startsWith(`GET /api/widget/projects/${project.public_id}/conversations/${recent.id}?beforeMessage=`))
  const loadOlder = () => evaluate(`${olderButton}.click()`)
  check(await evaluate(`${history}.querySelectorAll('article').length === 500 && !${history}.textContent.includes('Original history for Recent original request')`), 'customer detail bounds the initial long transcript')
  await wait(olderButton, 'Customer can request earlier messages')
  await evaluate(`(()=>{const field=${shadow}.querySelector('#support-body');field.value='Draft survives history';field.dispatchEvent(new Event('input',{bubbles:true}));${history}.scrollTop=90})()`)
  malformedHistory = 'older'
  await loadOlder()
  await wait(`${olderButton}?.textContent.trim() === 'Retry loading earlier messages'`, 'An invalid HTTP 200 response keeps the retry control')
  malformedHistory = 'cursor'
  await loadOlder()
  await wait(`${olderButton}?.textContent.trim() === 'Retry loading earlier messages'`, 'A cursor that skips history keeps the retry control')
  failOlderMessages = true
  await loadOlder()
  await wait(`${olderButton}?.textContent.trim() === 'Retry loading earlier messages'`, 'Customer can retry a failed cursor')
  check(await evaluate(`${history}.querySelectorAll('article').length === 500 && ${shadow}.querySelector('#support-body').value === 'Draft survives history'`), 'failed cursor keeps the visible messages and draft')
  const anchor = await evaluate(`${history}.querySelector('article').getBoundingClientRect().top - ${history}.getBoundingClientRect().top`)
  await loadOlder()
  await wait(`${history}.querySelectorAll('article').length === 550 && ${olderButton}?.getAttribute('aria-disabled') === 'false'`, 'One bounded older page is visible')
  check(olderRequests().length === 4 && new Set(olderRequests()).size === 1 && new URLSearchParams(olderRequests()[0]!.split('?')[1]).get('limit') === '50', 'each failure retries the identical cursor and a 50-row request')
  await wait(`Math.abs(${history}.querySelectorAll('article')[50].getBoundingClientRect().top - ${history}.getBoundingClientRect().top - ${Number(anchor)}) < 3`, 'Prepending earlier messages preserves the reading position')
  check(await evaluate(`${shadow}.querySelector('#support-body').value === 'Draft survives history'`), 'prepending preserves the unsent draft')
  const readingScroll = await evaluate(`${history}.scrollTop`)
  malformedHistory = 'recent'
  await evaluate(`${widget}.refresh()`)
  check(await evaluate(`${history}.querySelectorAll('article').length === 550 && ${olderButton} && ${shadow}.querySelector('#support-body').value === 'Draft survives history'`), 'an invalid recent snapshot preserves the loaded archive, cursor, and draft')
  assert.equal((await http(prefix + `/conversations/${recent.id}/messages`, 'POST', { body: 'Live agent archive reply', idempotencyKey: 'archive-agent-reply' }, owner)).status, 201)
  await evaluate(`${widget}.refresh()`)
  check(await evaluate(`${history}.lastElementChild.textContent.includes('Live agent archive reply') && Math.abs(${history}.scrollTop-${Number(readingScroll)})<3`), 'a newly delivered agent reply preserves the archive reading position')
  await send('Reply after reading the archive')
  check(await evaluate(`${history}.querySelectorAll('article').length === 552 && ${history}.lastElementChild.textContent.includes('Reply after reading the archive')`), 'live refresh and a real reply keep the loaded earlier page')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true })
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await evaluate(`${widget}.update({locale:'ar'})`)
  await wait(`${olderButton}?.textContent.trim() === 'عرض الرسائل السابقة'`, 'The customer history button is localized on mobile')
  check(await evaluate(`innerWidth === 375 && innerHeight === 812 && navigator.maxTouchPoints === 1 && ${shadow}.querySelector('.messenger').dir === 'rtl' && ${olderButton}.getBoundingClientRect().width > 80 && document.documentElement.scrollWidth <= innerWidth && getComputedStyle(${olderButton}).color === 'rgb(131, 217, 199)'`), 'narrow Arabic Messenger uses the dark theme and fits without horizontal overflow')
  await screenshot('messenger-history-375-dark', 375, 812)
  await cdp.send('Accessibility.enable')
  const customerAccessibility = await cdp.send('Accessibility.getFullAXTree')
  check(customerAccessibility.nodes.some(node => node.role?.value === 'button' && node.name?.value === 'عرض الرسائل السابقة'), 'Chromium exposes the translated customer history button')
  held = { id: recent.id, release: Promise.withResolvers<void>(), used: false, older: true }
  const historyTouch = await evaluate(`(()=>{const rect=${olderButton}.getBoundingClientRect();return {x:rect.left + rect.width / 2,y:rect.top + rect.height / 2}})()`) as { x: number; y: number }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [historyTouch] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await waitFor(() => held!.used, 15000, { label: 'Older page held after native read' })
  await wait(`${olderButton}?.getAttribute('aria-disabled') === 'true'`, 'History controls indicate an in-flight request')
  await loadOlder()
  await evaluate(`${widget}.update({token:${JSON.stringify(refused.token)},locale:'en'})`)
  held.release.resolve()
  await wait(`${history}.textContent.includes('Original history for Allowance original request')`, 'Replacement session history shown')
  check(olderRequests().length === 5 && await evaluate(`!${olderButton} && !${history}.textContent.includes('Imported message')`), 'double activation and a late history response cannot cross the customer session boundary')
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await boot(recent.token)
  await evaluate(`${widget}.update({locale:'de'})`)
  await wait(`${olderButton}?.textContent.trim() === 'Frühere Nachrichten anzeigen'`, 'The desktop control has its German label')
  await evaluate(`${widget}.update({locale:'en'})`)
  await wait(`${olderButton}?.textContent.trim() === 'Show earlier messages'`, 'The desktop light control has its English label')
  await screenshot('messenger-history-1440-light', 1440, 1000)
  for (let count = 550; count <= 600; count += 50) {
    await loadOlder()
    await wait(`${history}.querySelectorAll('article').length === ${count} && ${olderButton}?.getAttribute('aria-disabled') === 'false'`, 'Another older page is visible')
  }
  await evaluate(`${olderButton}.focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(`!${olderButton} && ${history}.querySelector('article').textContent.includes('Original history for Recent original request')`, 'Keyboard reaches the beginning and removes the exhausted cursor')
  check(await evaluate(`(()=>{const ids=Array.from(${history}.querySelectorAll('article')).map(row=>Number(row.dataset.messageId));return ids.length===624 && ids.every((id,index)=>id>0 && (!index || id>ids[index-1])) && !${history}.textContent.includes('Staff-only archive note')})()`), 'original public history is chronological and unique and excludes the staff note')
  await wait(`${shadow}.activeElement === ${history}`, 'Keyboard focus remains on the exhausted history')
  const latestButton = `${shadow}.querySelector('#support-latest-messages')`
  await evaluate(`(()=>{const field=${shadow}.querySelector('#support-body');field.value='Draft survives the burst';field.dispatchEvent(new Event('input',{bubbles:true}));${history}.scrollTop=120})()`)
  await query(`WITH RECURSIVE part(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM part WHERE n < 521)
    INSERT INTO support_messages (workspace_id, project_id, conversation_id, contact_id, body, visibility, author_type, delivery_status)
    SELECT ?, ?, ?, ?, 'Burst reply ' || n, 'public', 'agent', 'imported' FROM part`,
  [workspace.id, project.id, recent.id, archiveContact.id])
  await evaluate(`${widget}.refresh()`)
  check(await evaluate(`${history}.querySelectorAll('article').length === 624 && ${history}.textContent.includes('Original history for Recent original request') && Math.abs(${history}.scrollTop-120)<3`), 'a disjoint recent page leaves the opened archive and reading position intact')
  await wait(`${latestButton}?.textContent.trim() === 'Show latest messages'`, 'A disjoint recent page offers an explicit jump to the latest messages')
  await evaluate(`${widget}.refresh()`)
  check(await evaluate(`${latestButton} && !${olderButton} && ${shadow}.querySelector('#support-body').value === 'Draft survives the burst' && !${history}.textContent.includes('Burst reply')`), 'repeated polling leaves the archive and draft visible without splicing a gap into the transcript')
  await evaluate(`${latestButton}.focus();${latestButton}.click()`)
  await wait(`!${latestButton} && ${olderButton} && ${history}.lastElementChild.textContent.trim().endsWith('Burst reply 521')`, 'The customer can jump explicitly to the newest recent page')
  check(await evaluate(`${shadow}.activeElement === ${history} && ${history}.scrollHeight-${history}.clientHeight-${history}.scrollTop<3 && ${shadow}.querySelector('#support-body').value === 'Draft survives the burst'`), 'the latest action focuses the newest messages and leaves the unsent draft intact')
  await loadOlder()
  await wait(`${history}.textContent.includes('Reply after reading the archive') && ${history}.querySelectorAll('article').length === 550`, 'Paging from the latest view can cross the previously unloaded gap')
  held = { id: recent.id, release: Promise.withResolvers<void>(), used: false }
  await evaluate(`void ${widget}.refresh()`)
  await waitFor(() => held?.used, 10000, { label: 'Customer recent page is held before retention' })
  await query("UPDATE support_messages SET body = '[Removed by retention policy]' WHERE project_id = ? AND conversation_id = ?", [project.id, recent.id])
  await query("UPDATE support_conversations SET subject = '[Removed by retention policy]' WHERE id = ? AND project_id = ?", [recent.id, project.id])
  await loadOlder()
  await wait(`${history}.querySelectorAll('article').length === 500 && ${history}.textContent.includes('Removed by retention policy')`, 'The changed older page refreshes the recent history while a stale poll is held')
  held.release.resolve()
  held = undefined
  check(await evaluate(`!${history}.textContent.includes('Reply after reading the archive') && !${history}.textContent.includes('Burst reply') && ${shadow}.querySelector('#support-body').value === 'Draft survives the burst'`), 'rewritten history cancels the stale recent page and preserves the customer draft')

  await query(`WITH RECURSIVE part(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM part WHERE n < 550)
    INSERT INTO support_messages (workspace_id, project_id, conversation_id, contact_id, body, visibility, author_type, delivery_status)
    SELECT ?, ?, ?, ?, 'Imported history part ' || n, 'public', 'customer', 'imported' FROM part`,
  [workspace.id, project.id, late.id, contact.id])
  const agentHistory = await http(prefix + `/conversations/${late.id}`, 'GET', undefined, owner)
  check(agentHistory.status === 200 && agentHistory.data.messages.length === 500 && agentHistory.data.messagesNextCursor, 'native detail bounds a long imported transcript and returns an older cursor')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await navigate(cdp, origin + '/_fixture/owner', { quietMs: 100, timeoutMs: 20000 }); await wait(`document.querySelector('#project')?.value === ${JSON.stringify(project.public_id)}`, 'Native inbox ready')
  await click('All'); await wait(`Array.from(document.querySelectorAll('.conversation-row')).some(el=>el.textContent.includes('Late original request') && el.textContent.includes('Resolved'))`, 'Original request listed')
  await evaluate(`Array.from(document.querySelectorAll('.conversation-row')).find(el=>el.textContent.includes('Late original request') && el.textContent.includes('Resolved')).click()`); await wait(`document.querySelector('#reply') && !document.querySelector('#reply').disabled`, 'Original request selected')
  await wait(`document.querySelector('#load-older-messages')`, 'Agent can request older transcript messages')
  const messageCount = `document.querySelectorAll('.thread-scroll article').length`
  check(await evaluate(`${messageCount} === 500`), 'the agent first sees only the newest bounded transcript page')
  await input('#inbox-language', 'de')
  await wait(`document.querySelector('#load-older-messages')?.textContent.trim() === 'Ältere Nachrichten laden'`, 'German history control is translated')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
  await input('#inbox-language', 'ar')
  await wait(`document.querySelector('#load-older-messages')?.textContent.trim() === 'تحميل الرسائل الأقدم'`, 'Arabic history control is translated')
  check(await evaluate(`document.querySelector('#main').dir === 'rtl' && document.documentElement.scrollWidth <= innerWidth`), 'the earlier-message control fits the Arabic phone layout')
  const olderImage = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(resolve(artifacts, 'older-messages-375-ar.png'), Buffer.from(olderImage.data, 'base64'))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await input('#inbox-language', 'en')
  await wait(`document.querySelector('#load-older-messages')?.textContent.trim() === 'Load older messages'`, 'English history control is restored')
  failOlderMessages = true
  await click('Load older messages')
  await wait(`document.querySelector('#older-messages-error')`, 'Older transcript failure appears with its retry control')
  check(await evaluate(`${messageCount} === 500 && !!document.querySelector('#load-older-messages')`), 'a failed page preserves the loaded messages and cursor')
  await click('Load older messages')
  await wait(`${messageCount} === 550`, 'Retry prepends the first fifty earlier messages')
  await evaluate(`document.querySelector('#load-older-messages').focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(`${messageCount} === 551 && !document.querySelector('#load-older-messages')`, 'Final cursor restores the original message')
  await wait(`document.activeElement?.matches('.thread-message') && document.activeElement.textContent.includes('Original history for Late original request')`, 'Keyboard focus moves to the first newly loaded message')
  check(await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.thread-scroll article'))
    return rows[0].textContent.includes('Original history for Late original request') && rows.at(-1).textContent.includes('Imported history part 550') && new Set(rows.map(row => row.id)).size === 551
  })()`), 'all 551 messages render once in native transcript order')
  await wait(`document.querySelector('#conversation-attachments')?.querySelectorAll('a').length === 20`, 'First attachment page is visible to the agent')
  check(await evaluate(`!document.querySelector('#conversation-attachments').textContent.includes('operator-only.txt')`), 'older team-only files stay outside the first page')
  await evaluate(`document.querySelector('#load-older-attachments').focus()`)
  await click('Load older attachments')
  await wait(`document.querySelector('#conversation-attachments')?.querySelectorAll('a').length === 22`, 'Older files attach to the same conversation panel')
  await wait(`document.activeElement?.textContent.trim() === 'operator-only.txt'`, 'The last page moves focus from the removed control to its first new file')
  const downloaded = await evaluate(`(async()=>{const link=[...document.querySelectorAll('#conversation-attachments a')].find(a=>a.textContent.includes('operator-only.txt'));const response=await fetch(link.href);return { hasDownload:link.hasAttribute('download'), path:new URL(link.href).pathname, status:response.status, disposition:response.headers.get('content-disposition'), body:await response.text() }})()`)
  check(downloaded.hasDownload && downloaded.path.endsWith('/attachments/' + agentFile.id) && downloaded.status === 200 && downloaded.disposition?.startsWith('attachment;') && downloaded.body === 'team-only attachment', `the native agent link retrieves the exact private file through the scoped route ${JSON.stringify(downloaded)}`)
  await input('#reply-mode', 'internal')
  await input('#reply', 'New internal note while reading older history')
  await evaluate(`document.querySelector('.reply-composer button[type=submit]').click()`)
  await wait(`${messageCount} === 552 && !document.querySelector('#reply').disabled`, 'Sending a note refreshes the bounded head without dropping loaded history')
  check(await evaluate(`document.querySelector('.thread-scroll article').textContent.includes('Original history for Late original request') && !document.querySelector('#load-older-messages')`), 'the refreshed transcript keeps the restored original and exhausted cursor')
  await input('#reply-mode', 'public')
  await input('#reply', 'Agent draft survives the burst')
  await query(`WITH RECURSIVE part(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM part WHERE n < 521)
    INSERT INTO support_messages (workspace_id, project_id, conversation_id, contact_id, body, visibility, author_type, delivery_status)
    SELECT ?, ?, ?, ?, 'Transcript burst ' || n, 'public', CASE WHEN n = 1 THEN 'agent' ELSE 'customer' END, 'imported' FROM part`,
  [workspace.id, project.id, late.id, contact.id])
  await wait(`document.querySelector('#load-latest-messages')?.textContent.trim() === 'Show latest messages'`, 'Agent is notified when a recent page no longer overlaps the archive')
  check(await evaluate(`${messageCount} === 552 && document.querySelector('.thread-scroll article').textContent.includes('Original history for Late original request') && document.querySelector('#reply').value === 'Agent draft survives the burst'`), 'a disjoint presence refresh keeps the archive and public draft intact')
  await wait(`Array.from(document.querySelectorAll('.reply-composer button')).some(button=>button.textContent.includes('Send my reply anyway') && button.disabled)`, 'Blind send remains disabled when the newest reply is outside the archive')
  await click('Send my reply anyway')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ? AND body = ?', [late.id, 'Agent draft survives the burst']))!.count) === 0, 'the agent draft cannot send until the unread page is opened')
  await screenshot('agent-latest-messages-1440')
  held = { id: late.id, release: Promise.withResolvers<void>(), used: false }
  await evaluate(`document.querySelector('#load-latest-messages').focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(() => held?.used, 10000, { label: 'Keyboard latest-message request is in flight' })
  await evaluate(`document.querySelector('#reply').focus()`)
  held.release.resolve()
  held = undefined
  await wait(`!document.querySelector('#load-latest-messages') && ${messageCount} === 500 && document.querySelector('.thread-scroll article:last-child').textContent.includes('Transcript burst 521')`, 'Keyboard opens the newest page')
  check(await evaluate(`document.activeElement?.id === 'reply'`), 'the asynchronous latest page respects focus moved to the draft')
  check(await evaluate(`document.querySelector('#reply').value === 'Agent draft survives the burst'`), 'the draft survives explicit navigation to the latest page')
  check(await evaluate(`document.querySelector('#agent-reply-outside-page') && Array.from(document.querySelectorAll('.reply-composer button')).some(button=>button.textContent.includes('Send my reply anyway') && button.disabled)`), 'a teammate reply beyond the latest page still blocks public sending')
  await click('Load older messages')
  await wait(`${messageCount} === 550 && document.querySelector('.thread-scroll').textContent.includes('New internal note while reading older history') && document.querySelector('#agent-reply-outside-page') === null`, 'Earlier pages cross the gap and reveal the previously hidden teammate reply')
  await wait(`Array.from(document.querySelectorAll('.reply-composer button')).some(button=>button.textContent.includes('Send my reply anyway') && !button.disabled)`, 'The existing review confirmation becomes available after opening the newest page')
  await click('Send my reply anyway')
  await wait(`document.querySelector('.thread-scroll article:last-child').textContent.includes('Agent draft survives the burst') && document.querySelector('#reply').value === ''`, 'The reviewed draft is posted over native HTTP')
  check(Number((await one("SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ? AND body = ? AND visibility = 'public'", [late.id, 'Agent draft survives the burst']))!.count) === 1, 'the reviewed public draft is stored exactly once')
  await input('#reply', 'Staff draft on predecessor'); await input('#reply-mode', 'internal')
  await evaluate(`document.querySelector('[aria-label="Refresh inbox"]').click()`); await wait(`!document.querySelector('[aria-label="Refresh inbox"]').disabled`, 'Inbox refreshed')
  check(await evaluate(`document.querySelector('#reply').value === 'Staff draft on predecessor' && document.querySelector('.thread-breadcrumb').textContent.includes('Resolved')`), 'refresh never silently moves the selected historical request or its staff draft')
  await evaluate(`document.querySelector('.conversation-row.is-current').click()`)
  await wait(`${messageCount} === 500 && document.querySelector('#load-older-messages') && !document.querySelector('#reply').disabled`, 'Reselection restores the newest bounded page')
  held = { id: late.id, release: Promise.withResolvers<void>(), used: false, older: true }
  await click('Load older messages')
  await waitFor(() => held?.used, 10000, { label: 'Older transcript response held before navigation' })
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="Linked requests"] button')).find(el=>el.textContent.includes('Next')).click()`); await wait(`document.querySelector('.thread-scroll').textContent.includes('Late continuation from browser')`, 'Explicit next request navigation')
  held.release.resolve()
  held = undefined
  check(await evaluate(`!document.querySelector('.thread-scroll').textContent.includes('Imported history part') && !document.querySelector('#load-older-messages')`), 'a delayed earlier page cannot populate the linked successor')
  check(await evaluate(`document.querySelector('#reply').value === '' && document.querySelector('#reply-mode').value === 'public'`), 'explicit next navigation starts with that request own empty public draft')
  check(await evaluate(`document.querySelector('#conversation-attachments')?.textContent.includes('successor-only.txt') && !document.querySelector('#conversation-attachments')?.textContent.includes('operator-only.txt')`), 'linked navigation shows only the destination attachments')
  await input('#reply', 'Staff draft on successor')
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="Linked requests"] button')).find(el=>el.textContent.includes('Previous')).click()`); await wait(`document.querySelector('#reply').value === 'Staff draft on predecessor'`, 'Previous staff draft restored')
  check(await evaluate(`document.querySelector('#reply-mode').value === 'internal' && !document.querySelector('.thread-scroll').textContent.includes('Late continuation from browser')`), 'previous navigation restores its original internal draft and only predecessor history')
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="Linked requests"] button')).find(el=>el.textContent.includes('Next')).click()`); await wait(`document.querySelector('#reply').value === 'Staff draft on successor'`, 'Successor staff draft restored')
  const inboxImage = await cdp.send('Page.captureScreenshot', { format: 'png' }); await Bun.write(resolve(artifacts, 'inbox-1440.png'), Buffer.from(inboxImage.data, 'base64'))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
  await input('#inbox-language', 'ar')
  await wait(`document.querySelector('#main').lang === 'ar' && document.querySelector('h1').textContent === 'صندوق الوارد'`, 'Localized RTL inbox ready')
  check(await evaluate(`document.querySelector('#main').dir === 'rtl' && document.documentElement.scrollWidth <= innerWidth && document.querySelector('#reply').value === 'Staff draft on successor'`), 'narrow Arabic inbox fits and preserves the selected request and reply draft')
  check(await evaluate(`document.querySelector('#reply-mode option').textContent === 'رد علني' && document.querySelector('.thread-scroll').getAttribute('aria-label') === 'رسائل المحادثة' && document.querySelector('.thread-scroll time').textContent === new Intl.DateTimeFormat('ar', { month: 'short', day: 'numeric' }).format(new Date(document.querySelector('.thread-scroll time').dateTime))`), 'the agent sees localized composer, history and dates')
  await wait(`document.querySelector('#customer-details[role=dialog]') && document.querySelector('#customer-details-toggle[aria-expanded=false]')`, 'Mobile details mode settles before opening the dialog')
  await evaluate(`document.querySelector('#customer-details-toggle').click()`)
  await wait(`document.querySelector('#customer-details[role=dialog][aria-modal=true]') && document.querySelector('#conversation-attachments-title')?.textContent.trim() === 'المرفقات'`, 'The mobile RTL details dialog exposes the translated attachments heading')
  check(await evaluate(`document.querySelector('#conversation-attachments a').textContent.trim() === 'successor-only.txt'`), 'the mobile details dialog keeps the selected file available')
  await evaluate(`document.querySelector('#customer-details-close').click()`)
  await wait(`!document.querySelector('#customer-details[aria-modal=true]')`, 'The details dialog closes before editing the reply')
  await input('#reply', 'تمت مراجعة طلبك')
  await evaluate(`document.querySelector('#reply').focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  check(await evaluate(`document.activeElement.matches('.reply-composer button[type=submit]') && document.activeElement.textContent.trim() === 'إرسال الرد'`), 'keyboard moves from the Arabic draft to the labeled send control')
  await cdp.send('Accessibility.enable')
  const accessibility = await cdp.send('Accessibility.getFullAXTree')
  check(accessibility.nodes.some(node => node.role?.value === 'log' && node.name?.value === 'رسائل المحادثة') && accessibility.nodes.some(node => node.role?.value === 'button' && node.name?.value === 'إرسال الرد'), 'Chromium exposes localized history and reply controls to assistive technology')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await wait(`document.querySelector('.thread-scroll')?.textContent.includes('تمت مراجعة طلبك') && document.querySelector('#reply').value === ''`, 'RTL keyboard reply committed')
  check((await (await fetch(boundary.url.origin + `/api/widget/projects/${project.public_id}/conversations/${destination}`, { headers: { origin, authorization: `Bearer ${late.token}` } })).json() as { messages?: { body: string }[] }).messages?.some(message => message.body === 'تمت مراجعة طلبك'), 'Arabic keyboard reply is visible through the existing customer route')
  await input('#inbox-language', 'en')
  await wait(`document.querySelector('#main').dir === 'ltr' && document.querySelector('h1').textContent === 'Inbox'`, 'Inbox switches back to English')

  check(await evaluate(`!document.querySelector('#reply-image')`), 'the Messenger composer retains its normal text controls')
  const selectDiscord = () => evaluate(`Array.from(document.querySelectorAll('.conversation-row')).find(el=>el.textContent.includes(${JSON.stringify(discordSubject)})).click()`)
  await selectDiscord()
  await wait(`document.querySelector('#reply-image') && !document.querySelector('#reply-image').disabled`, 'Managed image picker appears in the Discord composer')
  const { root: { nodeId } } = await cdp.send('DOM.getDocument')
  const setImage = async () => {
    const input = await cdp.send('DOM.querySelector', { nodeId, selector: '#reply-image' })
    await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [fixtureImage] })
    await wait(`document.querySelector('.reply-composer').textContent.includes('fixture-image.png')`, 'PNG selected as a private draft')
  }
  await setImage()
  check(await evaluate(`!document.querySelector('.reply-composer button[type=submit]').disabled && !document.querySelector('#reply').value`), 'an image can be sent without a text caption')
  await click('Remove image')
  check(await evaluate(`document.activeElement.id === 'reply-image' && document.querySelector('.reply-composer button[type=submit]').disabled`), 'removing an image returns keyboard focus and disables an empty reply')
  await setImage()
  await evaluate(`Array.from(document.querySelectorAll('.conversation-row')).find(el=>el.textContent.includes('Late original request') && el.textContent.includes('Resolved')).click()`)
  await wait(`document.querySelector('#reply').value === 'Staff draft on predecessor' && !document.querySelector('#reply').disabled`, 'Switch from Discord to the isolated text draft')
  check(await evaluate(`!document.querySelector('#reply-image') && !document.querySelector('.reply-composer').textContent.includes('fixture-image.png')`), 'the selected image stays scoped to its original conversation')
  await selectDiscord()
  await wait(`document.querySelector('.reply-composer').textContent.includes('fixture-image.png') && !document.querySelector('#reply').disabled`, 'Returning to Discord restores its private image draft')
  await input('#reply-mode', 'internal'); await input('#reply', 'Private managed channel note')
  await wait(`!document.querySelector('#reply-image')`, 'Internal note hides the public image picker')
  await click('Add note')
  await wait(`document.querySelector('.thread-scroll').textContent.includes('Private managed channel note') && !document.querySelector('#reply').value`, 'Internal note saved independently')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_attachments WHERE conversation_id = ?', [discordThread.id]))!.count) === 0, 'switching to an internal note never uploads or shares the pending image')
  await input('#reply-mode', 'public')
  await wait(`document.querySelector('.reply-composer').textContent.includes('fixture-image.png')`, 'Public image draft survives sending a note')
  lostImageAck = true
  await click('Send reply')
  await wait(`document.querySelector('.inbox-error')?.textContent.includes('Image stored; acknowledgement lost.')`, 'Native upload acknowledgement dropped')
  check(await evaluate(`document.querySelector('.reply-composer').textContent.includes('fixture-image.png')`), 'an uncertain upload preserves the selected image and retry key')
  await click('Send reply')
  await wait(`document.querySelector('.thread-notice')?.textContent.includes('Reply queued.') && !document.querySelector('.reply-composer').textContent.includes('fixture-image.png') && document.querySelector('.thread-scroll').textContent.includes('Attachment')`, 'The exact browser retry queues one image reply')
  const imageRows = await query('SELECT id, visibility, status FROM support_attachments WHERE conversation_id = ?', [discordThread.id])
  const deliveries = await query('SELECT payload, status FROM support_channel_deliveries WHERE project_id = ? AND channel_id = ?', [project.id, ready.id])
  const payload = JSON.parse(String(deliveries[0]?.payload))
  check(imageRows.length === 1 && imageRows[0]?.visibility === 'private' && imageRows[0]?.status === 'stored' && deliveries.length === 1 && deliveries[0]?.status === 'pending' && payload.attachmentIds[0] === String(imageRows[0]!.id) && payload.body === '', 'native upload replay keeps one private file and one exact file-only delivery')

  await evaluate(`Array.from(document.querySelectorAll('.conversation-row')).find(el=>el.textContent.includes('Late original request') && el.textContent.includes('Resolved')).click()`)
  await wait(`${messageCount} === 500 && document.querySelector('#load-older-messages') && !document.querySelector('#reply').disabled`, 'Predecessor is ready for a workspace switch')
  await click('Load older messages')
  await wait(`${messageCount} === 550 && document.querySelector('.thread-scroll').textContent.includes('New internal note while reading older history')`, 'The archive is visible before retention')
  const retentionMarker = '[Removed by retention policy]'
  await query('UPDATE support_messages SET body = ? WHERE id > 0 AND project_id = ? AND conversation_id = ?', [retentionMarker, project.id, late.id])
  await query('UPDATE support_conversations SET subject = ? WHERE id = ? AND project_id = ?', [retentionMarker, late.id, project.id])
  await query('INSERT INTO support_messages (workspace_id, project_id, conversation_id, contact_id, body, visibility, author_type, delivery_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [workspace.id, project.id, late.id, contact.id, 'New response after retention', 'public', 'agent', 'imported'])
  await wait(`${messageCount} === 500 && document.querySelector('.thread-heading').textContent.includes('Removed by retention policy') && document.querySelector('.thread-scroll').textContent.includes('New response after retention')`, 'The fresh head replaces the archive after retention')
  check(await evaluate(`!document.querySelector('.thread-scroll').textContent.includes('New internal note while reading older history') && !document.querySelector('.thread-scroll').textContent.includes('Transcript burst')`), 'new native detail clears cached transcript bodies rewritten by retention')
  held = { id: late.id, release: Promise.withResolvers<void>(), used: false, older: true }
  await click('Load older messages')
  await waitFor(() => held?.used, 10000, { label: 'Earlier transcript page is in flight before workspace switch' })
  await input('#project', other.public_id); await wait(`document.querySelector('.welcome-pane') && !document.querySelector('#reply')`, 'Other workspace selected')
  held.release.resolve()
  held = undefined
  check(await evaluate(`!document.querySelector('.thread-scroll') && !document.body.textContent.includes('Late continuation from browser') && !document.body.textContent.includes('Staff draft on successor')`), 'changing workspace clears displayed private thread, linked controls and draft')
  check(await evaluate(`!document.body.textContent.includes('Imported history part') && !document.querySelector('#load-older-messages')`), 'an in-flight older page cannot populate another workspace')
  check(runtimeErrors.length === 0, 'compiled native widget and inbox finish without browser runtime exceptions')
  await mkdir(artifacts, { recursive: true }); await Bun.write(resolve(artifacts, 'report.json'), JSON.stringify({ passed: true, assertions, compiler: (await Bun.file(resolve(root, 'node_modules/@stacksjs/stx/package.json')).json()).version, requests, submissions }, null, 2))
  console.info(`PASS reopening browser functional (${assertions.length} checks)`)
  console.info('PASS reopening browser qualification')
}
catch (failure) {
  await mkdir(artifacts, { recursive: true }); await Bun.write(resolve(artifacts, 'failure.json'), JSON.stringify({ passed: false, assertions, runtimeErrors, error: String(failure), requests, submissions }, null, 2))
  if (browser) { const image = await browser.cdp.send('Page.captureScreenshot', { format: 'png' }); await Bun.write(resolve(artifacts, 'failure.png'), Buffer.from(image.data, 'base64')) }
  throw failure
}
finally { held?.release.resolve(); await browser?.close(); await closeSharedBrowsers(); host?.stop(true); boundary?.stop(true); api.stop(true); await rm(temporary, { recursive: true, force: true }) }
