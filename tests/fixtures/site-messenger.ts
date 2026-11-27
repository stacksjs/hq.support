import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { browserSessionCookie, startBrowserSession } from '@stacksjs/auth'
import { config, overridesReady } from '@stacksjs/config'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { closeSharedBrowsers, launch, navigate, waitFor } from '@stacksjs/testing/browser'

await overridesReady
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()

const api = await route.serve({ port: 0, hostname: '127.0.0.1' })
const dist = resolve(import.meta.dir, '../../dist')
let sessions = 0
let newRequests = 0
const releaseSend = Promise.withResolvers<void>()
let agentCookie = ''
let typingStreamAvailable = true
let typingForward: AbortController | undefined
const traffic: string[] = []
const heldResponses = new Map<string, { arrived: boolean, hold: ReturnType<typeof Promise.withResolvers<void>> }>()
function holdResponse(method: string, path: string) {
  const entry = { arrived: false, hold: Promise.withResolvers<void>() }
  heldResponses.set(`${method} ${path}`, entry)
  return entry
}
const host = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/_fixture/agent') return new Response(null, { status: 303, headers: { location: '/app', 'set-cookie': agentCookie } })
    if (url.pathname.startsWith('/api/')) {
      if (!typingStreamAvailable && url.pathname.endsWith('/typing/stream')) {
        traffic.push(`${request.method} ${url.pathname} 503`)
        return new Response(null, { status: 503 })
      }
      if (request.method === 'POST' && url.pathname.endsWith('/session')) sessions++
      if (request.method === 'POST' && /^\/api\/widget\/projects\/[^/]+\/conversations$/.test(url.pathname)) {
        newRequests++
        await releaseSend.promise
      }
      const headers = new Headers(request.headers)
      headers.delete('host')
      const signal = url.pathname.endsWith('/typing/stream') ? (typingForward = new AbortController()).signal : undefined
      const response = await fetch(new URL(url.pathname + url.search, api.url), {
        method: request.method,
        headers,
        body: request.body,
        signal,
      })
      traffic.push(`${request.method} ${url.pathname} ${response.status}`)
      const held = heldResponses.get(`${request.method} ${url.pathname}`)
      if (held) {
        heldResponses.delete(`${request.method} ${url.pathname}`)
        held.arrived = true
        await held.hold.promise
      }
      const outgoing = new Headers(response.headers)
      outgoing.delete('content-encoding')
      outgoing.delete('content-length')
      return new Response(response.body, { status: response.status, headers: outgoing })
    }
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
    const path = url.pathname === '/' ? '/index.html' : url.pathname === '/app' ? '/app.html' : url.pathname
    const file = resolve(dist, '.' + path)
    if (!file.startsWith(dist + sep) || !await Bun.file(file).exists()) return new Response('Not found', { status: 404 })
    return new Response(Bun.file(file))
  },
})
let browser: Awaited<ReturnType<typeof launch>> | undefined
let agentBrowser: Awaited<ReturnType<typeof launch>> | undefined
try {
  const origin = host.url.origin
  config.app.url = origin
  delete process.env.SUPPORT_SITE_MESSENGER_PROJECT_ID
  const seed = await fetch(new URL('/api/csrf-token', api.url))
  const csrf = (await seed.json() as { token: string }).token
  const cookie = seed.headers.get('set-cookie')!.split(';')[0]!

  async function request(path: string, method: string, status: number, body?: unknown, token?: string) {
    const response = await fetch(new URL('/api' + path, api.url), {
      method,
      headers: {
        accept: 'application/json',
        cookie,
        'x-csrf-token': csrf,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await response.json() as any
    assert.equal(response.status, status, JSON.stringify(data))
    return data
  }

  const email = 'owner@site-messenger.example.test'
  const password = 'SiteMessengerNative2026!'
  await request('/register', 'POST', 200, { name: 'Site owner', email, password, password_confirmation: password })
  const login = await request('/login', 'POST', 200, { email, password })
  const owner = login.access_token ?? login.token
  const browserLogin = await request('/login', 'POST', 200, { email, password })
  const agentSession = await startBrowserSession(browserLogin.access_token ?? browserLogin.token)
  assert.ok(agentSession)
  agentCookie = browserSessionCookie(agentSession)
  const { workspace } = await request('/support/workspaces', 'POST', 201, { name: 'First-party support' }, owner)
  const { project } = await request(`/support/workspaces/${workspace.id}/projects`, 'POST', 201, { name: 'Marketing site' }, owner)
  const prefix = `/support/projects/${project.public_id}`
  await request(prefix, 'PATCH', 200, { allowedOrigins: [origin], anonymousEnabled: true }, owner)

  browser = await launch({ headless: true, shared: false, viewport: { width: 375, height: 812 }, chromePath: process.env.CHROME_PATH })
  const cdp = browser.cdp
  const errors: string[] = []
  cdp.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text))
  await cdp.intercept([{ urlPattern: '*' }], async (event, session) => {
    if (new URL(event.request.url).origin === origin)
      await session.send('Fetch.continueRequest', { requestId: event.requestId })
    else
      await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/css' }], body: '' })
  })
  const widget = "document.querySelector('[data-hq-support]')?.shadowRoot.querySelector('hq-support-messenger')"
  const shadow = `${widget}?.shadowRoot`
  const wait = (expression: string, label: string) => waitFor(() => cdp.evaluate(expression), 15000, { label })
  const clickChat = () => cdp.evaluate("document.querySelector('#site-chat').click()")
  assert.ok(await navigate(cdp, origin))
  assert.equal(sessions, 0, 'Reading the homepage creates no customer session')
  await clickChat()
  await wait("document.querySelector('.site-chat-status a')?.getAttribute('href') === '/help'", 'working help fallback')
  assert.equal(sessions, 0, 'Unconfigured chat creates no customer session')

  process.env.SUPPORT_SITE_MESSENGER_PROJECT_ID = project.public_id
  await clickChat()
  await wait(`!!${shadow}?.querySelector('#support-body')`, 'native Messenger opens')
  await wait(`${shadow}?.activeElement?.getAttribute('aria-label') === 'Close support'`, 'keyboard focus enters Messenger')
  assert.equal(await cdp.evaluate("document.querySelector('#site-chat').getAttribute('aria-expanded')"), 'true')
  const fitsViewport = () => cdp.evaluate<boolean>(`(() => {
    const box = ${shadow}.querySelector('.messenger').getBoundingClientRect()
    const launcher = document.querySelector('#site-chat')
    const button = launcher.getBoundingClientRect()
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0
      && box.bottom < button.top && button.right <= innerWidth && button.bottom <= innerHeight
      && !${widget}.parentNode.parentNode.querySelector('hq-support-launcher')
  })()`)
  assert.equal(await fitsViewport(), true, 'Messenger fits above the single bubble on a narrow viewport')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: false })
  assert.equal(await fitsViewport(), true, 'Messenger fits at 320px wide')
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  assert.equal(await cdp.evaluate(`getComputedStyle(${widget}.parentNode).transitionDuration`), '0s')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false })
  const press = async (key: string, code: number) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
  }
  const composer = `${shadow}.querySelector('#support-body')`
  const sendButton = `${shadow}.querySelector('.send-row button')`
  const sendFocused = `${shadow}.activeElement === ${sendButton}`
  await press('Tab', 9)
  assert.equal(await cdp.evaluate(`${shadow}.activeElement?.id`), 'support-body')
  await cdp.send('Input.insertText', { text: 'A real homepage support request' })
  assert.equal(await cdp.evaluate(`${composer}.value`), 'A real homepage support request')
  await press('Tab', 9)
  assert.equal(await cdp.evaluate(sendFocused), true)
  try {
    await press('Enter', 13)
    await waitFor(() => newRequests > 0, 5000, { label: 'Keyboard sends the support request' })
    assert.equal(await cdp.evaluate(sendFocused), true, 'Send retains focus while waiting for the response')
    assert.equal(await cdp.evaluate(`${sendButton}.getAttribute('aria-disabled')`), 'true')
    assert.equal(await cdp.evaluate(`${composer}.readOnly`), true)
    assert.equal(await cdp.evaluate(`${sendButton}.getAttribute('aria-disabled')`), 'true')
    assert.equal(await cdp.evaluate(`${composer}.readOnly`), true)
    assert.equal(await cdp.evaluate(`${shadow}.querySelector('.send-row [role=status]').textContent.trim()`), 'Sending…')
    await press('Enter', 13)
  }
  finally {
    releaseSend.resolve()
  }
  await wait(`${shadow}?.querySelector('.messages')?.textContent.includes('A real homepage support request')`, 'saved customer message')
  await wait(`!${widget}.pending`, 'Support send completes')
  assert.equal(newRequests, 1, 'Repeated keyboard activation sends exactly one request')
  assert.equal(await cdp.evaluate(sendFocused), true, 'Send retains focus after the response')
  assert.equal(await cdp.evaluate(`${sendButton}.getAttribute('aria-disabled')`), 'false')
  assert.equal(await cdp.evaluate(`${composer}.readOnly`), false)

  const inbox = await request(prefix + '/inbox', 'GET', 200, undefined, owner)
  assert.equal(inbox.conversations.length, 1)
  const id = inbox.conversations[0].id
  agentBrowser = await launch({ headless: true, shared: false, chromePath: process.env.CHROME_PATH })
  const agent = agentBrowser.cdp
  agent.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text))
  await agent.intercept([{ urlPattern: '*' }], async (event, session) => {
    if (new URL(event.request.url).origin === origin)
      await session.send('Fetch.continueRequest', { requestId: event.requestId })
    else
      await session.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, body: '' })
  })
  assert.ok(await navigate(agent, origin + '/_fixture/agent'))
  await waitFor(() => agent.evaluate(`!!document.querySelector('.conversation-row')`), 15000, { label: 'Agent opens the real inbox' })
  await agent.evaluate(`document.querySelector('.conversation-row').click()`)
  await waitFor(() => agent.evaluate(`document.querySelector('#reply')?.disabled === false`), 15000, { label: 'Agent opens the visitor conversation' })
  const customerTyping = (value: string) => waitFor(() => agent.evaluate(`document.querySelector('#customer-typing')?.textContent.trim() === ${JSON.stringify(value)}`), 15000, { label: value || 'Customer typing clears' })
  await customerTyping('')
  const customerTypingPath = `/api${prefix}/conversations/${id}/typing`
  const typingReads = () => traffic.filter(entry => entry === `GET ${customerTypingPath} 200`).length
  await waitFor(() => traffic.includes(`POST ${customerTypingPath}/stream 200`) && typingReads() > 0, 15000, { label: 'Agent reads the typing snapshot after opening the stream' })
  await cdp.evaluate(`${composer}.focus()`)
  const readsBeforeTyping = typingReads(), customerStarted = performance.now()
  await cdp.send('Input.insertText', { text: 'Unsent customer draft' })
  await customerTyping('Customer is typing…')
  const customerTypingMs = Math.round(performance.now() - customerStarted)
  assert.ok(typingReads() > readsBeforeTyping && customerTypingMs < 2500, 'Customer start wakes a read-only typing check before the lease heartbeat')
  assert.equal(await agent.evaluate(`document.querySelector('#customer-typing').getAttribute('aria-atomic')`), 'true')
  assert.equal(await agent.evaluate(`document.querySelector('#customer-typing').getAttribute('role')`), 'status')
  assert.equal(await agent.evaluate(`document.querySelector('#agent-message-history').textContent.includes('Unsent customer draft')`), false)
  const agentLocale = (language: string) => agent.evaluate(`(() => {
    const locale = document.querySelector('#inbox-language')
    locale.value = ${JSON.stringify(language)}
    locale.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await agentLocale('de')
  await customerTyping('Der Kunde schreibt…')
  await agentLocale('ar')
  await customerTyping('العميل يكتب…')
  assert.equal(await agent.evaluate(`document.querySelector('.inbox-shell').dir`), 'rtl')
  await agentLocale('en')
  await customerTyping('')
  assert.equal(await cdp.evaluate(`${composer}.value`), 'Unsent customer draft')
  await cdp.evaluate('globalThis.originalAbortTimeout = AbortSignal.timeout; AbortSignal.timeout = undefined')
  await cdp.send('Input.insertText', { text: ' still private' })
  await customerTyping('Customer is typing…')
  const readsBeforeClose = typingReads(), customerClosed = performance.now()
  await clickChat()
  await customerTyping('')
  const customerClearMs = Math.round(performance.now() - customerClosed)
  assert.ok(typingReads() > readsBeforeClose && customerClearMs < 2500, 'Customer close wakes a read-only typing check before the lease heartbeat')
  await cdp.evaluate('AbortSignal.timeout = globalThis.originalAbortTimeout; delete globalThis.originalAbortTimeout')
  await clickChat()
  await wait(`!!${composer}`, 'Reopen the customer composer')
  await cdp.evaluate(`(() => { const field = ${composer}; field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await cdp.evaluate(`${sendButton}.focus()`)
  await wait(sendFocused, 'Focus Send before checking incoming replies')

  const typeReply = (value: string) => agent.evaluate(`(() => {
    const draft = document.querySelector('#reply')
    draft.value = ${JSON.stringify(value)}
    draft.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const heldRead = holdResponse('GET', customerTypingPath)
  await cdp.evaluate(`${composer}.focus()`)
  await cdp.send('Input.insertText', { text: 'Customer draft during a slow heartbeat' })
  await waitFor(() => heldRead.arrived, 8000, { label: 'The fast customer typing read is ready' })
  const heldHeartbeat = holdResponse('POST', `/api${prefix}/conversations/${id}/presence`)
  await typeReply('Agent draft starts a heartbeat')
  await waitFor(() => heldHeartbeat.arrived, 8000, { label: 'A newer heartbeat starts before the fast read returns' })
  heldRead.hold.resolve()
  await customerTyping('Customer is typing…')
  await cdp.evaluate(`(() => { const field = ${composer}; field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await customerTyping('')
  heldHeartbeat.hold.resolve()
  await Bun.sleep(200)
  await customerTyping('')
  await typeReply('')

  typingStreamAvailable = false
  assert.ok(typingForward, 'An established typing stream can be interrupted')
  typingForward.abort()
  await waitFor(() => traffic.includes(`POST ${customerTypingPath}/stream 503`), 15000, { label: 'Native typing stream is unavailable' })
  const readsWithoutStream = typingReads()
  await cdp.evaluate(`${composer}.focus()`)
  await cdp.send('Input.insertText', { text: 'Private draft during the stream outage' })
  await customerTyping('Customer is typing…')
  await cdp.evaluate(`(() => { const field = ${composer}; field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await customerTyping('')
  assert.equal(typingReads(), readsWithoutStream, 'The lease heartbeat still shows and clears customer typing during an outage')
  typingStreamAvailable = true
  await cdp.evaluate(`${sendButton}.focus()`)
  const typingStatus = `${shadow}?.querySelector('.typing-status')`
  const typingShown = `${typingStatus}?.textContent.trim() === 'Support is typing…'`
  const typingHidden = `${typingStatus}?.textContent.trim() === ''`
  await wait(typingHidden, 'Agent viewing does not show typing')
  const beganTyping = performance.now()
  await typeReply('Private until it is sent')
  await wait(typingShown, 'Public keystrokes show a typing indicator')
  const typingMs = Math.round(performance.now() - beganTyping)
  assert.equal(await cdp.evaluate(`${typingStatus}.getAttribute('role')`), 'status')
  assert.equal(await cdp.evaluate(`${shadow}.textContent.includes('Private until it is sent')`), false)
  await wait(typingHidden, 'Typing indicator expires while the agent keeps an idle draft')
  assert.equal(await agent.evaluate(`document.querySelector('#reply').value`), 'Private until it is sent')
  await agent.evaluate(`(() => {
    const select = document.querySelector('#reply-mode')
    select.value = 'internal'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await typeReply('Internal note activity')
  const typingPolls = () => traffic.filter(entry => entry === `GET /api/widget/projects/${project.public_id}/conversations/${id}/typing 200`).length
  const beforeNote = typingPolls()
  await waitFor(() => typingPolls() > beforeNote, 5000, { label: 'Visitor polls while the agent edits a private note' })
  await wait(typingHidden, 'Private note editing leaves the customer indicator blank')
  await agent.evaluate(`(() => {
    const select = document.querySelector('#reply-mode')
    select.value = 'public'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const beforeModeSwitch = typingPolls()
  await waitFor(() => typingPolls() > beforeModeSwitch, 5000, { label: 'Visitor polls after switching the reply mode' })
  await wait(typingHidden, 'Switching modes alone does not show typing')
  await typeReply('Reply from the team inbox')
  await wait(typingShown, 'Public typing resumes')
  await agent.evaluate(`document.querySelector('#reply').form.requestSubmit()`)
  await wait(typingHidden, 'Sending clears the typing indicator')
  await wait(`${shadow}?.querySelector('.messages')?.textContent.includes('Reply from the team inbox')`, 'agent reply arrives in browser')
  await wait(sendFocused, 'incoming replies preserve keyboard focus')
  const artifacts = resolve(import.meta.dir, '../../storage/framework/runtime/site-messenger-browser')
  await mkdir(artifacts, { recursive: true })
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(resolve(artifacts, 'homepage-chat-375.png'), Buffer.from(screenshot.data, 'base64'))
  await typeReply('Another unsent draft')
  await wait(typingShown, 'Typing indicator is visible before closing Messenger')
  await press('Escape', 27)
  await wait("document.activeElement?.id === 'site-chat'", 'closing restores focus to the homepage')
  assert.equal(await cdp.evaluate("document.querySelector('#site-chat').getAttribute('aria-expanded')"), 'false')
  await Bun.sleep(2250)
  const closedPolls = typingPolls()
  await Bun.sleep(2250)
  assert.equal(typingPolls(), closedPolls, 'The closed Messenger no longer polls for typing')

  assert.ok(await navigate(cdp, origin))
  assert.equal(sessions, 1, 'Reload leaves chat idle until the visitor opens it')
  await clickChat()
  await wait(`${shadow}?.querySelector('.messages')?.textContent.includes('Reply from the team inbox')`, 'same-tab reload resumes the saved conversation')
  assert.equal(sessions, 2)
  const token = await cdp.evaluate<string>(`${widget}.sessionToken`)
  const boundary = new URL('/api/widget/projects/' + project.public_id + '/conversations', api.url)
  const referer = origin + '/'
  for (const headers of [{ referer }, { referer, 'sec-fetch-site': 'cross-site' }, { referer, 'sec-fetch-site': 'same-origin', origin: 'https://unregistered.example' }]) {
    const refused = await fetch(boundary, { headers: { ...headers, authorization: `Bearer ${token}` } })
    assert.equal(refused.status, 403, 'Referrer fallback requires a same-origin read with no Origin header')
  }
  const unauthenticated = await fetch(boundary, { headers: { referer, 'sec-fetch-site': 'same-origin' } })
  assert.equal(unauthenticated.status, 401, 'First-party reads still require a project-scoped customer credential')
  await cdp.evaluate(`(async () => {
    const { createSupport } = await import('/support.js')
    const container = document.createElement('div')
    container.id = 'inline-appearance'
    container.style.width = 'min(100%, 620px)'
    container.style.setProperty('--hq-support-inline-width', '100%')
    container.style.setProperty('--hq-support-inline-intro-display', 'none')
    container.style.setProperty('--hq-support-surface', '#23272f')
    container.style.setProperty('--hq-support-accent', '#1766c8')
    container.style.setProperty('--hq-support-muted', '#b1bac9')
    container.style.setProperty('--hq-support-border', '#363b45')
    container.style.setProperty('--hq-support-control-height', '44px')
    document.body.append(container)
    const inline = createSupport({ container, inline: true })
    await inline.boot({ endpoint: location.origin, project: ${JSON.stringify(project.public_id)}, externalLauncher: document.querySelector('#site-chat') })
    inline.open()
    globalThis.stopInlineAppearanceProof = () => { inline.shutdown(); container.remove() }
  })()`)
  const compactHost = "document.querySelector('#inline-appearance')"
  const compactRoot = `${compactHost}.querySelector('[data-hq-support]').shadowRoot.querySelector('hq-support-messenger').shadowRoot`
  await wait(`!!${compactRoot}.querySelector('#support-body')`, 'Inline Messenger renders')
  for (const width of [1280, 320]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false })
    const appearance = await cdp.evaluate(`(() => {
      const panel = ${compactRoot}.querySelector('.messenger')
      const send = ${compactRoot}.querySelector('#support-send')
      const composer = ${compactRoot}.querySelector('#support-body')
      return {
        inlineWidth: panel.getBoundingClientRect().width,
        hostWidth: ${compactHost}.getBoundingClientRect().width,
        panel: getComputedStyle(panel).backgroundColor,
        border: getComputedStyle(panel).borderTopColor,
        send: getComputedStyle(send).backgroundColor,
        sendHeight: send.getBoundingClientRect().height,
        placeholder: getComputedStyle(composer, '::placeholder').color,
        emptyHistory: getComputedStyle(${compactRoot}.querySelector('#support-history')).display,
      }
    })()`)
    const hostWidth = width === 1280 ? 620 : 320
    assert.deepEqual(appearance, { inlineWidth: hostWidth, hostWidth, panel: 'rgb(35, 39, 47)', border: 'rgb(54, 59, 69)', send: 'rgb(23, 102, 200)', sendHeight: 44, placeholder: 'rgb(177, 186, 201)', emptyHistory: 'none' })
  }
  await cdp.evaluate('globalThis.stopInlineAppearanceProof()')
  assert.deepEqual(errors, [])
  await Bun.write(resolve(artifacts, 'typing.json'), JSON.stringify({ typingMs, customerTypingMs, customerClearMs, runtimeErrors: errors.length }))
  console.info(`PASS homepage Messenger (typing visible in ${typingMs} ms)`)
}
catch (error) {
  console.error(traffic.join('\n'))
  console.error(browser?.cdp.errors)
  throw error
}
finally {
  await agentBrowser?.close()
  await browser?.close()
  await closeSharedBrowsers()
  await host.stop(true)
  await api.stop(true)
}
