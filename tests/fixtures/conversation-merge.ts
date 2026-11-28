import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'

await overridesReady
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()

const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const api = `http://127.0.0.1:${server.port}/api`
const widgetOrigin = 'https://merge-customer.example.test'
let csrf = '', cookie = ''
async function json(path: string, method = 'GET', token?: string, body?: unknown, origin?: string) {
  const response = await fetch(api + path, {
    method,
    headers: {
      accept: 'application/json',
      ...(origin ? { origin } : {}),
      ...(cookie && !origin ? { cookie, 'x-csrf-token': csrf } : {}),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, data: await response.json() as any }
}

try {
  const seed = await fetch(api + '/csrf-token')
  csrf = (await seed.json() as any).token
  cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const email = 'operator@merge.example.test', password = 'MergeFixture2026!'
  assert.equal((await json('/register', 'POST', undefined, { name: 'Merge operator', email, password, password_confirmation: password })).status, 200)
  const login = await json('/login', 'POST', undefined, { email, password })
  const agent = login.data.access_token ?? login.data.token
  const workspace = (await json('/support/workspaces', 'POST', agent, { name: 'Merge workshop' })).data.workspace
  const project = (await json(`/support/workspaces/${workspace.id}/projects`, 'POST', agent, { name: 'Merge Messenger' })).data.project
  const inbox = `/support/projects/${project.public_id}`
  const client = `/widget/projects/${project.public_id}`
  const sdk = `/v1/projects/${project.public_id}`
  assert.equal((await json(inbox, 'PATCH', agent, { allowedOrigins: [widgetOrigin] })).status, 200)
  const { ingestKey } = (await json(inbox + '/keys', 'POST', agent, {})).data
  async function create(subject: string, externalId = 'same-customer') {
    const result = await json(sdk + '/conversations', 'POST', ingestKey, { subject, body: `Initial public message for ${subject}`, externalId, idempotencyKey: crypto.randomUUID() })
    assert.equal(result.status, 201)
    return String(result.data.conversation.id)
  }
  async function session(externalId: string) {
    const result = await json(sdk + '/sessions', 'POST', ingestKey, { externalId })
    assert.equal(result.status, 200)
    return String(result.data.token)
  }
  const agentThread = (id: string) => `${inbox}/conversations/${id}`
  const widgetThread = (id: string) => `${client}/conversations/${id}`
  const primary = await create('Primary'), secondary = await create('Duplicate'), other = await create('Other contact', 'other-customer')
  const customer = await session('same-customer'), stranger = await session('other-customer')
  assert.equal((await json(agentThread(secondary) + '/messages', 'POST', agent, { visibility: 'internal', body: 'Private note on the duplicate', idempotencyKey: 'historical-note' })).status, 201)

  const mergePath = agentThread(secondary) + '/merge'
  const mergeBody = { primaryConversationId: primary, idempotencyKey: 'merge-one' }
  assert.equal((await json(mergePath, 'POST', agent, { primaryConversationId: other, idempotencyKey: 'wrong-contact' })).status, 422)
  const merged = await json(mergePath, 'POST', agent, mergeBody)
  assert.equal(merged.status, 200, JSON.stringify(merged))
  assert.deepEqual(await json(mergePath, 'POST', agent, mergeBody), merged)
  assert.equal((await json(mergePath, 'POST', agent, { ...mergeBody, idempotencyKey: 'second-attempt' })).status, 409)
  assert.equal((await json(agentThread(secondary), 'PATCH', agent, { status: 'open' })).status, 409)
  assert.equal((await json(agentThread(secondary) + '/messages', 'POST', agent, { body: 'Attempted agent reply', idempotencyKey: 'agent-reply' })).status, 409)

  const source = (await json(agentThread(secondary), 'GET', agent)).data
  const target = (await json(agentThread(primary), 'GET', agent)).data
  assert.equal(source.conversation.status, 'closed')
  assert.deepEqual(source.merge.primary, merged.data.merge)
  assert.deepEqual(target.merge.duplicates, [merged.data.merge])
  assert.deepEqual((await json(agentThread(primary) + '/merge?before=' + merged.data.merge.id, 'GET', agent)).data.merge, { duplicates: [], nextCursor: null })
  assert.equal((await json(agentThread(primary) + '/merge?before=1&before=2', 'GET', agent)).status, 422)
  assert.deepEqual(source.messages.map((message: any) => message.body), ['Initial public message for Duplicate', 'Private note on the duplicate'])
  assert.deepEqual(target.messages.map((message: any) => message.body), ['Initial public message for Primary'])
  const open = (await json(inbox + '/inbox?status=open', 'GET', agent)).data.conversations
  assert.equal(open.some((row: any) => row.id === secondary), false)
  assert.equal((await json(widgetThread(secondary), 'GET', stranger, undefined, widgetOrigin)).status, 404)
  const visible = await json(widgetThread(secondary), 'GET', customer, undefined, widgetOrigin)
  assert.equal(visible.status, 200)
  assert.deepEqual(visible.data.messages.map((message: any) => message.body), ['Initial public message for Duplicate'])
  assert.equal(visible.data.merge, undefined)

  const followup = { body: 'A new reply from the stale duplicate URL', idempotencyKey: 'redirected-reply' }
  const sent = await json(widgetThread(secondary) + '/messages', 'POST', customer, followup, widgetOrigin)
  assert.equal(sent.status, 201, JSON.stringify(sent))
  assert.equal(sent.data.message.conversation_id, primary)
  assert.deepEqual(await json(widgetThread(secondary) + '/messages', 'POST', customer, followup, widgetOrigin), sent)
  const report = (await json(inbox + '/reports', 'GET', agent)).data
  assert.deepEqual(report.consolidations, { total: 1, active: 1 })
  assert.equal(report.messengerTimings.resolution.samples, 0)

  const undoPath = mergePath + '/undo'
  const undo = { mergeId: merged.data.merge.id, idempotencyKey: 'undo-one' }
  assert.equal((await json(undoPath, 'POST', agent, { ...undo, mergeId: 9000 })).status, 409)
  const undone = await json(undoPath, 'POST', agent, undo)
  assert.equal(undone.status, 200, JSON.stringify(undone))
  assert.deepEqual(await json(undoPath, 'POST', agent, undo), undone)
  assert.equal((await json(agentThread(secondary), 'GET', agent)).data.conversation.status, 'open')
  assert.deepEqual(await json(widgetThread(secondary) + '/messages', 'POST', customer, followup, widgetOrigin), sent)
  const ownReply = await json(widgetThread(secondary) + '/messages', 'POST', customer, { body: 'Reply after undo', idempotencyKey: 'direct-again' }, widgetOrigin)
  assert.equal(ownReply.data.message.conversation_id, secondary)

  const competing = await create('Competing primary')
  const attempts = await Promise.all([primary, competing].map((primaryConversationId, index) => json(mergePath, 'POST', agent, { primaryConversationId, idempotencyKey: `race-${index}` })))
  assert.deepEqual(attempts.map(attempt => attempt.status).sort(), [200, 409])
  assert.equal((await json(undoPath, 'POST', agent, { ...undo, idempotencyKey: 'stale-undo' })).status, 409)
  assert.deepEqual((await json(inbox + '/reports', 'GET', agent)).data.consolidations, { total: 2, active: 1 })
  console.info('PASS conversation merge HTTP')
}
finally {
  server.stop(true)
}
