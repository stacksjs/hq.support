import { generateKeyPairSync, sign } from 'node:crypto'
import { retentionMarker } from '../../enterprise/retention'
import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { insert, one, query, workspaceTransaction } from '../../app/Support/database'
import { customerReopenWindowMs } from '../../app/Support/reopening'
import { bindChannelConversation, conversationChannelThread, deliveryChannelThread } from '../../app/Support/channel-history'
import { createSession, reply, usage } from '../../app/Support/service'

await overridesReady
if (config.database.queryLogging) config.database.queryLogging.enabled = false
if (!process.env.SUPPORT_REOPEN_RESTART) {
  assert.equal((await migrateAuthTables()).success, true); assert.equal((await runDatabaseMigration()).isOk, true); assert.equal((await migrateAuthTables()).success, true)
}
await injectGlobalAutoImports(); await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
const nativeNow = Date.now
let now = nativeNow(), cookie = '', csrf = '', checks = 0
Date.now = () => now
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++ }
async function http(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, data: await response.json() as any }
}
const origin = 'https://reopen-customer.example.test'
async function widget(path: string, token: string, body: unknown) {
  const response = await fetch(base + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, data: await response.json() as any }
}
try {
  if (process.env.SUPPORT_REOPEN_RESTART) {
    const saved = await Bun.file(process.env.SUPPORT_REOPEN_STATE!).json(); now = saved.now
    const index = Number(process.env.SUPPORT_REOPEN_RACE || 0)
    const result = await widget(saved.path, saved.token, { body: `Concurrent customer ${index}`, idempotencyKey: `concurrent-${index}` })
    check(result.status === 201 && String(result.data.message.conversation_id) !== String(saved.id), 'independent native server resolves the admitted successor')
    if (saved.destination) check(result.data.message.conversation_id === saved.destination, 'restarted server replays the exact committed destination')
    await Bun.write(process.env.SUPPORT_REOPEN_STATE! + `.result${index}`, JSON.stringify(result.data))
    console.info('PASS reopening independent worker')
  }
  else {
    const seed = await fetch(base + '/csrf-token'); csrf = (await seed.json() as any).token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
    async function account(name: string) { const email = `${name}@reopening.example.test`, password = 'ReopeningNative2026!'; assert.equal((await http('/register', 'POST', { name, email, password, password_confirmation: password })).status, 200); const login = await http('/login', 'POST', { email, password }); return { id: Number((await one('SELECT id FROM users WHERE email = ?', [email]))!.id), token: login.data.access_token ?? login.data.token } }
    const owner = await account('owner'), agent = await account('agent')
    const workspace = (await http('/support/workspaces', 'POST', { name: 'Reopening workspace' }, owner.token)).data.workspace
    await insert('support_memberships', { workspace_id: workspace.id, user_id: agent.id, email: 'agent@reopening.example.test', role: 'agent', status: 'active' })
    const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Reopening project' }, owner.token)).data.project
    const sibling = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Sibling' }, owner.token)).data.project
    const prefix = `/support/projects/${project.public_id}`, widgetPrefix = `/widget/projects/${project.public_id}`, sdk = `/v1/projects/${project.public_id}`
    const keys = (await http(prefix + '/keys', 'POST', {}, owner.token)).data
    await http(prefix, 'PATCH', { allowedOrigins: [origin] }, owner.token)
    const token = (await http(sdk + '/sessions', 'POST', { externalId: 'customer' }, keys.ingestKey)).data.token
    const stranger = (await http(sdk + '/sessions', 'POST', { externalId: 'stranger' }, keys.ingestKey)).data.token
    let serial = 0
    async function create() { const result = await http(sdk + '/conversations', 'POST', { externalId: 'customer', subject: `Request ${++serial}`, body: 'Initial customer message', idempotencyKey: `new-${serial}` }, keys.ingestKey); assert.equal(result.status, 201, JSON.stringify(result)); return String(result.data.conversation.id) }
    const row = async (id: unknown) => (await one('SELECT * FROM support_conversations WHERE id = ?', [id]))!
    const patch = (id: unknown, input: unknown) => http(prefix + `/conversations/${id}`, 'PATCH', input, owner.token)
    const send = (id: unknown, key = crypto.randomUUID(), customer = token) => widget(widgetPrefix + `/conversations/${id}/messages`, customer, { body: 'Follow-up customer message', idempotencyKey: key })
    const initial = await create(); await patch(initial, { assigneeId: agent.id }); await patch(initial, { status: 'closed', resolvedAt: 1, resolved_at: 1 })
    check(Number((await row(initial)).resolved_at) === now, 'actual closed transition records a durable UTC resolution time')
    now += 1000; await patch(initial, { status: 'closed' }); await patch(initial, { assigneeId: agent.id }); await http(prefix + `/conversations/${initial}/reply`, 'POST', { body: 'Private note while resolved', visibility: 'internal', idempotencyKey: 'closed-note' }, owner.token)
    check(Number((await row(initial)).resolved_at) === now - 1000, 'repeated close, assignment and internal note cannot slide the resolution window')
    const usedBefore = await usage(Number(workspace.id), 'conversations')
    await query('UPDATE support_conversations SET resolved_at = ? WHERE id = ?', [now - customerReopenWindowMs, initial])
    const edge = await send(initial)
    check(edge.status === 201 && edge.data.message.conversation_id === initial && (await row(initial)).status === 'open' && Number((await row(initial)).resolved_at) === 0 && await usage(Number(workspace.id), 'conversations') === usedBefore, 'exact seven-day boundary reopens the same admitted request without a new conversation unit')
    const late = await create(); await patch(late, { status: 'closed' }); await query('UPDATE support_conversations SET resolved_at = ? WHERE id = ?', [now - customerReopenWindowMs - 1, late])
    const preseed = await http(sdk + '/conversations', 'POST', { externalId: 'customer', subject: (await row(late)).subject, body: 'Follow-up customer message', idempotencyKey: `continued:${late}` }, keys.ingestKey)
    const forgedLate = { body: 'Follow-up customer message', idempotencyKey: 'late-lost-ack', acceptedAt: 0, resolvedAt: now, status: 'open', continuationId: initial }
    const beforeLate = await usage(Number(workspace.id), 'conversations'), lateReply = await widget(widgetPrefix + `/conversations/${late}/messages`, token, forgedLate), destination = String(lateReply.data.message.conversation_id)
    check(lateReply.status === 201 && destination !== late && destination !== preseed.data.conversation.id && (await row(late)).status === 'closed' && String((await row(late)).continuation_id) === destination && String((await row(destination)).continued_from_id) === late && await usage(Number(workspace.id), 'conversations') === beforeLate + 1, 'one millisecond after the window admits one linked successor with the real first message')
    const retry = await widget(widgetPrefix + `/conversations/${late}/messages`, token, forgedLate)
    check(retry.data.message.id === lateReply.data.message.id && retry.data.message.conversation_id === destination && await usage(Number(workspace.id), 'conversations') === beforeLate + 1, 'lost acknowledgement retry returns the exact original message and destination without charging again')
    const sameKeyChanged = await widget(widgetPrefix + `/conversations/${late}/messages`, token, { body: 'Changed payload', idempotencyKey: 'late-lost-ack' })
    check(sameKeyChanged.status === 409, 'same operation key cannot change the already admitted body')
    const another = await send(late)
    check(another.data.message.conversation_id === destination && await usage(Number(workspace.id), 'conversations') === beforeLate + 1, 'later messages to the old URL reuse its current successor without a second admission')
    const snoozed = await create(); await patch(snoozed, { status: 'snoozed' }); await query('UPDATE support_conversations SET updated_at = ? WHERE id = ?', [new Date(now - 90 * 86400000).toISOString(), snoozed])
    const beforeSnooze = await usage(Number(workspace.id), 'conversations')
    const resumed = await send(snoozed)
    check(resumed.status === 201 && resumed.data.message.conversation_id === snoozed && (await row(snoozed)).status === 'open' && await usage(Number(workspace.id), 'conversations') === beforeSnooze, 'snoozed requests resume their existing admission at any age')
    // Clock remains controlled at the comparison boundary, without expiring fixture sessions.
    await query('UPDATE support_customer_sessions SET expires_at = ?', [now + 86400000])
    const unknown = await create(); await query("UPDATE support_conversations SET status = 'closed', resolved_at = 0, updated_at = ? WHERE id = ?", ['2000-01-01T00:00:00.000Z', unknown])
    check((await send(unknown)).data.message.conversation_id === unknown && (await row(unknown)).status === 'open', 'unknown legacy closure gets one free reopen without guessing from updated_at')
    await patch(unknown, { status: 'closed' }); check(Number((await row(unknown)).resolved_at) === now, 'a later actual closure starts a real window after the grandfathered reopen')
    const closedForAgent = await create(); await patch(closedForAgent, { status: 'closed' }); const serverNote = await http(sdk + `/conversations/${closedForAgent}/messages`, 'POST', { body: 'Existing server agent reply', visibility: 'public', idempotencyKey: 'server-agent' }, keys.ingestKey)
    check(serverNote.status === 201 && (await row(closedForAgent)).status === 'closed' && serverNote.data.message.author_type === 'agent', 'existing native SDK agent replies keep their contract and do not impersonate customer ingress')
    check((await send(closedForAgent, 'wrong-customer', stranger)).status === 404, 'another customer cannot reopen or link a request')
    check((await widget(`/widget/projects/${sibling.public_id}/conversations/${closedForAgent}/messages`, token, { body: 'Wrong project', idempotencyKey: 'cross-project' })).status !== 201, 'same-workspace sibling cannot link another project history')
    check((await http(sdk + `/conversations/${closedForAgent}/messages`, 'POST', { body: 'Read key write', visibility: 'public', idempotencyKey: 'read-key' }, keys.readKey)).status === 401, 'summary read key cannot cause reply admission')
    const capacity = await create(); await patch(capacity, { assigneeId: agent.id, status: 'closed' })
    await http(`/support/workspaces/${workspace.id}/routing-agents`, 'POST', { userId: agent.id, availability: 'away', capacity: 1 }, owner.token)
    await send(capacity)
    check((await row(capacity)).status === 'open' && Number((await row(capacity)).assignee_id) === 0 && (await row(capacity)).routing_reason === 'agent_unavailable', 'customer reply readmits capacity honestly and reopens unassigned when the historical agent is away')
    const audit = await http(prefix + `/conversations/${capacity}/routing-audit`, 'GET', undefined, owner.token)
    check(audit.data.assignments[0].source === 'ingress' && audit.data.assignments[0].before.status === 'closed' && audit.data.assignments[0].after.status === 'open', 'customer reopening has persisted assignment provenance')
    await patch(initial, { assigneeId: 0 })
    await http(`/support/workspaces/${workspace.id}/routing-agents`, 'POST', { userId: agent.id, availability: 'available', capacity: 1 }, owner.token)
    const slotA = await create(), slotB = await create()
    await patch(slotA, { status: 'closed', assigneeId: agent.id }); await patch(slotB, { status: 'closed', assigneeId: agent.id })
    const slotReplies = await Promise.all([send(slotA), send(slotB)])
    check(slotReplies.every(result => result.status === 201) && [await row(slotA), await row(slotB)].filter(item => Number(item.assignee_id) === agent.id).length === 1 && [await row(slotA), await row(slotB)].every(item => item.status === 'open'), 'concurrent customer reopenings admit exactly the last agent slot and retain honest unassigned overflow')
    const grandparent = await create(), wrong = await create()
    await query('UPDATE support_conversations SET continuation_id = ? WHERE id = ?', [grandparent, grandparent]); check((await send(grandparent)).status === 409, 'cyclic lineage is rejected without an unbounded traversal')
    await query('UPDATE support_conversations SET continuation_id = ? WHERE id = ?', [wrong, grandparent]); check((await send(grandparent)).status === 409, 'unmatched predecessor links cannot redirect an admitted message')
    await query('UPDATE support_conversations SET continuation_id = NULL WHERE id = ?', [grandparent])
    const strangerContact = (await one('SELECT id FROM support_contacts WHERE project_id = ? AND external_id = ?', [project.id, 'stranger']))!
    await query('UPDATE support_conversations SET continuation_id = ? WHERE id = ?', [wrong, grandparent]); await query('UPDATE support_conversations SET contact_id = ?, continued_from_id = ? WHERE id = ?', [strangerContact.id, grandparent, wrong])
    check((await send(grandparent)).status === 404, 'even a matching predecessor pointer cannot cross customer ownership')
    await query('UPDATE support_conversations SET continuation_id = NULL WHERE id = ?', [grandparent]); await query('UPDATE support_conversations SET contact_id = ?, continued_from_id = NULL WHERE id = ?', [(await row(grandparent)).contact_id, wrong])
    let parent = await row(grandparent)
    for (let depth = 0; depth < 64; depth++) { const child = await insert('support_conversations', { workspace_id: workspace.id, project_id: project.id, contact_id: parent.contact_id, subject: 'Bounded historical chain', status: 'closed', continued_from_id: parent.id }); await query('UPDATE support_conversations SET continuation_id = ? WHERE id = ?', [child.id, parent.id]); parent = child }
    check((await send(grandparent)).status === 409, 'lineage depth is bounded before accepting a message or consuming quota')
    await query('UPDATE support_conversations SET continuation_id = NULL WHERE id = ?', [grandparent])

    const concurrent = await create(); await patch(concurrent, { status: 'closed' }); await query('UPDATE support_conversations SET resolved_at = ? WHERE id = ?', [now - customerReopenWindowMs - 1, concurrent])
    await Bun.write(process.env.SUPPORT_REOPEN_STATE!, JSON.stringify({ path: widgetPrefix + `/conversations/${concurrent}/messages`, token, id: concurrent, now }))
    const beforeConcurrent = await usage(Number(workspace.id), 'conversations')
    const races = await Promise.all([0, 1, 2].map(index => runIsolated(import.meta.filename, { env: { ...process.env, SUPPORT_REOPEN_RESTART: 'race', SUPPORT_REOPEN_RACE: String(index), BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 30000 })))
    races.forEach(result => assertIsolatedOk(result, 'PASS reopening independent worker'))
    const results = await Promise.all([0, 1, 2].map(index => Bun.file(process.env.SUPPORT_REOPEN_STATE! + `.result${index}`).json()))
    check(new Set(results.map(result => result.message.conversation_id)).size === 1 && new Set(results.map(result => result.message.id)).size === 3 && await usage(Number(workspace.id), 'conversations') === beforeConcurrent + 1, 'three independent native server processes admit exactly one successor and retain all distinct messages')
    await Bun.write(process.env.SUPPORT_REOPEN_STATE!, JSON.stringify({ path: widgetPrefix + `/conversations/${concurrent}/messages`, token, id: concurrent, destination: results[0].message.conversation_id, now }))
    assertIsolatedOk(await runIsolated(import.meta.filename, { env: { ...process.env, SUPPORT_REOPEN_RESTART: 'retry', SUPPORT_REOPEN_RACE: '0', BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 30000 }), 'PASS reopening independent worker')
    check(await usage(Number(workspace.id), 'conversations') === beforeConcurrent + 1, 'fresh process operation replay preserves exact conversation metering')
    const target = await row(destination), channel = await insert('support_channels', { public_id: crypto.randomUUID(), workspace_id: workspace.id, project_id: project.id, provider: 'sms', label: 'Historical fixture', configuration: '{}', status: 'draft' })
    const thread = await insert('support_channel_threads', { workspace_id: workspace.id, project_id: project.id, channel_id: channel.id, remote_key: 'historical-thread', contact_id: target.contact_id, conversation_id: destination, recipient: '+14155550101' })
    await workspaceTransaction(Number(workspace.id), async () => { await bindChannelConversation(project, thread, late); await bindChannelConversation(project, thread, destination) })
    const historical = await conversationChannelThread(project, late), outgoing = await reply(project, late, { body: 'Historical agent operation', visibility: 'public', idempotencyKey: 'historical-agent' }, { userId: owner.id })
    const deliveryTarget = await deliveryChannelThread(project, { message_id: outgoing.message.id, thread_id: thread.id, channel_id: channel.id })
    check(String(historical!.conversation_id) === late && String(deliveryTarget.conversation_id) === late && String((await one('SELECT conversation_id FROM support_channel_threads WHERE id = ?', [thread.id]))!.conversation_id) === destination, 'historical provider binding and immutable message target survive an advanced inbound pointer')
    const licenseKeys = generateKeyPairSync('ed25519')
    process.env.SUPPORT_ENTERPRISE_LICENSE_PUBLIC_KEY = String(licenseKeys.publicKey.export({ type: 'spki', format: 'pem' })); process.env.SUPPORT_INSTALLATION_ID = 'reopening-fixture'
    const licenseBody = Buffer.from(JSON.stringify({ version: 1, licenseId: 'reopening-retention', installation: 'reopening-fixture', workspace: workspace.public_id, issuedAt: now - 1000, expiresAt: now + 86400000, features: ['retention'] })).toString('base64url')
    process.env.SUPPORT_ENTERPRISE_LICENSE = `${licenseBody}.${sign(null, Buffer.from(licenseBody), licenseKeys.privateKey).toString('base64url')}`
    const retentionPath = `/support/workspaces/${workspace.id}/enterprise/retention`
    check((await http(retentionPath, 'PUT', { days: 30, enabled: true }, owner.token)).status === 200, 'actual licensed native retention policy configures for canonical receipt privacy checks')
    const receipt = async () => (await one('SELECT response FROM support_idempotency WHERE project_id = ? AND operation = ? AND key = ?', [project.id, `reply:${late}:${target.contact_id}`, 'late-lost-ack']))!.response
    const protectedReceipt = await insert('support_idempotency', { workspace_id: workspace.id, project_id: sibling.id, operation: `reply:${late}:foreign`, key: 'sibling-retention', fingerprint: 'fixture', response: JSON.stringify({ message: { conversation_id: destination, body: 'Sibling-project receipt must remain untouched' } }) })
    const batchedReceipts = []
    for (let index = 0; index < 105; index++) batchedReceipts.push(await insert('support_idempotency', { workspace_id: workspace.id, project_id: project.id, operation: 'conversation:retention-fixture', key: `retention-page-${index}`, fingerprint: 'fixture', response: JSON.stringify({ conversation: { id: destination, subject: 'Batched successor receipt' } }) }))
    const notificationsBeforeRetention = Number((await one('SELECT COUNT(*) AS count FROM support_outbox'))!.count)
    await query('UPDATE support_conversations SET updated_at = ? WHERE id = ?', [new Date(now - 40 * 86400000).toISOString(), late])
    for (const malformed of [{ message: { conversation_id: false, body: 'Malformed destination must never become legacy prefix authority' } }, { message: null }]) {
      const bad = await insert('support_idempotency', { workspace_id: workspace.id, project_id: project.id, operation: `reply:${late}:legacy-fixture`, key: crypto.randomUUID(), fingerprint: 'fixture', response: JSON.stringify(malformed) })
      const refused = await http(retentionPath + '/run', 'POST', {}, owner.token)
      check(refused.status === 503 && (await row(late)).subject !== retentionMarker && String(await receipt()).includes('Follow-up customer message'), 'malformed explicit receipt destinations block retention rather than falling back to an old URL prefix')
      await query('DELETE FROM support_idempotency WHERE id = ?', [bad.id])
    }
    const legacyReceipt = await insert('support_idempotency', { workspace_id: workspace.id, project_id: project.id, operation: `reply:${late}:legacy-fixture`, key: 'genuinely-absent-destination', fingerprint: 'fixture', response: JSON.stringify({ message: { body: 'Legacy original request body' } }) })
    const oldRetention = await http(retentionPath + '/run', 'POST', {}, owner.token)
    check(oldRetention.status === 200 && oldRetention.data.processed === 1 && String(await receipt()).includes('Follow-up customer message') && (await row(late)).subject === retentionMarker, 'retaining predecessor content preserves the successor message receipt stored under its old reply URL')
    check(String((await one('SELECT response FROM support_idempotency WHERE id = ?', [legacyReceipt.id]))!.response).includes(retentionMarker), 'legacy old-URL fallback applies only when authoritative destination fields are genuinely absent')
    await query("UPDATE support_conversations SET status = 'closed', resolved_at = ?, updated_at = ? WHERE id = ?", [now - 40 * 86400000, new Date(now - 40 * 86400000).toISOString(), destination])
    const newRetention = await http(retentionPath + '/run', 'POST', {}, owner.token)
    check(newRetention.status === 200 && newRetention.data.processed === 1 && !String(await receipt()).includes('Follow-up customer message') && String(await receipt()).includes(retentionMarker), 'retaining successor content redacts its old-URL replay receipt using the canonical message destination')
    check((await query('SELECT response FROM support_idempotency WHERE project_id = ? AND operation = ?', [project.id, 'conversation:retention-fixture'])).every(receipt => String(receipt.response).includes(retentionMarker)) && batchedReceipts.length === 105, 'bounded keyset receipt batches redact canonical destinations across multiple pages')
    check((await one('SELECT response FROM support_idempotency WHERE id = ?', [protectedReceipt.id]))!.response === protectedReceipt.response && Number((await one('SELECT COUNT(*) AS count FROM support_outbox'))!.count) === notificationsBeforeRetention, 'retention remains project-scoped and produces no customer notification intents')
    const redactedReplay = await widget(widgetPrefix + `/conversations/${late}/messages`, token, forgedLate)
    check(redactedReplay.data.message.body === retentionMarker && redactedReplay.data.message.conversation_id === destination, 'operation replay cannot recreate erased successor content through a predecessor URL')
    const freshAfterErasure = await send(late, 'fresh-after-retention')
    check(freshAfterErasure.status === 201 && freshAfterErasure.data.message.conversation_id !== destination && (await row(destination)).subject === retentionMarker && Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ? AND body <> ?', [destination, retentionMarker]))!.count) === 0, 'a later new customer request never recreates erased predecessor history')
    await query("UPDATE support_workspaces SET plan = 'trial', trial_ends_at = ? WHERE id = ?", [now - 1, workspace.id])
    const expiredExisting = await send(closedForAgent)
    check(expiredExisting.status === 201 && expiredExisting.data.message.conversation_id === closedForAgent, 'expired trial can still resume a recently admitted request')
    const rejectedLate = await send(unknown)
    check(rejectedLate.status === 201, 'recently closed grandfathered request remains usable after trial expiry')
    await query('UPDATE support_conversations SET status = ?, resolved_at = ? WHERE id = ?', ['closed', now - customerReopenWindowMs - 1, unknown])
    const quotaBefore = await usage(Number(workspace.id), 'conversations'), rowsBefore = Number((await one('SELECT COUNT(*) AS count FROM support_messages'))!.count)
    check((await send(unknown)).status === 402 && await usage(Number(workspace.id), 'conversations') === quotaBefore && Number((await one('SELECT COUNT(*) AS count FROM support_messages'))!.count) === rowsBefore && !(await row(unknown)).continuation_id, 'late expired-trial rejection persists no message, successor, quota or implicit closed reply')
    await query("UPDATE support_workspaces SET plan = 'free', stacks_verified = ?, deployment_verified = ? WHERE id = ?", [true, true, workspace.id]); await query("UPDATE support_usage SET used = 119 WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id])
    const admitted120 = await send(unknown)
    check(admitted120.status === 201 && await usage(Number(workspace.id), 'conversations') === 120, 'late continuation consumes exactly the final twentieth-percent grace unit')
    await query('UPDATE support_conversations SET status = ?, resolved_at = ? WHERE id = ?', ['closed', now - customerReopenWindowMs - 1, closedForAgent])
    check((await send(closedForAgent)).status === 402 && await usage(Number(workspace.id), 'conversations') === 120 && !(await row(closedForAgent)).continuation_id, '121st new request is refused without silently appending to the resolved request')
    console.info(`PASS customer reopening HTTP (${checks} checks)`)
  }
}
finally { Date.now = nativeNow; server.stop(true) }
process.exit(0)
