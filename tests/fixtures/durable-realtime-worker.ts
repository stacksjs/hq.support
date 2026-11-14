import assert from 'node:assert/strict'
import { config, overridesReady } from '@stacksjs/config'
import { startProcessor, stopProcessor } from '@stacksjs/queue/worker'
import { one, workspaceTransaction } from '../../app/Support/database'
import { enqueue } from '../../app/Support/service'
import { supportReplayInvalidations, supportReplayStore } from '../../app/Support/replay'

await overridesReady
config.database.queryLogging.enabled = false
const input = JSON.parse(process.argv[2]!)
const project = (await one('SELECT * FROM support_projects WHERE id = ?', [input.projectId]))!
if (input.mode === 'append') {
  await workspaceTransaction(Number(project.workspace_id), async () => {
    for (let index = 0; index < 5; index++) await enqueue(project, 'worker.changed', {})
  })
  await supportReplayInvalidations().close()
}
else if (input.mode === 'queue') {
  const processing = startProcessor('support-workflows', { concurrency: 1 })
  try {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && await one("SELECT id FROM jobs WHERE queue = 'support-workflows'")) await Bun.sleep(25)
    assert.equal(await one("SELECT id FROM jobs WHERE queue = 'support-workflows'"), undefined, 'new worker drains the persisted native job')
    assert.ok(await one("SELECT id FROM support_outbox WHERE status = 'delivered' AND kind = 'conversation.created'"), 'existing workflow consumer retains its kinds')
  }
  finally { await stopProcessor({ graceMs: 1000 }); assert.equal((await processing).isOk, true) }
}
else {
  const page = await workspaceTransaction(Number(project.workspace_id), async tx => await supportReplayStore(project, tx).replay({ channel: input.channel, after: null }))
  assert.equal(page.head.seq, input.sequence, 'new process reads the persisted checkpoint')
  assert.deepEqual(page.messages.map(message => message.seq), Array.from({ length: input.sequence }, (_, index) => index + 1), 'committed sequences stay contiguous')
  assert.ok(page.messages.every(message => message.event === 'changed' && message.data === null))
}
console.log('PASS durable support replay worker')
