import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { supportLayoutCss } from '../resources/functions/support/loader'

// The native Buddy build is the source of the browser artifact.
const root = resolve(import.meta.dir, '..')
const build = Bun.spawn(['./buddy', 'build:web-components'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
if (await build.exited !== 0) throw new Error('Native support element compilation failed')
const source = resolve(root, 'storage/framework/libs/packages/support-elements/dist')
const output = resolve(root, 'public/widgets')
const bundle = await readFile(resolve(source, 'bundle.js'))
const elements = await readFile(resolve(source, 'custom-elements.json'))
const loaderSource = await readFile(resolve(root, 'resources/functions/support/loader.ts'))
const pkg = await Bun.file(resolve(root, 'package.json')).json()
if (!/^[a-zA-Z0-9.+-]+$/.test(pkg.version)) throw new Error('Application version cannot be used as an asset path.')
const content = createHash('sha256').update(bundle).update(elements).update(loaderSource).update(await readFile(import.meta.path)).digest('hex').slice(0, 16)
const version = `${pkg.version}-${content}`
const directory = resolve(output, version)
await mkdir(directory, { recursive: true })
const hostedLoader = await Bun.build({ entrypoints: [resolve(root, 'resources/functions/support/loader.ts')], target: 'browser', format: 'esm', minify: true, define: { SUPPORT_ELEMENT_MODULE: JSON.stringify('./bundle.js') } })
if (!hostedLoader.success || !hostedLoader.outputs[0]) throw new Error(`Hosted support loader compilation failed: ${hostedLoader.logs.join('\n')}`)
const loader = new Uint8Array(await hostedLoader.outputs[0].arrayBuffer())
const entrypoint = new TextEncoder().encode(`export { default, support, createSupport } from './widgets/${version}/support.js';\n`)
function digest(value: Uint8Array, algorithm: string, encoding: 'hex' | 'base64') { return createHash(algorithm).update(value).digest(encoding) }
function describe(path: string, value: Uint8Array) { return { path, bytes: value.byteLength, gzipBytes: gzipSync(value).byteLength, sha256: digest(value, 'sha256', 'hex'), integrity: `sha384-${digest(value, 'sha384', 'base64')}` } }
async function immutable(file: string, value: Uint8Array | string) {
  const target = Bun.file(resolve(directory, file))
  if (await target.exists()) {
    if (Buffer.compare(Buffer.from(await target.arrayBuffer()), Buffer.from(value)) !== 0) throw new Error(`Immutable support artifact changed at ${version}/${file}`)
    return
  }
  await Bun.write(target, value)
}
const css = [supportLayoutCss]
for (const module of JSON.parse(elements.toString()).modules) {
  const exports = await import(resolve(source, module.path))
  for (const declaration of module.declarations || []) {
    const styles = exports[declaration.name]?.definition?.styles
    if (declaration.customElement && typeof styles === 'string') css.push(styles)
  }
}
const manifest = {
  schemaVersion: 1,
  appVersion: pkg.version,
  version,
  entrypoint: '/support.js',
  immutableEntrypoint: `/widgets/${version}/support.js`,
  files: [describe(`/widgets/${version}/bundle.js`, bundle), describe(`/widgets/${version}/custom-elements.json`, elements), describe(`/widgets/${version}/support.js`, loader), describe('/support.js', entrypoint)],
  csp: { styleSrc: css.map(value => `'sha256-${digest(new TextEncoder().encode(value), 'sha256', 'base64')}'`) },
}
await immutable('bundle.js', bundle)
await immutable('custom-elements.json', elements)
await immutable('support.js', loader)
await immutable('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
await Bun.write(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await Bun.write(resolve(root, 'public/support.js'), entrypoint)
// Existing direct element consumers retain the compatibility URL during migration.
for (const file of ['bundle.js', 'custom-elements.json']) await copyFile(resolve(source, file), resolve(output, file))
console.info(`Support artifact ${version}: loader ${gzipSync(loader).byteLength + gzipSync(entrypoint).byteLength} bytes gzip; elements ${gzipSync(bundle).byteLength} bytes gzip`)
