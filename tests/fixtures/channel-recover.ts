import assert from 'node:assert/strict'
import { dispatchChannelDelivery } from '../../app/Support/managed-channels'
import { one } from '../../app/Support/database'
const id = Number(process.argv[2])
assert.equal((await dispatchChannelDelivery(id)).dispatched, false)
const row = await one('SELECT status FROM support_channel_deliveries WHERE id = ?', [id])
assert.equal(row?.status, 'unknown')
console.log('PASS channel restart holds uncertain dispatch')
