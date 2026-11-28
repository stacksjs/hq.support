import assert from 'node:assert/strict'
import { config, overridesReady } from '@stacksjs/config'
import { recoverPhoneRevocations } from '../../app/Support/phone-agents'

const peer = new URL(process.env.SUPPORT_TEST_PHONE_PROVIDER || '')
assert.equal(peer.protocol, 'http:')
assert.equal(peer.hostname, '127.0.0.1')
await overridesReady
config.database.queryLogging.enabled = false

await recoverPhoneRevocations({
  fetch(url, init) {
    const request = new URL(url)
    assert.equal(request.origin, 'https://api.twilio.com')
    return fetch(new URL(request.pathname + request.search, peer), init)
  },
})
console.info('PASS native phone revocation recovery')
