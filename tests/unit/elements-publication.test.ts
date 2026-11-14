import { describe, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { archivePayload, elements, inspectPayload, packageName, payloadHashes, sha256 } from '../../scripts/lib/support-elements-artifact'
import type { Payload } from '../../scripts/lib/support-elements-artifact'
import { assertElementsCiRun } from '../../scripts/verify-elements-ci'
import { createRegistryReader, readPublishedElements } from '../../scripts/lib/support-elements-registry'

function fixture(): Payload {
  const bytes = (value: string) => new TextEncoder().encode(value), files: Payload = new Map(), exports: Record<string, unknown> = { '.': { types: './dist/index.d.ts', import: './dist/bundle.js', default: './dist/bundle.js' } }
  exports['./custom-elements.json'] = './dist/custom-elements.json'
  const ssr = { types: './dist/ssr.d.ts', import: './dist/ssr.js', default: './dist/ssr.js' }; exports['./ssr'] = ssr; exports['./ssr.js'] = ssr
  files.set('dist/ssr.js', bytes('export function renderComponent(){return ""}')); files.set('dist/ssr.d.ts', bytes('export declare function renderComponent(): string'))
  const declarations = []
  for (const [index, name] of elements.entries()) {
    const tag = `hq-support-${name}`, entry = { types: `./dist/${tag}.d.ts`, import: `./dist/${tag}.js`, default: `./dist/${tag}.js` }
    exports[`./${tag}`] = entry; exports[`./${tag}.js`] = entry; exports[`./${tag}.css`] = `./dist/${tag}.css`
    files.set(`dist/${tag}.js`, bytes(`export class Element${index} extends HTMLElement { static definition = {styles: ':host{display:block}'} }`))
    files.set(`dist/${tag}.d.ts`, bytes(`export declare class Element${index} extends HTMLElement {}`)); files.set(`dist/${tag}.css`, bytes(':host{display:block}'))
    declarations.push({ customElement: true, name: `Element${index}`, tagName: tag })
  }
  files.set('package.json', bytes(JSON.stringify({ name: packageName, version: '0.1.0-alpha.0', type: 'module', license: 'MIT', publishConfig: { access: 'public' }, exports })))
  files.set('README.md', bytes('Standalone public components.'))
  files.set('dist/bundle.js', bytes('export const packageMarker = true'))
  files.set('dist/index.d.ts', bytes('export declare const packageMarker: boolean'))
  files.set('dist/custom-elements.json', bytes(JSON.stringify({ modules: [{ declarations }] })))
  return files
}
function changeManifest(files: Payload, mutate: (manifest: any) => void) { const manifest = JSON.parse(new TextDecoder().decode(files.get('package.json'))); mutate(manifest); files.set('package.json', new TextEncoder().encode(JSON.stringify(manifest))) }
describe('component publication artifact boundary', () => {
  test('accepts a complete standalone five-element payload', () => { expect(inspectPayload(fixture(), '0.1.0-alpha.0').classes).toHaveLength(5) })
  test('rejects advertised files missing from the archive', () => { const files = fixture(); changeManifest(files, manifest => { manifest.exports['./style.css'] = './dist/bundle.css' }); expect(() => inspectPayload(files)).toThrow('missing') })
  test('rejects wildcard and doubled extension export facades', () => { const files = fixture(); changeManifest(files, manifest => { manifest.exports['./*'] = './dist/*.js' }); expect(() => inspectPayload(files)).toThrow('actual emitted') })
  test('rejects a changed reviewed version', () => { expect(() => inspectPayload(fixture(), '0.1.0-alpha.1')).toThrow('reviewed version') })
  test('rejects source/server files and embedded secret access', () => {
    const files = fixture(); files.set('app/Support/private.ts', new TextEncoder().encode('server source')); expect(() => inspectPayload(files)).toThrow('Unexpected published')
    files.delete('app/Support/private.ts'); files.set('dist/private.js', new TextEncoder().encode('export const key = process.env.AWS_SECRET_ACCESS_KEY')); expect(() => inspectPayload(files)).toThrow('Server/private')
  })
  test('rejects runtime imports of server packages', () => { const files = fixture(); files.set('dist/private.js', new TextEncoder().encode("import {Auth} from '@stacksjs/auth'; export {Auth}")); expect(() => inspectPayload(files)).toThrow('Nonstandalone') })
  test('rejects consumer lifecycle scripts', () => { const files = fixture(); changeManifest(files, manifest => { manifest.scripts = { postinstall: 'run-private-code' } }); expect(() => inspectPayload(files)).toThrow('lifecycle scripts') })
  test('rejects archive members outside the package root', async () => {
    const input = Object.fromEntries([...fixture()].map(([path, value]) => [`package/${path}`, value])); input['outside.txt'] = new TextEncoder().encode('unexpected')
    await expect(archivePayload(await new Bun.Archive(input, { compress: 'gzip' }).bytes())).rejects.toThrow('Unsafe archive path')
  })
})
describe('same-SHA successful main CI gate', () => {
  const repository = 'stacksjs/hq.support', sha = 'a'.repeat(40)
  const run = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml', repository: { full_name: repository }, head_repository: { full_name: repository } }
  test('accepts the exact successful main run', () => { expect(() => assertElementsCiRun(run, repository, sha)).not.toThrow() })
  test('rejects other commits, forks, workflows and incomplete/failed CI', () => {
    for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'feature' }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }, { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'other/fork' } }]) expect(() => assertElementsCiRun({ ...run, ...change }, repository, sha)).toThrow()
  })
})
describe('public registry readback', () => {
  test('waits for an uploaded version to become readable', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return ++requests < 3 ? new Response('processing', { status: 404 }) : Response.json({ version: '0.1.0-alpha.0' }) } })
    try {
      const read = createRegistryReader({ deadlineMs: 2000, retryDelayMs: 5 })
      expect(JSON.parse(new TextDecoder().decode(await read(server.url, true))).version).toBe('0.1.0-alpha.0')
      expect(requests).toBe(3)
    }
    finally { server.stop(true) }
  })
  test('recovers from rate limiting, service failure and a transient network rejection', async () => {
    let requests = 0, networkAttempts = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { const status = [429, 503, 200][requests++]!; return new Response('public bytes', { status }) } })
    try {
      const read = createRegistryReader({ deadlineMs: 2000, retryDelayMs: 5, fetch: (url, init) => { if (++networkAttempts === 1) return Promise.reject(new TypeError('fixture connection reset')); return fetch(url, init) } })
      expect(new TextDecoder().decode(await read(server.url))).toBe('public bytes')
      expect(requests).toBe(3)
    }
    finally { server.stop(true) }
  })
  test('fails terminal HTTP responses immediately, including archive 404 and redirects', async () => {
    for (const status of [400, 401, 403, 404, 409, 302]) {
      let requests = 0
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('refused', { status, headers: { Location: '/other' } }) } })
      try {
        await expect(createRegistryReader({ deadlineMs: 2000, retryDelayMs: 5 })(server.url)).rejects.toThrow(`HTTP ${status}`)
        expect(requests).toBe(1)
      }
      finally { server.stop(true) }
    }
  })
  test('bounds repeated processing responses and never starts another read after the shared deadline', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('processing', { status: 404 }) } })
    const started = performance.now(), read = createRegistryReader({ deadlineMs: 60, retryDelayMs: 5 })
    try {
      await expect(read(server.url, true)).rejects.toThrow('deadline exceeded')
      expect(performance.now() - started).toBeLessThan(1000)
      expect(requests).toBeGreaterThan(1)
      const previous = requests
      await expect(read(server.url, true)).rejects.toThrow('deadline exceeded')
      expect(requests).toBe(previous)
    }
    finally { server.stop(true) }
  })
  test('a Retry-After longer than the budget cannot extend it', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Response('busy', { status: 429, headers: { 'Retry-After': '3600' } }) } })
    const started = performance.now()
    try {
      await expect(createRegistryReader({ deadlineMs: 40, retryDelayMs: 5 })(server.url)).rejects.toThrow('deadline exceeded')
      expect(performance.now() - started).toBeLessThan(1000)
      expect(requests).toBe(1)
    }
    finally { server.stop(true) }
  })
  test('an early timer wake cannot retry before Retry-After or configured backoff is eligible', async () => {
    for (const retryAfter of ['3600', undefined]) {
      const received: number[] = [], retryDelayMs = 30
      let respondedAt = 0
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
        received.push(performance.now())
        if (received.length > 1) return new Response('public bytes')
        respondedAt = performance.now()
        return new Response('busy', { status: 429, headers: retryAfter ? { 'Retry-After': retryAfter } : undefined })
      } })
      // Model the observed early timer wake, while keeping all HTTP and later waits real.
      const sleep = spyOn(Bun, 'sleep').mockImplementationOnce(async () => {})
      try {
        const read = createRegistryReader({ deadlineMs: retryAfter ? 80 : 2000, retryDelayMs })
        if (retryAfter) {
          await expect(read(server.url)).rejects.toThrow('deadline exceeded')
          expect(received).toHaveLength(1)
        }
        else {
          expect(new TextDecoder().decode(await read(server.url))).toBe('public bytes')
          expect(received).toHaveLength(2)
          expect(received[1]! - respondedAt).toBeGreaterThanOrEqual(retryDelayMs)
        }
      }
      finally { sleep.mockRestore(); server.stop(true) }
    }
  })
  test('bounds stalled response headers and bodies', async () => {
    for (const stallBody of [false, true]) {
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
        if (!stallBody) return new Promise<Response>(() => {})
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('incomplete')) } }))
      } })
      const started = performance.now()
      try {
        await expect(createRegistryReader({ deadlineMs: 60, requestTimeoutMs: 20, retryDelayMs: 5 })(server.url)).rejects.toThrow('deadline exceeded')
        expect(performance.now() - started).toBeLessThan(1000)
      }
      finally { server.stop(true) }
    }
  })
  test('accepts only the exact public archive, payload and alpha tag', async () => {
    const files = fixture(), bytes = await new Bun.Archive(Object.fromEntries([...files].map(([path, value]) => [`package/${path}`, value])), { compress: 'gzip' }).bytes()
    const release = { version: '0.1.0-alpha.0', archiveSha256: sha256(bytes), files: payloadHashes(files) }
    const original = { name: packageName, version: release.version, dist: { tarball: 'https://registry.npmjs.org/archive.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } }
    let metadata: unknown = original, archive = bytes, alpha = release.version, requests: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      const path = new URL(request.url).pathname; requests.push(path)
      if (path === '/archive.tgz') return new Response(new Uint8Array(archive))
      if (path.endsWith(`/${release.version}`)) return new Response(typeof metadata === 'string' ? metadata : JSON.stringify(metadata))
      return Response.json({ 'dist-tags': { alpha } })
    } })
    const read = () => createRegistryReader({ deadlineMs: 2000, retryDelayMs: 5, fetch: (url, init) => fetch(new URL(new URL(url).pathname, server.url), init) })
    try {
      expect(payloadHashes((await readPublishedElements(release, read())).published)).toEqual(release.files)
      for (const invalid of ['invalid JSON', { ...original, name: '@other/package' }, { ...original, dist: { ...original.dist, tarball: 'https://other.example.test/archive.tgz' } }, { ...original, dist: {} }]) {
        metadata = invalid; requests = []
        await expect(readPublishedElements(release, read())).rejects.toThrow()
        expect(requests).toHaveLength(1)
      }
      metadata = original; archive = new TextEncoder().encode('different archive'); requests = []
      await expect(readPublishedElements(release, read())).rejects.toThrow()
      expect(requests).toHaveLength(2)
      archive = bytes; requests = []
      await expect(readPublishedElements({ ...release, archiveSha256: '0'.repeat(64) }, read())).rejects.toThrow('archive bytes differ')
      expect(requests).toHaveLength(2)
      requests = []
      await expect(readPublishedElements({ ...release, files: { 'package.json': '0'.repeat(64) } }, read())).rejects.toThrow('payload differs')
      expect(requests).toHaveLength(2)
      alpha = '0.1.0-alpha.1'; requests = []
      await expect(readPublishedElements(release, read())).rejects.toThrow('tagged alpha')
      expect(requests).toHaveLength(3)
    }
    finally { server.stop(true) }
  })
})
