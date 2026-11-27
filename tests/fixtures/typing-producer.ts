import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { supportTypingInvalidations, updateCustomerPresence } from '../../app/Support/inbox-presence'
import { project } from '../../app/Support/service'

await overridesReady
const { projectId, conversationId, token, input } = await Bun.stdin.json()
try {
  const result = await updateCustomerPresence(await project(projectId), conversationId, token, input, Date.now())
  assert.deepEqual(result, { accepted: true })
  console.log('PASS independent typing producer')
}
finally { await supportTypingInvalidations().close() }
