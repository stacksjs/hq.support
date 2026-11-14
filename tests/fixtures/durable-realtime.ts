import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { db, workspaceTransaction, requireWorkspaceTransaction, query, one } from '../../app/Support/database'
import { createWorkspace, createProject, createSession, createConversation, reply, enqueue, usage } from '../../app/Support/service'
import { routeConversation } from '../../app/Support/routing'
import { markRead } from '../../app/Support/reads'
import { upload } from '../../app/Support/attachments'
import { Storage } from '@stacksjs/storage'
import { supportReplayStore, supportReplayInvalidations, agentReplayChannel, customerReplayChannel } from '../../app/Support/replay'

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
const unsubscribe = await bus.subscribe({ channels: names, onInvalidate: notice => { if (notice.reason === 'hint') notices.push(...notice.channels) } })
const payload = { subject: 'Public conversation', body: 'Help please', idempotencyKey: 'conversation-1' }
const created = await createConversation(project, { externalId: 'customer-1' }, payload, customer)
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
assert.deepEqual(await head(names[1]!), beforePrivate, 'private note does not advance customer head or recorded timestamps')
assert.equal(notices.filter(name => name === names[1]).length, noticeCount, 'private note sends no customer hint')
assert.equal((await head(names[0]!)).head.seq, 2)
await routeConversation(project, created.conversation.id, { assigneeId: Number(user.id) }, { userId: Number(user.id), source: 'manual' })
const firstMessage = await one('SELECT id FROM support_messages WHERE conversation_id = ? ORDER BY id LIMIT 1', [Number(created.conversation.id)])
await markRead(project, created.conversation.id, Number(user.id), firstMessage!.id)
await upload(project, created.conversation.id, new File(['Private evidence'], 'internal.txt', { type: 'text/plain' }), 'private-file')
assert.deepEqual(await head(names[1]!), beforePrivate, 'assignment, read cursor and private attachment leave customer head/time unchanged')
assert.equal(notices.filter(name => name === names[1]).length, noticeCount)
await reply(project, created.conversation.id, { body: 'Public reply', idempotencyKey: 'reply-1' }, { customer })
assert.equal((await head(names[1]!)).head.seq, 2)
const beforeRollback = await head(names[0]!), beforeCustomerRollback = await head(names[1]!)
const beforeHints = notices.length
await assert.rejects(workspaceTransaction(Number(workspace.id), async () => {
  await createConversation(project, { externalId: 'customer-1' }, { ...payload, idempotencyKey: 'rolled-back' }, customer)
  assert.equal(notices.length, beforeHints, 'inner savepoint never hints before outer commit')
  throw new Error('roll back domain and replay')
}), /roll back domain and replay/)
assert.deepEqual(await head(names[0]!), beforeRollback)
assert.deepEqual(await head(names[1]!), beforeCustomerRollback)
assert.equal(await usage(Number(workspace.id), 'conversations'), 1)
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
const beforeInnerFailure = await head(names[0]!)
await workspaceTransaction(Number(workspace.id), async () => {
  await assert.rejects(workspaceTransaction(Number(workspace.id), async () => {
    await enqueue(project, 'failed-savepoint', {})
    throw new Error('failed inner')
  }), /failed inner/)
  await enqueue(project, 'successful-outer', {})
})
assert.equal((await head(names[0]!)).head.seq, beforeInnerFailure.head.seq + 1)
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
unsubscribe()
await bus.close()
console.log('PASS durable support replay')
