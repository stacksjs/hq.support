import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { browserSessionCookie, startBrowserSession } from '@stacksjs/auth'
import { overridesReady } from '@stacksjs/config'
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
let agentCookie = ''
const traffic: string[] = []
const host = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/_fixture/agent') return new Response(null, { status: 303, headers: { location: '/app', 'set-cookie': agentCookie } })
    if (url.pathname.startsWith('/api/')) {
      if (request.method === 'POST' && url.pathname.endsWith('/session')) sessions++
      const headers = new Headers(request.headers)
      headers.delete('host')
      const response = await fetch(new URL(url.pathname + url.search, api.url), {
        method: request.method,
        headers,
        body: request.body,
      })
      traffic.push(`${request.method} ${url.pathname} ${response.status}`)
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
  await cdp.evaluate(`(() => {
    const input = ${shadow}.querySelector('#support-body')
    input.value = 'A real homepage support request'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.form.requestSubmit()
  })()`)
  await wait(`${shadow}?.querySelector('.messages')?.textContent.includes('A real homepage support request')`, 'saved customer message')

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
  const typeReply = (value: string) => agent.evaluate(`(() => {
    const draft = document.querySelector('#reply')
    draft.value = ${JSON.stringify(value)}
    draft.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
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
  await wait(`${shadow}?.activeElement?.id === 'support-close'`, 'incoming replies preserve keyboard focus')
  const artifacts = resolve(import.meta.dir, '../../storage/framework/runtime/site-messenger-browser')
  await mkdir(artifacts, { recursive: true })
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await Bun.write(resolve(artifacts, 'homepage-chat-375.png'), Buffer.from(screenshot.data, 'base64'))
  await typeReply('Another unsent draft')
  await wait(typingShown, 'Typing indicator is visible before closing Messenger')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
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
  assert.deepEqual(errors, [])
  await Bun.write(resolve(artifacts, 'typing.json'), JSON.stringify({ typingMs, runtimeErrors: errors.length }))
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
