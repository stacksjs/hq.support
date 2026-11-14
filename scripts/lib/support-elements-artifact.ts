import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export const packageName = '@stacksjs/support-elements'
export const elements = ['help-search', 'launcher', 'messenger', 'ticket-form', 'ticket-status'] as const
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export type Payload = Map<string, Uint8Array>
export async function directoryPayload(directory: string): Promise<Payload> {
  const files: Payload = new Map()
  async function visit(prefix: string) {
    for (const name of await readdir(resolve(directory, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name, entry = await lstat(resolve(directory, path))
      assert.ok(!entry.isSymbolicLink(), `Package symlinks are refused: ${path}`)
      if (entry.isDirectory()) await visit(path)
      else { assert.ok(entry.isFile()); files.set(path, new Uint8Array(await Bun.file(resolve(directory, path)).arrayBuffer())) }
    }
  }
  await visit('')
  return files
}
export async function archivePayload(bytes: Uint8Array): Promise<Payload> {
  assert.ok(bytes.length < 10 * 1024 * 1024, 'Package tarball exceeds 10 MiB')
  const entries = await new Bun.Archive(bytes).files(), result: Payload = new Map()
  assert.ok(entries.size > 5 && entries.size < 200, 'Unexpected package archive size')
  let size = 0
  for (const [path, file] of entries) {
    assert.ok(path.startsWith('package/') && !path.includes('\\') && !path.split('/').some(segment => ['.', '..', ''].includes(segment)), `Unsafe archive path: ${path}`)
    size += file.size
    assert.ok(size < 20 * 1024 * 1024, 'Unpacked package exceeds 20 MiB')
    result.set(path.slice(8), new Uint8Array(await file.arrayBuffer()))
  }
  return result
}
export function payloadHashes(files: Payload): Record<string, string> { return Object.fromEntries([...files].sort(([left], [right]) => left.localeCompare(right)).map(([name, bytes]) => [name, sha256(bytes)])) }
export function inspectPayload(files: Payload, expectedVersion?: string): { version: string, classes: { name: string, tag: string }[] } {
  const text = (path: string) => { const value = files.get(path); assert.ok(value, `Missing package file: ${path}`); return new TextDecoder().decode(value) }
  const pkg = JSON.parse(text('package.json'))
  assert.equal(pkg.name, packageName); assert.equal(pkg.type, 'module'); assert.equal(pkg.private, undefined)
  if (expectedVersion) assert.equal(pkg.version, expectedVersion, 'Candidate version must match the reviewed version')
  assert.equal(pkg.license, 'MIT'); assert.deepEqual(pkg.publishConfig, { access: 'public' })
  assert.deepEqual(pkg.dependencies || {}, {}, 'Standalone elements must not depend on server/framework packages')
  assert.deepEqual(pkg.optionalDependencies || {}, {}); assert.equal(pkg.devDependencies, undefined)
  assert.deepEqual(pkg.peerDependencies || {}, {}); assert.equal(pkg.scripts, undefined, 'Publish/consumer lifecycle scripts are not permitted')
  assert.ok(!pkg.exports['./*'], 'Component exports must name actual emitted files')
  for (const [key, entry] of Object.entries(pkg.exports as Record<string, unknown>)) {
    for (const target of typeof entry === 'string' ? [entry] : Object.values(entry as Record<string, string>)) {
      assert.ok(target.startsWith('./dist/') && !target.includes('*') && !target.includes('..'), `Unsafe or invented export target: ${key}`)
      assert.ok(files.has(target.slice(2)), `Export ${key} points at missing ${target}`)
    }
  }
  assert.equal(pkg.exports['.'].types, './dist/index.d.ts')
  assert.equal(pkg.exports['.'].import, './dist/bundle.js')
  assert.equal(pkg.exports['./custom-elements.json'], './dist/custom-elements.json')
  assert.equal(pkg.exports['./ssr']?.types, './dist/ssr.d.ts'); assert.equal(pkg.exports['./ssr']?.import, './dist/ssr.js')
  assert.deepEqual(pkg.exports['./ssr.js'], pkg.exports['./ssr'])
  const manifest = JSON.parse(text('dist/custom-elements.json'))
  const declarations = manifest.modules.flatMap((module: any) => module.declarations || []).filter((entry: any) => entry.customElement)
  assert.deepEqual(declarations.map((entry: any) => entry.tagName).sort(), elements.map(name => `hq-support-${name}`).sort())
  for (const name of elements) {
    const stem = `hq-support-${name}`, path = `./${stem}`
    assert.equal(pkg.exports[path]?.import, `./dist/${stem}.js`); assert.equal(pkg.exports[path]?.types, `./dist/${stem}.d.ts`)
    assert.deepEqual(pkg.exports[path + '.js'], pkg.exports[path], 'Explicit JS extension must resolve once')
    assert.equal(pkg.exports[path + '.css'], `./dist/${stem}.css`)
    assert.ok(text(`dist/${stem}.js`).length > 50); assert.ok(text(`dist/${stem}.d.ts`).includes('extends HTMLElement'))
  }
  for (const [path, bytes] of files) {
    assert.ok(['package.json', 'README.md', 'LICENSE', 'LICENSE.md'].includes(path) || /^dist\/[a-zA-Z0-9._/-]+\.(?:js|css|json|d\.ts)$/.test(path), `Unexpected published source or private file: ${path}`)
    const value = new TextDecoder().decode(bytes)
    assert.ok(!/process\.env|SUPPORTHQ_(?:READ_)?KEY|STRIPE_SECRET_KEY|AWS_SECRET_ACCESS_KEY|SUPPORT_EMAIL_REPLY_KEY|BEGIN (?:RSA |EC )?PRIVATE KEY|enterprise\/license|app\/Support\//.test(value), `Server/private marker in ${path}`)
    if (path.endsWith('.js')) for (const dependency of new Bun.Transpiler({ loader: 'js' }).scanImports(value)) {
      assert.ok(dependency.path.startsWith('./') || dependency.path.startsWith('../'), `Nonstandalone dependency ${dependency.path} in ${path}`)
      const target = resolve('/package', path, '..', dependency.path).slice('/package/'.length)
      assert.ok(!target.startsWith('..') && files.has(target), `Missing dependency ${dependency.path} in ${path}`)
    }
  }
  text('README.md')
  return { version: String(pkg.version), classes: declarations.map((entry: any) => ({ name: String(entry.name), tag: String(entry.tagName) })) }
}
export async function materialize(files: Payload, directory: string) {
  for (const [path, bytes] of files) {
    const target = resolve(directory, path)
    assert.ok(target.startsWith(resolve(directory) + sep)); await mkdir(resolve(target, '..'), { recursive: true }); await Bun.write(target, bytes)
  }
}
export async function assertRealInstall(directory: string) {
  assert.equal((await lstat(directory)).isSymbolicLink(), false)
  assert.ok((await realpath(directory)).startsWith((await realpath(resolve(directory, '../../..'))) + sep), 'Package must be installed in the disposable consumer')
  const files = await directoryPayload(directory)
  // Bun adds this installer marker; it is never accepted in a published archive.
  files.delete('.bun-tag')
  return files
}
