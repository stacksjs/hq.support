import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { Storage } from '@stacksjs/storage'
import { startProcessor, stopProcessor } from '@stacksjs/queue/worker'
import Job from '../../app/Jobs/RunSupportImport'
import { one } from '../../app/Support/database'

await overridesReady
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
const runId = Number(process.argv[2]), mode = process.argv[3]
if (mode === 'worker') {
  const processing = startProcessor('support-imports', { concurrency: 2 })
  try {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline && !['completed', 'needs_review'].includes(String((await one('SELECT status FROM support_import_runs WHERE id = ?', [runId]))?.status))) await Bun.sleep(25)
    assert.ok(['completed', 'needs_review'].includes(String((await one('SELECT status FROM support_import_runs WHERE id = ?', [runId]))?.status)), 'native import queue reaches a terminal review/completed checkpoint')
  }
  finally { await stopProcessor({ graceMs: 1000 }); assert.equal((await processing).isOk, true) }
}
else await Job.dispatchNow({ runId, batchSize: 1 })
console.log('PASS native import resume')
