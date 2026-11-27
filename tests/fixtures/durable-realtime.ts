import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestService } from '@stacksjs/testing/service'
import type { TestService } from '@stacksjs/testing/service'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import WorkflowJob from '../../app/Jobs/RunSupportWorkflows'
import { config, overridesReady } from '@stacksjs/config'
import { db, workspaceTransaction, requireWorkspaceTransaction, query, one } from '../../app/Support/database'
import { createWorkspace, createProject, createSession, createConversation, conversation, reply, enqueue, usage } from '../../app/Support/service'
import { reopenSnoozedConversations, routeConversation } from '../../app/Support/routing'
import { markRead } from '../../app/Support/reads'
import { upload } from '../../app/Support/attachments'
import { Storage } from '@stacksjs/storage'
import { supportReplayStore, supportReplayInvalidations, agentReplayChannel, customerReplayChannel } from '../../app/Support/replay'
import { supportRealtimeRedisUrl } from '../../app/Support/realtime-config'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
const user = (await query("INSERT INTO users (name, email, password) VALUES (?, ?, ?) RETURNING *", ['Replay', 'replay@example.test', 'unused-fixture-password']))[0]!
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
const workspace = await createWorkspace({ id: Number(user.id), email: 'replay@example.test' }, 'Replay fixture')
await workspaceTransaction(Number(workspace.id), async (tx) => {
  assert.equal(requireWorkspaceTransaction(Number(workspace.id)), tx)
  assert.equal(typeof tx.query, 'function')
  await workspaceTransaction(Number(workspace.id), async () => {
    await assert.rejects(tx.query('SELECT 1'), /matching active workspace transaction context/i)
  })
})
assert.throws(() => requireWorkspaceTransaction(Number(workspace.id)), /active workspace transaction/i)
const project = await createProject(Number(workspace.id), 'Replay project')
const session = await createSession(project, { externalId: 'customer-1', name: 'Ada' })
const customer = { id: Number(session.contact.id) }
const names = [agentReplayChannel(project), customerReplayChannel(project, customer.id)]
// Fixture enrollment only. Production enrollment belongs to the authorized snapshot slice.
await workspaceTransaction(Number(workspace.id), async tx => {
  const store = supportReplayStore(project, tx)
  for (const name of names) {
    await store.replay({ channel: name, after: null })
    await query('UPDATE support_replay_channels SET lease_until = ? WHERE name = ?', [Date.now() + 60_000, name])
  }
})
const notices: string[] = []
const bus = supportReplayInvalidations()
// A different process observes Redis wire delivery; producer self-delivery cannot pass this proof.
let subscriber: TestService | undefined, subscriberUrl: string | undefined, subscriberDirectory: string | undefined
let unsubscribe = () => {}
try {
if (supportRealtimeRedisUrl()) {
  subscriberDirectory = await mkdtemp(join(tmpdir(), 'support-replay-subscriber-'))
  const bunfig = join(subscriberDirectory, 'bunfig.toml')
  await writeFile(bunfig, 'preload = []\n')
  subscriber = startTestService([process.execPath, `--config=${bunfig}`, '--no-env-file', 'tests/fixtures/durable-realtime-subscriber.ts', JSON.stringify(names)], { env: { ...process.env }, startupTimeoutMs: 10_000, stderr: 'inherit', stdout: 'ignore' })
  subscriberUrl = (await subscriber.ready as { url: string }).url
}
else unsubscribe = await bus.subscribe({ channels: names, onInvalidate: notice => { if (notice.reason === 'hint') notices.push(...notice.channels) } })
async function refreshNotices() {
  if (subscriberUrl) notices.splice(0, notices.length, ...await (await fetch(subscriberUrl)).json() as string[])
}
async function receivedHints(count: number) {
  const deadline = Date.now() + 3000
  do { await refreshNotices(); if (notices.length >= count) break; await Bun.sleep(5) } while (Date.now() < deadline)
  assert.equal(notices.length, count, 'committed hint arrives through the native bus')
}
const payload = { subject: 'Public conversation', body: 'Help please', idempotencyKey: 'conversation-1' }
const created = await workspaceTransaction(Number(workspace.id), async () => {
  const result = await createConversation(project, { externalId: 'customer-1' }, payload, customer)
  await Bun.sleep(50); await refreshNotices()
  assert.equal(notices.length, 0, 'public mutation stays silent until its held outer transaction commits')
  return result
})
await receivedHints(2)
assert.equal(String((await conversation(project, created.conversation.id, { id: String(customer.id) })).id), String(created.conversation.id), 'canonical HTTP and database identifier representations name the same customer')
await assert.rejects(conversation(project, created.conversation.id, { id: customer.id + 1 }), /Conversation not found/)
async function head(name: string) {
  return await workspaceTransaction(Number(workspace.id), async tx => await supportReplayStore(project, tx).replay({ channel: name, after: null }))
}
assert.equal((await head(names[0]!)).head.seq, 1)
assert.equal((await head(names[1]!)).head.seq, 1)
assert.deepEqual((await head(names[1]!)).messages.map(event => [event.event, event.data]), [['changed', null]])
assert.equal(await usage(Number(workspace.id), 'conversations'), 1)
await createConversation(project, { externalId: 'customer-1' }, payload, customer)
assert.equal((await head(names[1]!)).head.seq, 1, 'idempotent retry does not append')
const beforePrivate = await head(names[1]!)
const noticeCount = notices.filter(name => name === names[1]).length
await reply(project, created.conversation.id, { body: 'Private investigation', visibility: 'internal', idempotencyKey: 'note-1' }, { userId: Number(user.id) })
await receivedHints(3)
assert.deepEqual(await head(names[1]!), beforePrivate, 'private note does not advance customer head or recorded timestamps')
await Bun.sleep(50); await refreshNotices()
assert.equal(notices.filter(name => name === names[1]).length, noticeCount, 'private note sends no customer hint')
assert.equal((await head(names[0]!)).head.seq, 2)
await routeConversation(project, created.conversation.id, { assigneeId: Number(user.id) }, { userId: Number(user.id), source: 'manual' })
assert.equal((await head(names[0]!)).head.seq, 3, 'an assignment advances the enrolled agent channel')
await receivedHints(4)
const routingHead = await head(names[0]!)
await routeConversation(project, created.conversation.id, { assigneeId: Number(user.id) }, { userId: Number(user.id), source: 'manual' })
assert.deepEqual(await head(names[0]!), routingHead, 'repeating the same assignment adds no activity event')
await routeConversation(project, created.conversation.id, { status: 'snoozed', snoozedUntil: Date.now() + 30_000 }, { userId: Number(user.id), source: 'manual' })
assert.equal((await head(names[0]!)).head.seq, 4, 'a follow-up schedule advances the agent channel')
await query('UPDATE support_conversations SET snoozed_until = ? WHERE id = ?', [Date.now() - 1, created.conversation.id])
assert.deepEqual(await reopenSnoozedConversations(), { reopened: 1 })
assert.deepEqual(await reopenSnoozedConversations(), { reopened: 0 })
const woke = await head(names[0]!)
assert.equal(woke.head.seq, 5, 'one worker reopen advances the agent channel exactly once')
assert.deepEqual(woke.messages.slice(-3).map(event => [event.event, event.data]), [['changed', null], ['changed', null], ['changed', null]])
assert.deepEqual(await head(names[1]!), beforePrivate, 'routing and scheduled wake-up expose no customer replay metadata')
await receivedHints(6)
const firstMessage = await one('SELECT id FROM support_messages WHERE conversation_id = ? ORDER BY id LIMIT 1', [Number(created.conversation.id)])
await markRead(project, created.conversation.id, Number(user.id), firstMessage!.id)
await upload(project, created.conversation.id, new File(['Private evidence'], 'internal.txt', { type: 'text/plain' }), 'private-file')
assert.deepEqual(await head(names[1]!), beforePrivate, 'assignment, read cursor and private attachment leave customer head/time unchanged')
await Bun.sleep(50); await refreshNotices()
assert.equal(notices.filter(name => name === names[1]).length, noticeCount)
await reply(project, created.conversation.id, { body: 'Public reply', idempotencyKey: 'reply-1' }, { customer })
assert.equal((await head(names[1]!)).head.seq, 2)
await receivedHints(8)
const beforeRollback = await head(names[0]!), beforeCustomerRollback = await head(names[1]!)
const beforeHints = notices.length
await assert.rejects(workspaceTransaction(Number(workspace.id), async () => {
  await createConversation(project, { externalId: 'customer-1' }, { ...payload, idempotencyKey: 'rolled-back' }, customer)
  await Bun.sleep(50); await refreshNotices()
  assert.equal(notices.length, beforeHints, 'inner savepoint never hints before outer commit')
  throw new Error('roll back domain and replay')
}), /roll back domain and replay/)
assert.deepEqual(await head(names[0]!), beforeRollback)
assert.deepEqual(await head(names[1]!), beforeCustomerRollback)
assert.equal(await usage(Number(workspace.id), 'conversations'), 1)
await Bun.sleep(50); await refreshNotices()
assert.equal(notices.length, beforeHints)
// Matching native transaction state alone never grants workspace authority.
await db.transaction(async () => {
  assert.throws(() => requireWorkspaceTransaction(Number(workspace.id)), /active workspace transaction/i)
  await assert.rejects(enqueue(project, 'unknown.kind', {}), /active workspace transaction/i)
})
let escapedQuery: () => Promise<unknown> = async () => undefined
let escapedHandle: () => Promise<unknown> = async () => undefined
await workspaceTransaction(Number(workspace.id), async tx => {
  assert.throws(() => requireWorkspaceTransaction(Number(workspace.id) + 1), /does not match/i)
  await assert.rejects(workspaceTransaction(Number(workspace.id) + 1, async () => undefined), /does not match/i)
  escapedHandle = () => tx.query('SELECT 1')
  await workspaceTransaction(Number(workspace.id), async () => {
    // Async context outlives this callback, while its parent remains active.
    const resource = new (await import('node:async_hooks')).AsyncResource('escaped-workspace-test')
    escapedQuery = resource.bind(async () => await query('SELECT 1'))
  })
  await assert.rejects(escapedQuery(), /active workspace transaction/i)
})
await assert.rejects(escapedHandle(), /active workspace transaction/i)
// Parent work must wait for the native savepoint, including callback-only work.
const beforeOverlap = await head(names[0]!)
const hintsBeforeOverlap = notices.length
let rejectedEffect = false
await workspaceTransaction(Number(workspace.id), async tx => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const nested = workspaceTransaction(Number(workspace.id), async () => {
    entered.resolve()
    await release.promise
    throw new Error('overlap inner rollback')
  })
  const rejected = nested.catch(error => error)
  await entered.promise
  try {
    await assert.rejects(enqueue(project, 'overlap-parent', {}), /active nested transaction/)
    await assert.rejects(tx.query('SELECT 1'), /active nested transaction/)
    assert.throws(() => tx.afterCommit(() => { rejectedEffect = true }), /active nested transaction/)
  }
  finally { release.resolve() }
  assert.match((await rejected).message, /overlap inner rollback/)
  await enqueue(project, 'after-overlap-parent', {})
})
assert.equal(await one("SELECT id FROM support_outbox WHERE kind = 'overlap-parent'"), undefined)
assert.equal((await head(names[0]!)).head.seq, beforeOverlap.head.seq + 1)
await receivedHints(hintsBeforeOverlap + 1)
assert.equal(rejectedEffect, false)
// A bare native child can close while the application workspace remains active.
await workspaceTransaction(Number(workspace.id), async tx => {
  let escaped: (() => Promise<void>) | undefined
  await db.transaction(async () => {
    const resource = new (await import('node:async_hooks')).AsyncResource('escaped-native-test')
    escaped = resource.bind(async () => {
      await assert.rejects(query('SELECT 1'), /closed transaction callback/)
      await assert.rejects(tx.query('SELECT 1'), /closed transaction callback/)
      await assert.rejects(enqueue(project, 'escaped-native', {}), /closed transaction callback/)
      assert.throws(() => tx.afterCommit(() => { rejectedEffect = true }), /closed transaction callback/)
    })
  })
  await escaped!()
})
assert.equal(await one("SELECT id FROM support_outbox WHERE kind = 'escaped-native'"), undefined)
assert.equal(rejectedEffect, false)
const beforeInnerFailure = await head(names[0]!)
await refreshNotices()
const beforeFailedSavepointHints = notices.length
await workspaceTransaction(Number(workspace.id), async () => {
  await assert.rejects(workspaceTransaction(Number(workspace.id), async () => {
    await enqueue(project, 'failed-savepoint', {})
    throw new Error('failed inner')
  }), /failed inner/)
  await enqueue(project, 'successful-outer', {})
})
assert.equal((await head(names[0]!)).head.seq, beforeInnerFailure.head.seq + 1)
await receivedHints(beforeFailedSavepointHints + 1)
assert.equal(await one("SELECT id FROM support_outbox WHERE kind = 'failed-savepoint'"), undefined)
const outboxCount = Number((await one('SELECT COUNT(*) AS n FROM support_outbox'))!.n)
const messageCount = Number((await one('SELECT COUNT(*) AS n FROM support_messages'))!.n)
// A replay failure must roll back the originating domain mutation and outbox.
const policy = (await one('SELECT policy FROM support_replay_channels WHERE name = ?', [names[0]]))!.policy
await query('UPDATE support_replay_channels SET policy = ? WHERE name = ?', ['invalid', names[0]])
await assert.rejects(reply(project, created.conversation.id, { body: 'Must roll back', idempotencyKey: 'bad-replay' }, { customer }), /policy/i)
assert.equal(Number((await one('SELECT COUNT(*) AS n FROM support_outbox'))!.n), outboxCount)
assert.equal(Number((await one('SELECT COUNT(*) AS n FROM support_messages'))!.n), messageCount)
await query('UPDATE support_replay_channels SET policy = ? WHERE name = ?', [policy, names[0]])
const beforeExpired = await head(names[1]!)
await query('UPDATE support_replay_channels SET lease_until = 0 WHERE name = ?', [names[1]])
await reply(project, created.conversation.id, { body: 'No active enrollment', idempotencyKey: 'expired' }, { customer })
assert.deepEqual(await head(names[1]!), beforeExpired)
const other = await createSession(project, { externalId: 'not-enrolled' })
await createConversation(project, { externalId: 'not-enrolled' }, { ...payload, idempotencyKey: 'unenrolled' }, { id: Number(other.contact.id) })
assert.equal(await one('SELECT id FROM support_replay_channels WHERE name = ?', [customerReplayChannel(project, Number(other.contact.id))]), undefined)
// Restart and independent-worker concurrency use the same service seam and database.
async function worker(input: Record<string, unknown>) {
  assertIsolatedOk(await runIsolated('tests/fixtures/durable-realtime-worker.ts', { args: [JSON.stringify({ projectId: project.id, ...input })], envFile: false, preload: [], timeoutMs: 30_000 }), 'PASS durable support replay worker')
}
await receivedHints(beforeFailedSavepointHints + 3)
const beforeWorkerHints = notices.length
const beforeWorkers = await head(names[0]!)
await Promise.all([worker({ mode: 'append' }), worker({ mode: 'append' })])
if (subscriber) await receivedHints(beforeWorkerHints + 10)
await worker({ mode: 'read', channel: names[0], sequence: beforeWorkers.head.seq + 10 })
const beforeDrain = await head(names[0]!)
await WorkflowJob.dispatch()
assert.ok(await one("SELECT id FROM jobs WHERE queue = 'support-workflows'"), 'native workflow queue persists before worker startup')
await worker({ mode: 'queue' })
assert.deepEqual(await head(names[0]!), beforeDrain, 'delayed outbox delivery never appends replay again')
assert.equal(await one("SELECT id FROM support_outbox WHERE kind LIKE 'realtime.%'"), undefined, 'hints introduce no generic outbox kind')
await Bun.sleep(50); await refreshNotices()
const beforeLostHintNotices = notices.length
unsubscribe()
await bus.close() // Producer-only failure: the independent Redis subscriber stays healthy.
const beforeLostHint = await head(names[0]!)
await reply(project, created.conversation.id, { body: 'Redis hint unavailable', idempotencyKey: 'lost-hint' }, { customer })
assert.equal((await head(names[0]!)).head.seq, beforeLostHint.head.seq + 1, 'a failed publisher cannot undo or advance past the committed SQL event')
await worker({ mode: 'read', channel: names[0], after: beforeLostHint.head, sequence: beforeLostHint.head.seq + 1 })
await Bun.sleep(50); await refreshNotices()
assert.equal(notices.length, beforeLostHintNotices, 'lost producer hint is recovered from SQL while the subscriber stays live')
console.log('PASS durable support replay')

}
finally {
  unsubscribe()
  await bus.close()
  await subscriber?.stop()
  if (subscriberDirectory) await rm(subscriberDirectory, { recursive: true, force: true })
}
