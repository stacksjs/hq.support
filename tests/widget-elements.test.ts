import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const dist = resolve(root, 'storage/framework/libs/packages/support-elements/dist')

describe('native support element artifacts', () => {
  test('native build declares all five isolated custom elements', async () => {
    const manifest = await Bun.file(resolve(dist, 'custom-elements.json')).json()
    const declarations = manifest.modules.flatMap((module: { declarations?: unknown[] }) => module.declarations || [])
    const tags = declarations.map((item: { tagName: string }) => item.tagName).sort()
    expect(tags).toEqual(['hq-support-help-search', 'hq-support-launcher', 'hq-support-messenger', 'hq-support-ticket-form', 'hq-support-ticket-status'])
  })
  test('the emitted module is self contained and session secrets never reflect', async () => {
    const output = await Bun.file(resolve(root, 'public/widgets/bundle.js')).text()
    expect(output).not.toMatch(/from\s*["'](?:@stacksjs|stx)/)
    const source = await Bun.file(resolve(dist, 'hq-support-messenger.js')).text()
    expect(source).toMatch(/"attribute":\s*false/)
    expect(source).toContain('credentials: "omit"')
    expect(source).not.toMatch(/SUPPORTHQ_KEY|SUPPORTHQ_READ_KEY/)
  })
  test('browser module loads without installing a global runtime', async () => {
    const module = await import(resolve(dist, 'hq-support-messenger.js'))
    expect(module.Messenger.definition.shadowMode).toBe('open')
    expect(module.Messenger.definition.properties.sessionToken.attribute).toBe(false)
    expect(module.Messenger.definition.properties.sessionToken.reflect).toBe(false)
    expect(typeof module.Messenger.prototype.boot).toBe('function')
    expect(typeof module.Messenger.prototype.shutdown).toBe('function')
  })
})
