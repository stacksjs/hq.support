import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  test('the emitted widget is self contained and omits browser credentials', async () => {
    const output = await Bun.file(resolve(root, 'public/widgets/bundle.js')).text()
    expect(output).not.toMatch(/from\s*["'](?:@stacksjs|stx)/)
    const source = await Bun.file(resolve(dist, 'hq-support-messenger.js')).text()
    expect(source).toMatch(/\bcredentials\s*:\s*["']omit["']/)
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
  test('compiled ticket form only reads public scoped form definitions', async () => {
    const source = await Bun.file(resolve(dist, 'hq-support-ticket-form.js')).text()
    expect(source).toContain('/api/widget/projects/')
    expect(source).toContain('/ticket-types')
    expect(source).not.toContain('/ticket-configuration')
    const module = await import(resolve(dist, 'hq-support-ticket-form.js'))
    expect(module.TicketForm.definition.properties.sessionToken.attribute).toBe(false)
    expect(module.TicketForm.definition.properties.sessionToken.reflect).toBe(false)
    expect(typeof module.TicketForm.prototype.refresh).toBe('function')
    expect(typeof module.TicketForm.prototype.shutdown).toBe('function')
  })
  test('a standalone strict TypeScript host can use the generated messenger lifecycle', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'hq-support-widget-types-'))
    try {
      const types = resolve(dist, 'hq-support-messenger.js')
      const ticketTypes = resolve(dist, 'hq-support-ticket-form.js')
      await Bun.write(resolve(directory, 'consumer.ts'), `
import type { Messenger } from ${JSON.stringify(types)}
import type { TicketForm } from ${JSON.stringify(ticketTypes)}
const messenger: Messenger = document.createElement('hq-support-messenger')
const boot: Promise<void> = messenger.boot({ url: 'https://hq.support', project: 'public-id', token: 'session', locale: 'ar' })
const update: Promise<void> = messenger.update({ token: 'new-session' })
const language: Promise<void> = messenger.update({ locale: 'de' })
const track: Promise<{ id: string, accepted: boolean }> = messenger.track({ event: 'project.viewed', attributes: { section: 'settings' } })
const open: void = messenger.open()
const close: void = messenger.close()
const shutdown: void = messenger.shutdown()
// @ts-expect-error Customer tokens are strings.
messenger.boot({ token: 123 })
// @ts-expect-error Tracking requires an event name.
messenger.track({ attributes: {} })
const form: TicketForm = document.createElement('hq-support-ticket-form')
const refreshForm: Promise<void> = form.refresh()
const shutdownForm: void = form.shutdown()
void [boot, update, language, track, open, close, shutdown, refreshForm, shutdownForm]
`)
      await Bun.write(resolve(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: false, target: 'esnext', lib: ['esnext', 'dom'], module: 'esnext', moduleResolution: 'bundler', types: [] }, files: ['consumer.ts'] }))
      const compiler = Bun.spawn(['bun', 'x', '--bun', 'tsc', '-p', resolve(directory, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const output = await new Response(compiler.stdout).text() + await new Response(compiler.stderr).text()
      expect(await compiler.exited, output).toBe(0)
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }, 30000)

})
