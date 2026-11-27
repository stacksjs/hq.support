import assert from 'node:assert/strict'
import { overridesReady } from '@stacksjs/config'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { one, insert, query } from '../../app/Support/database'
import { inboxPresenceLeaseMs, pruneInboxPresence, updateCustomerPresence } from '../../app/Support/inbox-presence'

await overridesReady
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()

const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let csrf = '', cookie = ''
async function http(path: string, token?: string, body?: object, widget = false) {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      accept: 'application/json', 'content-type': 'application/json',
      ...(widget ? { origin: 'https://widget.example.test' } : { cookie, 'x-csrf-token': csrf }),
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, headers: response.headers, data: await response.json() as any }
}
async function register(name: string) {
  const email = `${name}@presence.example.test`, password = 'InboxPresence2026!'
  assert.equal((await http('/register', undefined, { name, email, password, password_confirmation: password })).status, 200)
  const login = await http('/login', undefined, { email, password })
  assert.equal(login.status, 200)
  const account = await one('SELECT id FROM users WHERE email = ?', [email])
  return { id: String(account?.id), email, token: String(login.data.access_token ?? login.data.token) }
}
async function createProject(owner: string, workspace: number, name: string) {
  const result = await http(`/support/workspaces/${workspace}/projects`, owner, { name })
  assert.equal(result.status, 201)
  const project = result.data.project
  const agent = `/support/projects/${project.public_id}`
  const sdk = `/v1/projects/${project.public_id}`
  const keys = (await http(agent + '/keys', owner, {})).data
  const thread = await http(sdk + '/conversations', keys.ingestKey, { subject: name, body: name, externalId: 'disposable-customer', idempotencyKey: crypto.randomUUID() })
  assert.equal(thread.status, 201)
  return { ...project, agent, sdk, ingest: keys.ingestKey, thread: String(thread.data.conversation.id) }
}
try {
  const seed = await fetch(base + '/csrf-token')
  cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  csrf = (await seed.json() as { token: string }).token
  const owner = await register('owner'), teammate = await register('teammate'), outsider = await register('outsider')
  const workspace = (await http('/support/workspaces', owner.token, { name: 'Presence workspace' })).data.workspace
  const foreignWorkspace = (await http('/support/workspaces', outsider.token, { name: 'Foreign workspace' })).data.workspace
  await insert('support_memberships', { workspace_id: workspace.id, user_id: teammate.id, role: 'agent', status: 'active', email: teammate.email })
  const project = await createProject(owner.token, workspace.id, 'First browser project')
  const second = await createProject(owner.token, workspace.id, 'Sibling browser project')
  const foreign = await createProject(outsider.token, foreignWorkspace.id, 'Foreign browser project')
  await query('UPDATE support_projects SET allowed_origins = ? WHERE id IN (?, ?)', [JSON.stringify(['https://widget.example.test']), project.id, second.id])
  const detail = project.agent + '/conversations/' + project.thread
  const presence = detail + '/presence'
  const payload = (tabId: string, sequence: number, state: string) => ({ tabId, sequence, state })
  const primaryTab = crypto.randomUUID(), extraTab = crypto.randomUUID(), otherTab = crypto.randomUUID()
  const viewing = await http(presence, owner.token, payload(primaryTab, 1, 'viewing'))
  assert.equal(viewing.headers.get('cache-control'), 'no-store')
  assert.deepEqual(viewing.data, { viewers: [], lastAgentReplyId: '0', customerTyping: false })
  assert.equal((await http(presence, teammate.token, payload(otherTab, 1, 'viewing'))).data.viewers[0].userId, owner.id)
  assert.equal((await http(presence, owner.token, payload(extraTab, 1, 'composing'))).status, 200)
  assert.deepEqual((await http(presence, teammate.token, payload(otherTab, 2, 'viewing'))).data.viewers, [{ userId: owner.id, composing: true }])
  for (const invalid of [
    { ...payload(primaryTab, 2, 'composing'), draft: 'never retain this' },
    { ...payload(primaryTab, 2, 'composing'), userId: outsider.id },
    payload('invalid', 2, 'composing'), payload(primaryTab, 0, 'composing'), payload(primaryTab, 2, 'unknown'),
  ]) assert.equal((await http(presence, owner.token, invalid)).status, 422)
  assert.equal((await http(presence, outsider.token, payload(primaryTab, 2, 'viewing'))).status, 403)
  assert.equal((await http(`${second.agent}/conversations/${project.thread}/presence`, owner.token, payload(primaryTab, 2, 'viewing'))).status, 404)
  assert.equal((await http(`${foreign.agent}/conversations/${foreign.thread}/presence`, teammate.token, payload(otherTab, 3, 'viewing'))).status, 403)
  const session = await http(project.sdk + '/sessions', project.ingest, { externalId: 'disposable-customer' })
  const widgetRoot = `/widget/projects/${project.public_id}/conversations/${project.thread}`
  const typingPath = widgetRoot + '/typing'
  const widget = await http(widgetRoot, session.data.token, undefined, true)
  assert.equal(widget.status, 200)
  assert.ok(!Object.hasOwn(widget.data, 'lastAgentReplyId') && !JSON.stringify(widget.data).includes('composing'))
  const typing = await http(typingPath, session.data.token, undefined, true)
  assert.equal(typing.status, 200)
  assert.equal(typing.headers.get('cache-control'), 'no-store')
  assert.equal(typing.headers.get('access-control-allow-origin'), 'https://widget.example.test')
  assert.deepEqual(typing.data, { typing: true })
  const otherSession = await http(project.sdk + '/sessions', project.ingest, { externalId: 'other-customer' })
  assert.equal((await http(typingPath, otherSession.data.token, undefined, true)).status, 404)
  assert.equal((await http(typingPath, undefined, undefined, true)).status, 401)
  assert.equal((await http(typingPath, session.data.token)).status, 403)
  assert.equal((await http(presence, session.data.token, payload(otherTab, 3, 'viewing'))).status, 401)
  const widgetPresence = widgetRoot + '/presence'
  const customerTab = crypto.randomUUID(), customerExtra = crypto.randomUUID()
  const composing = payload(customerTab, 1, 'composing')
  assert.equal((await http(widgetPresence, session.data.token, composing)).status, 403)
  assert.equal((await http(widgetPresence, undefined, composing, true)).status, 401)
  assert.equal((await http(widgetPresence, otherSession.data.token, composing, true)).status, 404)
  assert.equal((await http(`/widget/projects/${second.public_id}/conversations/${second.thread}/presence`, session.data.token, composing, true)).status, 401)
  assert.equal((await http(widgetPresence, session.data.token, { ...composing, draft: 'private fixture draft' }, true)).status, 422)
  const active = await http(widgetPresence, session.data.token, composing, true)
  assert.equal(active.status, 200)
  assert.deepEqual(active.data, { accepted: true })
  assert.equal(active.headers.get('cache-control'), 'no-store')
  assert.equal(active.headers.get('access-control-allow-origin'), 'https://widget.example.test')
  const agentStatus = (sequence: number, path = presence) => http(path, teammate.token, payload(otherTab, sequence, 'viewing'))
  const whileComposing = await agentStatus(3)
  assert.equal(whileComposing.data.customerTyping, true)
  assert.deepEqual(Object.keys(whileComposing.data).sort(), ['customerTyping', 'lastAgentReplyId', 'viewers'])
  assert.equal((await agentStatus(4, `${second.agent}/conversations/${second.thread}/presence`)).data.customerTyping, false)
  const sameContact = await http(project.sdk + '/conversations', project.ingest, { subject: 'Another request', body: 'Separate request', externalId: 'disposable-customer', idempotencyKey: crypto.randomUUID() })
  assert.equal(sameContact.status, 201)
  assert.equal((await agentStatus(5, `${project.agent}/conversations/${sameContact.data.conversation.id}/presence`)).data.customerTyping, false)
  const capSession = await http(project.sdk + '/sessions', project.ingest, { externalId: 'disposable-customer' })
  const newTabs = await Promise.all(Array.from({ length: 17 }, () => http(widgetPresence, capSession.data.token, payload(crypto.randomUUID(), 1, 'composing'), true)))
  assert.equal(newTabs.filter(result => result.status === 200).length, 16)
  assert.equal(newTabs.find(result => result.status === 429)?.data.error.code, 'presence_tab_limit')
  await http(widgetPresence, session.data.token, payload(customerExtra, 1, 'composing'), true)
  await http(widgetPresence, session.data.token, payload(customerTab, 2, 'away'), true)
  assert.equal((await agentStatus(6)).data.customerTyping, true)
  await http(`/widget/projects/${project.public_id}/session/revoke`, capSession.data.token, {}, true)
  await http(widgetPresence, session.data.token, payload(customerExtra, 2, 'away'), true)
  await http(widgetPresence, session.data.token, payload(customerExtra, 1, 'composing'), true)
  assert.equal((await agentStatus(7)).data.customerTyping, false)
  await http(widgetPresence, session.data.token, payload(customerTab, 3, 'composing'), true)
  await query('UPDATE support_customer_presences SET expires_at = ? WHERE conversation_id = ?', [Date.now() - 1, project.thread])
  assert.equal((await agentStatus(8)).data.customerTyping, false)
  await pruneInboxPresence()
  await updateCustomerPresence(project, project.thread, session.data.token, composing, Date.now() - inboxPresenceLeaseMs - 1)
  assert.equal(Number((await one('SELECT COUNT(*) AS total FROM support_customer_presences WHERE conversation_id = ?', [project.thread]))?.total), 0)

  const siblingPresence = `${second.agent}/conversations/${second.thread}/presence`
  assert.equal((await http(siblingPresence, owner.token, payload(extraTab, 3, 'viewing'))).status, 200)
  assert.equal((await http(presence, owner.token, payload(extraTab, 2, 'composing'))).status, 200)
  assert.deepEqual((await http(presence, teammate.token, payload(otherTab, 9, 'viewing'))).data.viewers, [{ userId: owner.id, composing: false }])
  assert.deepEqual((await http(typingPath, session.data.token, undefined, true)).data, { typing: false })
  await http(presence, owner.token, payload(primaryTab, 3, 'away'))
  await http(presence, owner.token, payload(primaryTab, 2, 'viewing'))
  assert.deepEqual((await http(presence, teammate.token, payload(otherTab, 10, 'viewing'))).data.viewers, [])
  await http(presence, owner.token, payload(primaryTab, 4, 'composing'))
  await query('UPDATE support_inbox_presences SET expires_at = ? WHERE conversation_id = ? AND user_id = ?', [Date.now() - 1, project.thread, owner.id])
  assert.deepEqual((await http(presence, teammate.token, payload(otherTab, 11, 'viewing'))).data.viewers, [])
  assert.deepEqual((await http(typingPath, session.data.token, undefined, true)).data, { typing: false })
  assert.equal((await pruneInboxPresence()).deleted, 1)
  await query("UPDATE support_memberships SET status = 'inactive' WHERE workspace_id = ? AND user_id = ?", [workspace.id, teammate.id])
  assert.deepEqual((await http(presence, owner.token, payload(primaryTab, 5, 'viewing'))).data.viewers, [])
  assert.equal((await http(presence, teammate.token, payload(otherTab, 12, 'composing'))).status, 403)
  await query("UPDATE support_memberships SET status = 'active' WHERE workspace_id = ? AND user_id = ?", [workspace.id, teammate.id])

  const first = { body: 'First physical draft', idempotencyKey: 'draft-first', afterAgentReplyId: '0' }
  const secondDraft = { body: 'Second physical draft', idempotencyKey: 'draft-second', afterAgentReplyId: '0' }
  const replies = detail + '/messages'
  assert.equal((await http(replies, owner.token, { body: 'Private note', visibility: 'internal', idempotencyKey: 'note', afterAgentReplyId: '0' })).status, 201)
  const roster = await Promise.all([http(replies, owner.token, first), http(replies, teammate.token, secondDraft)])
  assert.deepEqual(roster.map(result => result.status).sort(), [201, 409])
  const winner = roster.findIndex(result => result.status === 201)
  const loser = 1 - winner
  assert.equal(roster[loser]!.data.error.code, 'agent_reply_changed')
  const input = [first, secondDraft], accounts = [owner, teammate]
  const winnerReply = String(roster[winner]!.data.message.id)
  assert.equal((await http(presence, owner.token, payload(primaryTab, 6, 'viewing'))).data.lastAgentReplyId, winnerReply)
  assert.equal((await http(detail, owner.token)).data.lastAgentReplyId, winnerReply)
  assert.equal((await http(replies, accounts[winner]!.token, input[winner]!)).data.message.id, winnerReply)
  assert.equal((await http(replies, accounts[loser]!.token, { ...input[loser], afterAgentReplyId: winnerReply })).status, 201)
  assert.equal((await http(replies, owner.token, { body: 'Bad cursor', idempotencyKey: 'bad-cursor', afterAgentReplyId: '01' })).status, 422)
  assert.equal((await http(widgetPresence, session.data.token, payload(customerTab, 4, 'composing'), true)).status, 200)
  assert.equal((await agentStatus(13)).data.customerTyping, true)
  assert.equal((await http(`/widget/projects/${project.public_id}/session/revoke`, session.data.token, {}, true)).status, 200)
  assert.equal((await agentStatus(14)).data.customerTyping, false)
  assert.equal((await http(widgetPresence, session.data.token, payload(customerTab, 5, 'composing'), true)).status, 401)
  console.log('PASS inbox presence and collision protection')
}
finally { server.stop(true) }
