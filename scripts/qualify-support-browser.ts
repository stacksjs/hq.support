import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import { closeSharedBrowsers, launch, navigate, settle, waitFor } from '@stacksjs/testing/browser'
import type { LaunchedChrome } from '@stacksjs/testing/browser'
import { createWidgetPreview } from '../tests/widget-preview'

const root = resolve(import.meta.dir, '..'), args = process.argv.slice(2)
if (args.some(arg => !['--skip-build'].includes(arg))) throw new Error('Usage: bun scripts/qualify-support-browser.ts [--skip-build]')
const output = resolve(process.env.SUPPORT_BROWSER_ARTIFACTS || resolve(root, 'storage/framework/runtime/support-browser'))
const children = new Set<ReturnType<typeof Bun.spawn>>()
let browser: LaunchedChrome | undefined, preview: Awaited<ReturnType<typeof createWidgetPreview>> | undefined, temporary = '', stopping = false
const results: unknown[] = []
await mkdir(output, { recursive: true })
for (const label of ['desktop-proof', 'desktop-loader-proof', 'mobile-proof', 'mobile-loader-proof']) for (const suffix of ['.png', '-failed.png', '-failed.json']) await rm(resolve(output, label + suffix), { force: true })
await Bun.write(resolve(output, 'report.json'), JSON.stringify({ passed: false, reason: 'Qualification starting' }, null, 2))
async function cleanup() {
  preview?.close(); preview = undefined
  await browser?.close().catch(() => undefined); browser = undefined
  await closeSharedBrowsers()
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
    await Promise.race([child.exited, Bun.sleep(1000)])
    try { process.kill(-child.pid, 'SIGKILL') } catch { if (child.exitCode === null) child.kill(9) }
    await child.exited
  }
  children.clear()
  if (temporary) { await rm(temporary, { recursive: true, force: true }); temporary = '' }
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) process.once(signal, () => {
  if (stopping) return
  stopping = true
  void cleanup().finally(() => process.exit(code))
})
async function capture(stream: ReadableStream<Uint8Array>): Promise<string> {
  let tail = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) tail = (tail + decoder.decode(chunk, { stream: true })).slice(-262144)
  return tail + decoder.decode()
}
async function build() {
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/build-support-elements.ts'], { cwd: root, env: { ...process.env, SUPPORT_NATIVE_UI: '0', SUPPORT_TEST_BILLING: '0', MAIL_MAILER: 'capture' }, detached: true, stdout: 'pipe', stderr: 'pipe' })
  children.add(child)
  const stdout = capture(child.stdout), stderr = capture(child.stderr)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = Promise.withResolvers<never>()
    timer = setTimeout(() => deadline.reject(new Error('Native widget build exceeded 120 seconds.')), 120000)
    const code = await Promise.race([child.exited, deadline.promise])
    const logs = await Promise.all([stdout, stderr])
    await Bun.write(resolve(output, 'build.log'), logs.join('\n'))
    assert.equal(code, 0, `Native widget build failed. See ${resolve(output, 'build.log')}`)
    children.delete(child)
  }
  finally { clearTimeout(timer) }
}
interface Manifest { version: string, locales?: string[], csp: { styleSrc: string[] }, files: { path: string, sha256: string }[] }
async function snapshotAssets() {
  temporary = await mkdtemp(resolve(tmpdir(), 'hq-support-browser-'))
  const source = resolve(process.env.SUPPORT_BROWSER_ASSETS || resolve(root, 'public'))
  assert.ok(!process.env.SUPPORT_BROWSER_ASSETS || args.includes('--skip-build'), 'Reviewed hosted artifacts require --skip-build, never a rebuild')
  const assets = resolve(temporary, 'public'), manifest: Manifest = await Bun.file(resolve(source, 'widgets/manifest.json')).json()
  assert.match(manifest.version, /^[a-zA-Z0-9.+-]+$/)
  if (!process.env.SUPPORT_BROWSER_ASSETS) assert.deepEqual(manifest.locales, ['en', 'de', 'ar'], 'Current hosted artifact must declare its supported locales')
  assert.ok(manifest.files.length >= 4, 'Manifest must describe the compiled publication')
  const paths = new Set(['/widgets/manifest.json', '/widgets/bundle.js', ...manifest.files.map(file => file.path)])
  for (const path of paths) {
    assert.ok(path.startsWith('/') && !path.includes('..') && !path.includes('\\'), 'Manifest artifact path must be public and relative')
    const target = resolve(assets, '.' + path)
    assert.ok(target.startsWith(assets + sep))
    await mkdir(resolve(target, '..'), { recursive: true })
    await copyFile(resolve(source, '.' + path), target)
  }
  for (const file of manifest.files) assert.equal(createHash('sha256').update(new Uint8Array(await Bun.file(resolve(assets, '.' + file.path)).arrayBuffer())).digest('hex'), file.sha256, `Published artifact checksum: ${file.path}`)
  const compatibility = await Bun.file(resolve(assets, 'widgets/bundle.js')).arrayBuffer(), immutable = await Bun.file(resolve(assets, 'widgets', manifest.version, 'bundle.js')).arrayBuffer()
  assert.ok(Buffer.from(compatibility).equals(Buffer.from(immutable)), 'Direct element proof and hosted loader must consume the same compiled bundle')
  return { assets, manifest }
}
interface RequestRecord { url: string, method: string, postData?: string }
interface LogEntry { text: string, source?: string, url?: string, networkRequestId?: string }
async function qualify(assets: string, path: '/proof' | '/loader-proof', viewport: { width: number, height: number }, label: string, scheme: 'light' | 'dark', localization: boolean) {
  if (stopping) throw new Error('Browser qualification interrupted')
  preview = await createWidgetPreview({ port: 0, assetsDirectory: assets, native: false })
  const origin = preview.server.url.origin, url = origin + path + (localization && path === '/loader-proof' ? '?localization=1' : ''), policy = (await fetch(url)).headers.get('content-security-policy') || ''
  assert.ok(policy.includes("script-src 'self'") && !/unsafe-inline|unsafe-eval/.test(policy), 'Proof must run under a strict script CSP')
  const requests = new Map<string, RequestRecord>(), failures: string[] = [], forbidden: string[] = [], expectedFailures = new Set<string>(), logs: LogEntry[] = []
  browser = await launch({ headless: true, shared: false, viewport, chromePath: process.env.CHROME_PATH || process.env.BROWSE_BROWSER, args: process.platform === 'linux' ? ['--disable-dev-shm-usage', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] : [], startTimeoutMs: 60000, commandTimeoutMs: 20000 })
  const cdp = browser.cdp
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
  cdp.on('Network.requestWillBeSent', event => requests.set(event.requestId, event.request))
  cdp.on('Log.entryAdded', event => logs.push(event.entry))
  cdp.on('Network.responseReceived', event => {
    if (event.response.status < 400) return
    const request = requests.get(event.requestId)
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(request?.postData || '{}') } catch { /* Non-JSON requests cannot match the expected negative case. */ }
    if (path === '/proof' && event.response.status === 503 && request?.method === 'POST' && request.url.startsWith(origin + '/api/widget/projects/proof/') && body.body === 'FAIL') expectedFailures.add(event.requestId)
    else failures.push(`${event.response.status} ${event.response.url}`)
  })
  await cdp.intercept([{ urlPattern: '*' }], async (request, session) => {
    const target = new URL(request.request.url)
    if (['http:', 'https:'].includes(target.protocol) && target.origin !== origin) {
      forbidden.push(target.origin + target.pathname)
      await session.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' })
    }
    else await session.send('Fetch.continueRequest', { requestId: request.requestId })
  })
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__hqCompilerCsp = []; document.addEventListener('securitypolicyviolation', event => globalThis.__hqCompilerCsp.push({directive:event.violatedDirective,blocked:event.blockedURI}));` })
  let passed = false
  try {
    assert.ok(await navigate(cdp, url, { quietMs: 100, timeoutMs: 20000 }), 'Plain host must settle')
    const expectedTitle = path === '/proof' ? 'All native widget checks passed' : 'All hosted loader checks passed'
    const proof = await waitFor(async () => {
      const state = await cdp.evaluate<{ title: string, checks: string[], violations: unknown[] }>(`({title:document.title,checks:[...document.querySelectorAll('#checks > *')].map(node=>node.textContent),violations:globalThis.__hqCompilerCsp})`)
      const failed = state.checks.filter(check => check.startsWith('FAIL'))
      if (failed.length) throw new Error(failed.join('\n'))
      return state.title === expectedTitle && state.checks.filter(check => check.startsWith('PASS')).length >= (path === '/proof' ? 25 : localization ? 32 : 19) ? state : undefined
    }, 30000, { label: `${label} ${path} rendered checks`, intervalMs: 50 })
    assert.ok(await settle(cdp, { quietMs: 150, timeoutMs: 5000 }))
    assert.deepEqual(proof.violations, [], 'No CSP violation may be hidden by proof completion')
    assert.deepEqual(failures, [], 'No unexpected failed HTTP requests')
    assert.deepEqual(forbidden, [], 'Browser fixture must not contact external services')
    assert.equal(expectedFailures.size, path === '/proof' ? 1 : 0, 'Only the explicit draft-preservation 503 is expected')
    const allowed = logs.filter(entry => entry.source === 'network' && expectedFailures.has(entry.networkRequestId || '')).map(entry => entry.text)
    const errors = [...cdp.errors]
    for (const text of allowed) { const index = errors.indexOf(text); if (index >= 0) errors.splice(index, 1) }
    assert.deepEqual(errors, [], 'No browser console/runtime/network errors beyond the exact expected negative request')
    const version = await cdp.send('Browser.getVersion')
    results.push({ label, path, passed: true, viewport, scheme, browser: version.product, protocolVersion: version.protocolVersion, policy, checks: proof.checks, expectedNegativeResponses: expectedFailures.size, requests: requests.size })
    console.info(`PASS ${label} ${scheme} ${path}: ${proof.checks.filter(check => check.startsWith('PASS')).length} rendered checks, strict CSP, ${version.product}`)
    passed = true
  }
  finally {
    let artifactFailure: unknown
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      await Bun.write(resolve(output, `${label}-${path.slice(1)}${passed ? '' : '-failed'}.png`), Buffer.from(shot.data, 'base64'))
      if (!passed) await Bun.write(resolve(output, `${label}-${path.slice(1)}-failed.json`), JSON.stringify({ url, failures, forbidden, browserErrors: cdp.errors, checks: await cdp.evaluate('document.querySelector("#checks")?.textContent') }, null, 2))
    }
    catch (error) { artifactFailure = error; console.error('Browser artifact collection failed:', error) }
    await browser?.close(); browser = undefined
    preview?.close(); preview = undefined
    if (artifactFailure) throw new Error('Browser artifact collection failed.', { cause: artifactFailure })
  }
}
try {
  if (!args.includes('--skip-build')) await build()
  const { assets, manifest } = await snapshotAssets()
  await Bun.write(resolve(output, 'report.json'), JSON.stringify({ passed: false, version: manifest.version, reason: 'Qualification in progress' }, null, 2))
  const appearances = [
    { label: 'desktop', viewport: { width: 1280, height: 900 }, scheme: 'light' },
    { label: 'mobile', viewport: { width: 390, height: 844 }, scheme: 'dark' },
  ] as const
  for (const { label, viewport, scheme } of appearances) {
    for (const path of ['/proof', '/loader-proof'] as const) await qualify(assets, path, viewport, label, scheme, manifest.locales?.includes('ar') === true)
  }
  await Bun.write(resolve(output, 'report.json'), JSON.stringify({ passed: true, built: !args.includes('--skip-build'), version: manifest.version, results }, null, 2))
  console.info(`PASS support browser qualification: ${results.length} Chromium journeys. Artifacts: ${output}`)
}
catch (error) {
  await Bun.write(resolve(output, 'report.json'), JSON.stringify({ passed: false, results, error: error instanceof Error ? error.stack || error.message : String(error) }, null, 2))
  console.error(error)
  process.exitCode = 1
}
finally { await cleanup() }
