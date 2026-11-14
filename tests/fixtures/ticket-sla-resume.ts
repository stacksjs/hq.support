import assert from 'node:assert/strict'
import { startProcessor, stopProcessor } from '@stacksjs/queue/worker'
import { ticketSlaTick } from '../../app/Support/ticket-sla'
import { one } from '../../app/Support/database'
if (process.argv[2] === 'queue') {
  const processing = startProcessor('support-sla', { concurrency: 2 })
  try {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && !await one("SELECT id FROM support_ticket_sla_escalations WHERE ticket_id = ? AND metric = 'first_response'", [Number(process.argv[3])])) await Bun.sleep(25)
    assert.ok(await one("SELECT id FROM support_ticket_sla_escalations WHERE ticket_id = ? AND metric = 'first_response'", [Number(process.argv[3])]))
  }
  finally { await stopProcessor({ graceMs: 1000 }); assert.equal((await processing).isOk, true) }
}
else await ticketSlaTick(Number(process.argv[2]))
console.log('PASS restarted SLA worker')
