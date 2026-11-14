import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dir, '..')
describe('hosted support publication', () => {
  test('the manifest addresses and verifies every hosted artifact', async () => {
    const manifest = await Bun.file(resolve(root, 'public/widgets/manifest.json')).json()
    expect(manifest.version).toMatch(new RegExp(`^${manifest.appVersion.replaceAll('.', '\\.')}[-][a-f0-9]{16}$`))
    expect(await Bun.file(resolve(root, `public/widgets/${manifest.version}/manifest.json`)).json()).toEqual(manifest)
    expect(manifest.files).toHaveLength(4)
    for (const entry of manifest.files) {
      const bytes = new Uint8Array(await Bun.file(resolve(root, 'public', entry.path.slice(1))).arrayBuffer())
      expect(bytes.byteLength).toBe(entry.bytes)
      expect(gzipSync(bytes).byteLength).toBe(entry.gzipBytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
      expect(`sha384-${createHash('sha384').update(bytes).digest('base64')}`).toBe(entry.integrity)
    }
    expect(manifest.files.reduce((sum: number, entry: { gzipBytes: number, path: string }) => sum + (entry.path.endsWith('.js') ? entry.gzipBytes : 0), 0)).toBeLessThan(100 * 1024)
    expect(manifest.csp.styleSrc.length).toBe(6)
  })
  test('the public loader uses the immutable native module without eval', async () => {
    const manifest = await Bun.file(resolve(root, 'public/widgets/manifest.json')).json()
    const loader = await Bun.file(resolve(root, 'public/support.js')).text()
    expect(loader).toContain(`./widgets/${manifest.version}/support.js`)
    const immutable = await Bun.file(resolve(root, 'public', manifest.immutableEntrypoint.slice(1))).text()
    expect(immutable).toContain('./bundle.js')
    expect(immutable).not.toMatch(/\beval\s*\(|new\s+Function\s*\(/)
    expect(immutable).not.toContain('SUPPORT_ELEMENT_MODULE')
    const native = await Bun.file(resolve(root, 'storage/framework/libs/packages/support-elements/dist/bundle.js')).text()
    expect(await Bun.file(resolve(root, `public/widgets/${manifest.version}/bundle.js`)).text()).toBe(native)
  })
})
