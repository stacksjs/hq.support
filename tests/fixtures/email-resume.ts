import assert from 'node:assert/strict'
import { Storage } from '@stacksjs/storage'
import { startProcessor, stopProcessor } from '@stacksjs/queue/worker'
import { one } from '../../app/Support/database'
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
const processing = startProcessor('support-email', { concurrency: 2 })
try {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && (await one('SELECT status FROM support_email_receipts WHERE id = ?', [Number(process.argv[2])]))?.status !== 'processed') await Bun.sleep(25)
  assert.equal((await one('SELECT status FROM support_email_receipts WHERE id = ?', [Number(process.argv[2])]))?.status, 'processed')
}
finally { await stopProcessor({ graceMs: 1000 }); assert.equal((await processing).isOk, true) }
console.log('PASS restarted email worker')
