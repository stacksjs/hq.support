import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { startProcessor, stopProcessor } from '@stacksjs/queue/worker'
import { one } from '../../app/Support/database'

await overridesReady
const now = Number(process.argv[2])
assert.ok(Number.isSafeInteger(now))
Date.now = () => now
const processor = startProcessor('support-workflows', { concurrency: 2 })
try {
  const pending = () => one("SELECT id FROM jobs WHERE queue = 'support-workflows' LIMIT 1")
  const deadline = performance.now() + 25_000
  while (await pending() && performance.now() < deadline) await Bun.sleep(25)
  assert.equal(await pending(), undefined, 'the native worker completed the scheduled jobs')
}
finally {
  await stopProcessor({ graceMs: 1_000 })
  assert.equal((await processor).isOk, true)
}
console.info('PASS scheduled snooze queue')
