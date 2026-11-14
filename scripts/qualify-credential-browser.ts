import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// @stacksjs/testing owns Bun test hooks, so enter its actual test runner.
// No app preload, source aliases, persistent database or provider traffic.
const root = resolve(import.meta.dir, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'hq-support-credential-runner-'))
let child: ReturnType<typeof Bun.spawn> | undefined
function stop() {
  if (child?.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
  }
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
try {
  const config = resolve(temporary, 'bunfig.toml')
  await Bun.write(config, '[test]\npreload = []\n')
  child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', 'test', './tests/feature/credentials.test.ts'], { cwd: root, env: { ...process.env, SUPPORT_CREDENTIAL_BROWSER: '1' }, stdout: 'inherit', stderr: 'inherit', detached: true })
  const timeout = setTimeout(stop, 220000)
  try { process.exitCode = await child.exited }
  finally { clearTimeout(timeout) }
}
finally { stop(); process.off('SIGINT', stop); process.off('SIGTERM', stop); await rm(temporary, { recursive: true, force: true }) }
