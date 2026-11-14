import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { startProcessor, stopProcessor } from '@stacksjs/queue/worker'
import Job from '../../app/Jobs/RunSupportWorkflows'
import { one } from '../../app/Support/database'

await overridesReady
const runId = Number(process.argv[2]), target = process.argv[3]
if (target) {
  const processing = startProcessor('support-workflows', { concurrency: 2 })
  try {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && (await one('SELECT status FROM support_workflow_runs WHERE id = ?', [runId]))?.status !== target) await Bun.sleep(25)
    assert.equal((await one('SELECT status FROM support_workflow_runs WHERE id = ?', [runId]))?.status, target, 'native queue worker reaches persisted run checkpoint')
  }
  finally { await stopProcessor({ graceMs: 1000 }); assert.equal((await processing).isOk, true) }
}
else await Job.dispatchNow({ runId })
console.log('PASS native workflow resume')
