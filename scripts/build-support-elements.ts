import { copyFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// The native Buddy build is the source of the browser artifact.
const root = resolve(import.meta.dir, '..')
const build = Bun.spawn(['./buddy', 'build:web-components'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
if (await build.exited !== 0)
  throw new Error('Native support element compilation failed')
const output = resolve(root, 'public/widgets')
await mkdir(output, { recursive: true })
for (const file of ['bundle.js', 'custom-elements.json'])
  await copyFile(resolve(root, 'storage/framework/libs/packages/support-elements/dist', file), resolve(output, file))
console.info('Support elements copied to public/widgets')
