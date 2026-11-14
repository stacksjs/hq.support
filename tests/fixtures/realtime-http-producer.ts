import assert from 'node:assert/strict'
import { config, overridesReady } from '@stacksjs/config'
import { one } from '../../app/Support/database'
import { reply } from '../../app/Support/service'
import { supportReplayInvalidations } from '../../app/Support/replay'

await overridesReady
config.database.queryLogging.enabled = false
const input = JSON.parse(process.argv[2]!)
const project = (await one('SELECT * FROM support_projects WHERE id = ?', [input.projectId]))!
const result = await reply(project, input.conversationId, { body: input.body, visibility: input.visibility || 'public', idempotencyKey: input.key }, { userId: input.userId })
assert(result.message)
await supportReplayInvalidations().close()
console.log('PASS independent HTTP replay producer')
