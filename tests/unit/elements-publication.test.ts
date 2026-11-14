import { describe, expect, test } from 'bun:test'
import { archivePayload, elements, inspectPayload, packageName } from '../../scripts/lib/support-elements-artifact'
import type { Payload } from '../../scripts/lib/support-elements-artifact'
import { assertElementsCiRun } from '../../scripts/verify-elements-ci'

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
