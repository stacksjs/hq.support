import { mkdtemp, symlink } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { generateStaticSite } from '@stacksjs/stx/ssg'

const root = resolve(import.meta.dir, '..')
const statePath = process.env.SUPPORT_PHONE_FIXTURE_STATE || '/tmp/hq-support-phone-browser-state.json'
if (!statePath.startsWith('/tmp/hq-support-phone-')) throw new Error('The browser fixture requires its private task state file.')
const state = await Bun.file(statePath).json()
const api = new URL(state.apiOrigin)
if (api.protocol !== 'http:' || api.hostname !== '127.0.0.1') throw new Error('The phone fixture proxies a local native API only.')
const sdk = Bun.resolveSync('@twilio/voice-sdk', root)
const outputDir = '/tmp/hq-support-phone-browser-dist'
const buildRoot = await mkdtemp('/tmp/hq-support-phone-build-')
process.on('exit', () => rmSync(buildRoot, { recursive: true, force: true }))
for (const path of ['resources', 'public', 'config', 'node_modules', 'storage', 'package.json', 'tsconfig.json']) await symlink(resolve(root, path), resolve(buildRoot, path))
await Bun.write(resolve(buildRoot, 'stx.config.ts'), `export default ${JSON.stringify({ partialsDir: resolve(root, 'resources/partials'), layoutsDir: resolve(root, 'resources/views/layouts'), componentsDir: resolve(root, 'resources/components'), webModules: { [sdk]: resolve(root, 'tests/widget-phone-sdk.ts') }, router: { enabled: false } })}`)
process.chdir(buildRoot)
const compiled = await generateStaticSite({ pagesDir: resolve(root, 'resources/views'), outputDir, publicDir: resolve(root, 'public'), partialsDir: resolve(root, 'resources/partials'), componentsDir: resolve(root, 'resources/components'), router: { enabled: false }, minify: false, cache: false, sitemap: false, robots: false })
process.chdir(root)
if (compiled.failedCount) throw new Error('Native phone fixture views did not compile.')
const html = await Bun.file(resolve(outputDir, 'app/phone.html')).text()
if (!html.includes('phone-fixture-event')) throw new Error('The native fixture must replace the official SDK before serving.')
const banner = '<aside role="note"><strong>Deterministic local phone fixture.</strong> Native authentication and SQL, with external phone providers and browser audio simulated. No live calls.<form method="post" action="/fixture/microphone-denied"><button type="submit">Simulate microphone denial</button></form><form method="post" action="/fixture/registration-denied"><button type="submit">Simulate registration failure</button></form><form method="post" action="/fixture/microphone-ready"><button type="submit">Restore simulated device</button></form><p>SDK boundary: <output id="fixture-events">Not enabled</output></p></aside>'
const document = html.replace(/<body\b[^>]*>/i, opening => opening + banner).replace('</body>', '<script type="module" src="/fixture/observer.js"></script></body>')
const observer = await Bun.build({ entrypoints: [resolve(root, 'tests/widget-phone-observer.ts')], target: 'browser', format: 'esm' })
if (!observer.success) throw new Error('Phone fixture observer compilation failed.')
let microphoneDenied = false
let registrationDenied = false
const server = Bun.serve({ hostname: '127.0.0.1', port: 4414, async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname === '/fixture/info') return Response.json({ project: state.project, callId: state.callId, channelId: state.channelId, microphoneDenied, registrationDenied })
  if (request.method === 'POST' && ['/fixture/microphone-denied', '/fixture/microphone-ready', '/fixture/registration-denied'].includes(url.pathname)) {
    if (request.headers.get('origin') !== url.origin) return new Response('Forbidden', { status: 403 })
    microphoneDenied = url.pathname === '/fixture/microphone-denied'
    registrationDenied = url.pathname === '/fixture/registration-denied'
    return Response.redirect(`${url.origin}/app/phone`, 303)
  }
  if (url.pathname === '/fixture/observer.js') return new Response(observer.outputs[0], { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } })
  if (url.pathname.startsWith('/api/')) {
    const target = new URL(url.pathname + url.search, api)
    const headers = new Headers(request.headers)
    headers.delete('host')
    const cookies = new Map<string, string>()
    // This test host is bound to its one real native account, not unrelated
    // auth-token cookies from other loopback apps sharing the browser domain.
    const csrfCookie = (request.headers.get('cookie') || '').split(';').filter(value => value.trim().startsWith('X-CSRF-Token=')).join(';')
    for (const value of `${csrfCookie};${state.browserCookie}`.split(';')) { const separator = value.indexOf('='); if (separator >= 0) cookies.set(value.slice(0, separator).trim(), value.slice(separator + 1)) }
    headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '))
    const result = await fetch(new Request(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body }))
    const responseHeaders = new Headers(result.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    return new Response(result.body, { status: result.status, headers: responseHeaders })
  }
  if (['/', '/app', '/app/phone'].includes(url.pathname)) return new Response(document, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } })
  const base = outputDir, file = resolve(base, `.${decodeURIComponent(url.pathname)}`)
  if (!file.startsWith(base + sep)) return new Response('Forbidden', { status: 403 })
  return await Bun.file(file).exists() ? new Response(Bun.file(file)) : new Response('Not found', { status: 404 })
} })
console.info(`Native phone UI fixture: ${server.url}app/phone`)
