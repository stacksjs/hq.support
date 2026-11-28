import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import app from '../package.json'

const sdk = '@stacksjs/support'
const version = app.dependencies[sdk]
const directory = await mkdtemp(join(tmpdir(), 'hq-support-sdk-'))

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, '--no-env-file', ...args], {
    cwd: directory,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  assert.equal(await child.exited, 0, `Failed: bun ${args.join(' ')}`)
}

try {
  const manifest = {
    name: 'hq-support-sdk-qualification',
    private: true,
    type: 'module',
    dependencies: { '@stacksjs/buddy': app.dependencies.stacks },
  }
  const manifestPath = join(directory, 'package.json')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(directory, 'bunfig.toml'), '[install]\nlinker = "isolated"\n')
  await run(['install', '--ignore-scripts'])
  await run(['x', '--no-install', 'buddy', 'support:install', '--sdk-only', '--sdk-version', version])

  const installed = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.deepEqual(installed.dependencies, { ...manifest.dependencies, [sdk]: version })
  assert.equal(await Bun.file(join(directory, '.env')).exists(), false, 'SDK-only install must not write connection settings')

  const lockPath = join(directory, 'bun.lock')
  const lock = await readFile(lockPath)
  await run(['install', '--frozen-lockfile', '--ignore-scripts'])
  assert.deepEqual(await readFile(lockPath), lock)

  for (const entry of [sdk, `${sdk}/server`, `${sdk}/browser`, `${sdk}/testing`]) {
    await run(['-e', `await import(${JSON.stringify(entry)})`])
  }
  console.log(`Verified ${sdk}@${version} through Buddy in a clean isolated app.`)
}
finally {
  await rm(directory, { recursive: true, force: true })
}
