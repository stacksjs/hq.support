import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { supportReplyTypingInvalidations, supportTypingInvalidations, updateCustomerPresence, updateInboxPresence } from '../../app/Support/inbox-presence'
import { project } from '../../app/Support/service'

await overridesReady
const { projectId, conversationId, token, userId, input } = await Bun.stdin.json()
try {
  const selected = await project(projectId)
  if (userId) assert.ok(await updateInboxPresence(selected, conversationId, Number(userId), input))
  else assert.deepEqual(await updateCustomerPresence(selected, conversationId, token, input, Date.now()), { accepted: true })
  console.log('PASS independent typing producer')
}
finally { await (userId ? supportReplyTypingInvalidations() : supportTypingInvalidations()).close() }
