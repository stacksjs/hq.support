import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, copyFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { launch, navigate, waitFor } from '@stacksjs/testing/browser'
import { archivePayload, assertRealInstall, directoryPayload, elements, inspectPayload, materialize, packageName, payloadHashes, sha256 } from './lib/support-elements-artifact'
import type { Payload } from './lib/support-elements-artifact'
import { readPublishedElements } from './lib/support-elements-registry'

const root = resolve(import.meta.dir, '..'), generated = resolve(root, 'storage/framework/libs/packages/support-elements')
const defaultArtifact = resolve(root, 'storage/framework/runtime/support-elements-release')
async function command(args: string[], cwd = root, timeout = 120000, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(args, { cwd, env: { ...process.env, ...env }, detached: true, stdout: 'pipe', stderr: 'pipe' })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = Promise.withResolvers<never>(); timer = setTimeout(() => deadline.reject(new Error(`Command timed out: ${args[0]}`)), timeout)
    const code = await Promise.race([child.exited, deadline.promise]), logs = (await output).join('\n')
    assert.equal(code, 0, `Command failed: ${args.slice(0, 3).join(' ')}\n${logs.slice(-12000)}`)
    return logs.trim()
  }
  finally {
    clearTimeout(timer)
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }; await Promise.race([child.exited, Bun.sleep(1000)]); try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill(9) }; await child.exited }
  }
}
function alpha(version: string) { assert.match(version, /^0\.1\.0-alpha\.\d+$/, 'Review a pinned early-alpha version before preparing or publishing') }
async function reviewedConfig(version: string) {
  const config = (await import('../config/library')).default
  assert.equal(config.packages.length, 1, 'This workflow verifies exactly one library publication')
  const configured = config.packages.find(pkg => pkg.name === packageName) as { version?: string, registry?: string } | undefined
  assert.equal(configured?.version, version, 'Pin the reviewed component version in config/library.ts')
  assert.equal(configured?.registry, 'npm')
}
async function sha() { const value = await command(['git', 'rev-parse', 'HEAD']); assert.match(value, /^[a-f0-9]{40}$/); return value }
interface Release { schemaVersion: number, name: string, version: string, sourceSha: string, archiveSha256: string, files: Record<string, string>, hosted: Record<string, string>, packer: string }
async function readRelease(directory: string, version: string, expectedSha: string) {
  alpha(version); assert.match(expectedSha, /^[a-f0-9]{40}$/)
  const release: Release = await Bun.file(resolve(directory, 'release.json')).json()
  assert.equal(release.schemaVersion, 1); assert.equal(release.name, packageName); assert.equal(release.version, version); assert.equal(release.sourceSha, expectedSha)
  assert.equal(release.packer, `bun-${Bun.version}`, 'Restore and publish with the same pinned native Bun packer')
  const bytes = new Uint8Array(await Bun.file(resolve(directory, 'package.tgz')).arrayBuffer())
  assert.equal(sha256(bytes), release.archiveSha256)
  const payload = await archivePayload(bytes); inspectPayload(payload, version); assert.deepEqual(payloadHashes(payload), release.files)
  const hosted = await directoryPayload(resolve(directory, 'hosted')); assert.deepEqual(payloadHashes(hosted), release.hosted)
  const manifest = JSON.parse(new TextDecoder().decode(hosted.get('widgets/manifest.json'))!)
  assert.ok(Buffer.from(hosted.get(`widgets/${manifest.version}/bundle.js`)!).equals(Buffer.from(payload.get('dist/bundle.js')!)), 'Hosted loader and npm package must contain the same native bundle')
  return { release, payload }
}
export async function verifyElementsConsumer(files: Payload, archive: string, version: string, registry: boolean) {
  const directory = await mkdtemp(resolve(tmpdir(), 'hq-elements-consumer-'))
  let server: ReturnType<typeof Bun.serve> | undefined
  let browser: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await Bun.write(resolve(directory, 'package.json'), JSON.stringify({ name: 'plain-support-elements-consumer', private: true, type: 'module', dependencies: { [packageName]: registry ? version : `file:${archive}` } }))
    await Bun.write(resolve(directory, 'bunfig.toml'), '[install]\nregistry="https://registry.npmjs.org"\n')
    await command([process.execPath, '--no-env-file', 'install', '--ignore-scripts', '--no-cache'], directory, 120000, { BUN_OPTIONS: '', NPM_TOKEN: '', NODE_AUTH_TOKEN: '', BUN_AUTH_TOKEN: '' })
    const installed = resolve(directory, 'node_modules/@stacksjs/support-elements'), actual = await assertRealInstall(installed)
    inspectPayload(actual, version); assert.deepEqual(payloadHashes(actual), payloadHashes(files), 'Clean installed payload must equal the reviewed CI artifact')
    const imports = elements.map((name, index) => `import type * as Bare${index} from '${packageName}/hq-support-${name}';\nimport type * as Explicit${index} from '${packageName}/hq-support-${name}.js';\n`).join('')
    await Bun.write(resolve(directory, 'consumer.ts'), `import type { Messenger, TicketForm, HelpSearch, Launcher, TicketStatus } from '${packageName}';\nimport { renderComponent } from '${packageName}/ssr';\n${imports}\nconst messenger: Messenger = document.createElement('hq-support-messenger');\nconst boot: Promise<void> = messenger.boot({url:'https://customer.example.test',project:'public-project',token:'customer-session'});\nconst form: TicketForm = document.createElement('hq-support-ticket-form');\nconst launcher: Launcher = document.createElement('hq-support-launcher');\nconst search: HelpSearch = document.createElement('hq-support-help-search');\nconst status: TicketStatus = document.createElement('hq-support-ticket-status');\nconst html: string = renderComponent('hq-support-launcher');\nvoid [boot,form,launcher,search,status,html];\n// @ts-expect-error Customer tokens cannot be numbers.\nmessenger.boot({token:123});\n`)
    await Bun.write(resolve(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, module: 'esnext', moduleResolution: 'bundler', target: 'esnext', lib: ['esnext', 'dom'], types: [] }, files: ['consumer.ts'] }))
    await command([process.execPath, resolve(root, 'node_modules/.bin/tsc'), '-p', resolve(directory, 'tsconfig.json'), '--pretty', 'false'])
    const result = inspectPayload(files, version), hashes: string[] = []
    for (const component of result.classes) {
      const module = await import(resolve(installed, `dist/${component.tag}.js`))
      const styles = module[component.name]?.definition?.styles
      assert.equal(typeof styles, 'string', 'Native shadow style metadata must be present in the installed ESM module')
      hashes.push(`'sha256-${createHash('sha256').update(styles).digest('base64')}'`)
    }
    const css = hashes.join(' ')
    const state = { entry: 'bundle.js', selected: result.classes }
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/') return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Npm consumer running</title></head><body><main id="checks"></main><script type="module" src="/proof.js"></script></body></html>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src ${css}; base-uri 'none'` } })
      if (path === '/proof.js') return new Response(`const output=document.querySelector('#checks');try {const module=await import('/package/dist/${state.entry}'); const names=${JSON.stringify(state.selected)};for(const item of names){if(typeof module[item.name]!=='function'||customElements.get(item.tag)!==module[item.name])throw new Error('Export/registration mismatch: '+item.tag);const element=document.createElement(item.tag);document.body.append(element);await element.updateComplete;if(!element.shadowRoot)throw new Error('Missing native shadow root');if('sessionToken'in element){element.sessionToken='private-consumer-token';await element.updateComplete;if(element.outerHTML.includes('private-consumer-token'))throw new Error('Token reflected');}const row=document.createElement('p');row.textContent='PASS '+item.tag;output.append(row);}document.title='Published package consumer passed';}catch(error){output.textContent=String(error.stack||error);document.title='Published package consumer failed';throw error}`, { headers: { 'Content-Type': 'text/javascript' } })
      if (path.startsWith('/package/')) { const file = files.get(path.slice('/package/'.length)); if (file) return new Response(new Uint8Array(file).buffer, { headers: { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/plain' } }) }
      if (path === '/favicon.ico') return new Response(null, { status: 204 })
      return new Response('Not found', { status: 404 })
    } })
    const journeys = []
    for (const entry of ['bundle.js', ...elements.map(name => `hq-support-${name}.js`)]) {
      state.entry = entry; state.selected = entry === 'bundle.js' ? result.classes : result.classes.filter(item => `${item.tag}.js` === entry)
      browser = await launch({ headless: true, shared: false, startTimeoutMs: 60000, chromePath: process.env.CHROME_PATH || process.env.BROWSE_BROWSER, args: process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [] })
      const cdp = browser.cdp
      await cdp.intercept([{ urlPattern: '*' }], async (paused, session) => { const url = new URL(paused.request.url); if (url.protocol !== 'about:' && url.origin !== server!.url.origin) { await session.send('Fetch.failRequest', { requestId: paused.requestId, errorReason: 'BlockedByClient' }); throw new Error('Npm consumer attempted an external service request') }; await session.send('Fetch.continueRequest', { requestId: paused.requestId }) })
      assert.ok(await navigate(cdp, server.url.href))
      const outcome = await waitFor(async () => { const title = await cdp.evaluate('document.title'); assert.notEqual(title, 'Published package consumer failed', await cdp.evaluate('document.querySelector("#checks").textContent')); return title === 'Published package consumer passed' }, 15000)
      assert.ok(outcome); assert.deepEqual(cdp.errors, [])
      journeys.push(entry); await browser.close(); browser = undefined
    }
    return { strictTypes: true, realInstall: true, browserJourneys: journeys }
  }
  finally { await browser?.close(); server?.stop(true); await rm(directory, { recursive: true, force: true }) }
}
export async function releaseCommand(mode: string, artifact: string, version: string, expectedSha: string) {
  if (mode === 'inspect') return inspectPayload(await directoryPayload(generated))
  if (mode === 'prepare') {
    assert.equal(resolve(artifact), defaultArtifact, 'Preparation only replaces its dedicated generated release directory')
    alpha(version); assert.equal(await sha(), expectedSha)
    await reviewedConfig(version)
    const native = resolve(root, 'node_modules/@stacksjs/actions')
    assert.equal((await lstat(native)).isSymbolicLink(), false, 'Use the published native build tools, not a workspace link')
    const nativeVersion = (await Bun.file(resolve(native, 'package.json')).json()).version
    assert.ok(Bun.semver.satisfies(nativeVersion, '>=0.75.581'), 'Install the released native component export and publisher fixes before preparing a candidate')
    const files = await directoryPayload(generated); inspectPayload(files, version)
    const proof = await Bun.file(resolve(root, 'storage/framework/runtime/support-browser/report.json')).json()
    assert.equal(proof.passed, true); assert.equal(proof.results.length, 4)
    await rm(artifact, { recursive: true, force: true }); await mkdir(artifact, { recursive: true })
    await command([process.execPath, 'pm', 'pack', '--filename', resolve(artifact, 'package.tgz'), '--ignore-scripts'], generated)
    const archive = new Uint8Array(await Bun.file(resolve(artifact, 'package.tgz')).arrayBuffer()), packaged = await archivePayload(archive)
    inspectPayload(packaged, version); assert.deepEqual(payloadHashes(packaged), payloadHashes(files))
    const manifest = await Bun.file(resolve(root, 'public/widgets/manifest.json')).json()
    assert.equal(proof.version, manifest.version)
    const hosted: Payload = new Map([['widgets/manifest.json', new Uint8Array(await Bun.file(resolve(root, 'public/widgets/manifest.json')).arrayBuffer())]])
    for (const file of manifest.files) { const bytes = new Uint8Array(await Bun.file(resolve(root, 'public', '.' + file.path)).arrayBuffer()); assert.equal(sha256(bytes), file.sha256); hosted.set(file.path.slice(1), bytes) }
    hosted.set('widgets/bundle.js', packaged.get('dist/bundle.js')!)
    await materialize(hosted, resolve(artifact, 'hosted')); await copyFile(resolve(root, 'storage/framework/runtime/support-browser/report.json'), resolve(artifact, 'browser-report.json'))
    const release: Release = { schemaVersion: 1, name: packageName, version, sourceSha: expectedSha, archiveSha256: sha256(archive), files: payloadHashes(packaged), hosted: payloadHashes(hosted), packer: `bun-${Bun.version}` }
    await Bun.write(resolve(artifact, 'release.json'), JSON.stringify(release, null, 2) + '\n')
    const outcome = await verifyElementsConsumer(packaged, resolve(artifact, 'package.tgz'), version, false)
    await Bun.write(resolve(artifact, 'consumer-report.json'), JSON.stringify(outcome, null, 2))
    return release
  }
  const { release, payload } = await readRelease(artifact, version, expectedSha)
  if (mode === 'restore') { await reviewedConfig(version); assert.equal(await sha(), expectedSha); await rm(generated, { recursive: true, force: true }); await materialize(payload, generated); return release }
  if (mode === 'verify') { await verifyElementsConsumer(payload, resolve(artifact, 'package.tgz'), version, false); return release }
  assert.equal(mode, 'registry', 'Expected inspect, prepare, restore, verify or registry')
  const { published, tags } = await readPublishedElements(release)
  const outcome = await verifyElementsConsumer(published, '', version, true)
  await Bun.write(resolve(artifact, 'registry-report.json'), JSON.stringify({ version, sourceSha: expectedSha, verifierSha: await sha(), archiveSha256: release.archiveSha256, tags, ...outcome }, null, 2))
  return outcome
}
if (import.meta.main) {
  const [mode = 'inspect', artifact = defaultArtifact, version = process.env.SUPPORT_ELEMENTS_VERSION || '', source = process.env.SUPPORT_ELEMENTS_SOURCE_SHA || process.env.GITHUB_SHA || ''] = process.argv.slice(2)
  console.info(JSON.stringify(await releaseCommand(mode, resolve(artifact), version, source), null, 2))
}
