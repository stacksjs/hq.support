import assert from 'node:assert/strict'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { insert, one, query, workspaceTransaction, replayOperatorTransaction, db } from '../../app/Support/database'
import { digest, reply, createSession } from '../../app/Support/service'
import { supportReplayInvalidations } from '../../app/Support/replay'
import { authCookie } from '@stacksjs/auth/cookie'
import { sessionLogout } from '@stacksjs/auth/session-auth'
import { Auth } from '@stacksjs/auth/authentication'
import { startBrowserSession } from '@stacksjs/auth/browser-session-store'
import { emit } from '@stacksjs/realtime'
import { freezeTime, travelTo, useRealTime } from '@stacksjs/testing/time'
import { route } from '@stacksjs/router'
import { overridesReady, config } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
const migrated = await runDatabaseMigration()
assert.equal((await migrateAuthTables()).success, true)
assert.equal(migrated.isOk, true, 'Native migrations must apply')
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let checks = 0
let csrfToken = '', csrfCookie = ''
const check = (condition: unknown, message: string) => { assert.ok(condition, message); checks++ }

function streamFailureStage(message: unknown): 'stream-open' | 'request' | null {
  if (message === 'Realtime stream could not be opened.') return 'stream-open'
  if (message === 'Realtime request could not be completed.') return 'request'
  return null
}

async function request(path: string, method = 'GET', body?: unknown, token?: string, origin?: string) {
  const result = await fetch(base + path, { method, headers: { 'accept': 'application/json', ...(csrfCookie ? { cookie: csrfCookie, 'x-csrf-token': csrfToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const raw = await result.text()
  let data: any
  try { data = JSON.parse(raw) }
  catch { throw new Error(`${method} ${path} answered ${result.status}: ${raw.slice(0, 300)}`) }
  return { status: result.status, data, headers: result.headers }
}
try {
  const csrf = await request('/csrf-token')
  csrfToken = csrf.data.token
  csrfCookie = csrf.headers.get('set-cookie')!.split(';')[0]!
  const register = await request('/register', 'POST', { name: 'Owner One', email: 'owner@example.test', password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  check(register.status === 200 || register.status === 201, `native registration: ${register.status} ${JSON.stringify(register.data)}`)
  const login = await request('/login', 'POST', { email: 'owner@example.test', password: 'SecureSupport2026!' })
  const token = login.data.token ?? login.data.access_token ?? login.data.data?.token
  const ownerId = Number(login.data.user.id)
  check(typeof token === 'string', `native login issues token ${JSON.stringify(login.data)}`)
  const otherRegister = await request('/register', 'POST', { name: 'Owner Two', email: 'other@example.test', password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  check(otherRegister.status < 300, 'second account registers')
  const otherLogin = await request('/login', 'POST', { email: 'other@example.test', password: 'SecureSupport2026!' })
  const otherToken = otherLogin.data.token ?? otherLogin.data.access_token ?? otherLogin.data.data?.token
  const workspace = await request('/support/workspaces', 'POST', { name: 'Support company' }, token)
  check(workspace.status === 201, `workspace created: ${JSON.stringify(workspace.data)}`)
  const workspaceId = workspace.data.workspace.id
  const selected = await request(`/support/workspaces/${workspaceId}/projects`, 'POST', { name: 'Main app' }, token)
  check(selected.status === 201, `project created: ${JSON.stringify(selected.data)}`)
  const project = selected.data.project, prefix = `/v1/projects/${project.public_id}`, agent = `/support/projects/${project.public_id}`, widget = `/widget/projects/${project.public_id}`
  const keys = (await request(agent + '/keys', 'POST', {}, token)).data
  await request(agent, 'PATCH', { allowedOrigins: ['https://customer.example'] }, token)
  const session = (await request(prefix + '/sessions', 'POST', { externalId: 'realtime-c1', name: 'Ada' }, keys.ingestKey)).data
  const created = await request(prefix + '/conversations', 'POST', { externalId: 'realtime-c1', subject: 'Realtime', body: 'Hello', idempotencyKey: 'rt-create' }, keys.ingestKey)
  check(created.status === 201, 'conversation exists before enrollment')
  const conversation = created.data.conversation
  const checkpoint = { incarnation: crypto.randomUUID(), seq: 0 }
  const missing = await request(widget + '/realtime/replay', 'POST', { checkpoint }, session.token, 'https://customer.example')
  check(missing.status === 409 && missing.data.cursor === null && missing.data.snapshotRequired === true, 'finite replay cannot enroll absent channel')
  check((await request(widget + '/realtime/stream', 'POST', { checkpoint }, session.token, 'https://customer.example')).status === 409, 'initial stream cannot enroll absent channel')
  const snapshot = await request(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, session.token, 'https://customer.example')
  check(snapshot.status === 200 && snapshot.data.checkpoint.seq === 0 && snapshot.data.mode === 'realtime', 'authorized snapshot enrolls at matching channel head')
  check(snapshot.data.snapshot.conversations[0].id === conversation.id && snapshot.data.snapshot.detail.messages[0].body === 'Hello', 'snapshot shares bounded public current-view projection')
  const savedCookie = csrfCookie
  const browserRequest = async (path: string, body: unknown, credential = token, origin = 'https://operator.example', csrf = true) => {
    const result = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', origin, cookie: savedCookie + '; ' + authCookie(credential).split(';')[0], ...(csrf ? { 'x-csrf-token': csrfToken } : {}) }, body: JSON.stringify(body) })
    return { status: result.status, data: await result.json() as any, headers: result.headers }
  }
  const sessionSignIn = (await request('/login', 'POST', { email: 'owner@example.test', password: 'SecureSupport2026!' })).data.token
  const durable = (await startBrowserSession(sessionSignIn))!
  const durableRequest = async () => {
    const response = await fetch(base + agent + '/realtime/snapshot', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://operator.example', cookie: savedCookie + '; session_id=' + encodeURIComponent(durable.sessionId), 'x-csrf-token': csrfToken }, body: '{}' })
    return response.status
  }
  check(await durableRequest() === 200, 'native durable session cookie authorizes agent snapshot')
  await sessionLogout(durable.sessionId)
  check(await durableRequest() === 401, 'durable session revocation is read fresh')
  const operator = await browserRequest(agent + '/realtime/snapshot', { conversationId: conversation.id })
  check(operator.status === 200 && operator.data.mode === 'realtime', 'native token cookie with CSRF and exact configured Origin authorizes agent snapshot')
  check((await browserRequest(agent + '/realtime/snapshot', {}, token, 'https://operator.example', false)).status === 403, 'agent cookie requires native CSRF')
  check((await browserRequest(agent + '/realtime/snapshot', {}, token, 'https://evil.example')).status === 403, 'agent origin cannot follow Host or forwarded headers')
  check((await browserRequest(agent + '/realtime/snapshot', {}, otherToken)).status === 403, 'other workspace cookie cannot enroll agent project')
  for (const credential of [token, keys.ingestKey, keys.readKey]) check((await request(agent + '/realtime/snapshot', 'POST', {}, credential, 'https://operator.example')).status === 401, 'agent refuses bearer token and project keys')
  for (const origin of [undefined, 'null', '*', 'https://customer.example.evil', 'https://customer.example/path']) check((await request(widget + '/realtime/snapshot', 'POST', {}, session.token, origin)).status === 403, 'customer requires exact explicit current allowed Origin')
  check((await request(widget + '/realtime/snapshot', 'POST', {}, keys.ingestKey, 'https://customer.example')).status === 401, 'project key never grants customer replay authority')
  csrfCookie = savedCookie + '; ' + authCookie(token).split(';')[0]
  check((await request(widget + '/realtime/snapshot', 'POST', {}, undefined, 'https://customer.example')).status === 401, 'customer ignores ambient browser cookie authority')
  csrfCookie = savedCookie
  const rawRequest = async (body: BodyInit, queryString = '') => {
    const result = await fetch(base + widget + '/realtime/replay' + queryString, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://customer.example', authorization: 'Bearer ' + session.token }, body })
    return { status: result.status, data: await result.json() as any }
  }
  for (const body of [JSON.stringify({ checkpoint, contactId: session.contact.id }), JSON.stringify({ checkpoint, channel: 'support.agent.1' }), JSON.stringify({ checkpoint: { ...checkpoint, seq: -1 } }), JSON.stringify({ checkpoint: { ...checkpoint, seq: '0' } }), JSON.stringify({ checkpoint: { ...checkpoint, seq: 9007199254740992 } }), JSON.stringify({ checkpoint: null })]) check((await rawRequest(body)).status === 422, 'strict replay input rejects identity, extra and invalid cursor data')
  check((await rawRequest('{' + '"checkpoint":' + JSON.stringify(checkpoint) + ',"checkpoint":' + JSON.stringify(checkpoint) + '}')).status === 400, 'duplicate JSON cursor keys rejected before coercion')
  check((await rawRequest(new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125]))).status === 400, 'invalid UTF-8 rejected')
  check((await rawRequest(new ReadableStream({ start(controller) { for (let index = 0; index < 3; index++) controller.enqueue(new TextEncoder().encode(' '.repeat(3072))); controller.close() } }))).status === 413, 'chunked request body is bounded by actual bytes before parsing')
  check((await rawRequest(' '.repeat(8193))).status === 413, 'streamed body limited to 8KiB before JSON parse')
  check((await rawRequest(JSON.stringify({ checkpoint }), '?token=secret')).status === 422, 'credential and cursor URL inputs are refused')
  const customerHead = snapshot.data.checkpoint
  const privateNote = await request(agent + '/conversations/' + conversation.id + '/messages', 'POST', { body: 'Private note', visibility: 'internal', idempotencyKey: 'rt-private' }, token)
  check(privateNote.status === 201, 'private note mutation accepted')
  const unchanged = await request(widget + '/realtime/replay', 'POST', { checkpoint: customerHead }, session.token, 'https://customer.example')
  check(unchanged.status === 200 && unchanged.data.messages.length === 0 && unchanged.data.cursor.seq === customerHead.seq && unchanged.data.head.seq === customerHead.seq, 'private mutation does not advance customer head/time/cursor')
  const agentReplay = await browserRequest(agent + '/realtime/replay', { checkpoint: operator.data.checkpoint })
  check(agentReplay.status === 200 && agentReplay.data.messages.length === 1 && agentReplay.data.messages[0].event === 'changed' && agentReplay.data.messages[0].data === null, 'agent replay remains separate changed/null metadata')
  const publicInput = { body: 'Public reply', idempotencyKey: 'rt-public' }
  const publicReply = await request(agent + '/conversations/' + conversation.id + '/messages', 'POST', publicInput, token)
  check(publicReply.status === 201, 'public mutation appended')
  const finite = await request(widget + '/realtime/replay', 'POST', { checkpoint: customerHead }, session.token, 'https://customer.example')
  check(finite.status === 200 && finite.data.messages.length === 1 && finite.data.cursor.seq === customerHead.seq + 1 && finite.data.messages[0].data === null && !JSON.stringify(finite.data).includes('Public reply'), 'public replay contains only retained changed/null event and truthful cursor')
  await request(agent + '/conversations/' + conversation.id + '/messages', 'POST', publicInput, token)
  const retry = await request(widget + '/realtime/replay', 'POST', { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')
  check(retry.status === 200 && retry.data.messages.length === 0 && retry.data.cursor.seq === finite.data.cursor.seq, 'idempotent retry never appends duplicate durable replay')
  // Clock control proves cadence; a test-owned SQL trigger expires the real selected row.
  // The route, native replay adapter and renewal SQL are never replaced.
  const channelName = `support.customer.${project.id}.${session.contact.id}`
  const leaseStarted = Date.now()
  const boundaryTrigger = async (statement: string, targetChannel = channelName) => {
    const safeName = targetChannel.replace(/'/g, "''")
    if (config.database.default === 'postgres') {
      await query(`CREATE FUNCTION realtime_boundary() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${statement}; RETURN NEW; END $$`)
      await query(`CREATE TRIGGER realtime_boundary AFTER UPDATE OF name ON support_replay_channels FOR EACH ROW WHEN (NEW.name = '${safeName}' AND NEW.lease_until > 0) EXECUTE FUNCTION realtime_boundary()`)
      return async () => { await query('DROP TRIGGER realtime_boundary ON support_replay_channels'); await query('DROP FUNCTION realtime_boundary()') }
    }
    await query(`CREATE TRIGGER realtime_boundary AFTER UPDATE OF name ON support_replay_channels WHEN NEW.name = '${safeName}' AND NEW.lease_until > 0 BEGIN ${statement}; END`)
    return async () => { await query('DROP TRIGGER realtime_boundary') }
  }
  // Reach native readiness only after finite replay's two channel locks succeed.
  // Triggers synchronize real SQL in the same transaction, not an external writer race.
  freezeTime(leaseStarted)
  try {
    for (const scenario of ['expiry', 'renewal', 'incarnation', 'authority', 'storage']) {
      await query('UPDATE support_replay_channels SET lease_until = ? WHERE name = ?', [leaseStarted + 120000, channelName])
      await query('CREATE TABLE realtime_readiness_steps (steps INTEGER NOT NULL)')
      await query('INSERT INTO realtime_readiness_steps (steps) VALUES (0)')
      const atThird = '(SELECT steps FROM realtime_readiness_steps) = 3'
      const mutation = scenario === 'incarnation'
        ? `UPDATE support_replay_channels SET incarnation = '${crypto.randomUUID()}' WHERE id = NEW.id AND ${atThird}`
        : scenario === 'storage'
          ? config.database.default === 'postgres' ? `IF ${atThird} THEN RAISE EXCEPTION 'readiness test storage failure'; END IF` : `SELECT RAISE(ABORT, 'readiness test storage failure') WHERE ${atThird}`
          : `UPDATE support_replay_channels SET lease_until = 0 WHERE id = NEW.id AND ${atThird}`
      // Make the selected readiness row renewal-eligible without renewing during finite replay.
      const renewal = scenario === 'renewal' ? `UPDATE support_replay_channels SET lease_until = ${leaseStarted + 1} WHERE id = NEW.id AND (SELECT steps FROM realtime_readiness_steps) = 2; ` : ''
      const revoke = scenario === 'authority' ? `; UPDATE support_customer_sessions SET expires_at = 0 WHERE digest = '${digest(session.token)}' AND ${atThird}` : ''
      const remove = await boundaryTrigger(`UPDATE realtime_readiness_steps SET steps = steps + 1; ${renewal}${mutation}${revoke}`)
      try {
        const refused = await request(widget + '/realtime/stream', 'POST', { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')
        const recovery = ['expiry', 'renewal', 'incarnation'].includes(scenario)
        const committed = scenario === 'expiry' || scenario === 'incarnation'
        check(Number((await one('SELECT steps FROM realtime_readiness_steps'))!.steps) === (committed ? 3 : 2), 'native readiness ' + scenario + ' occurs after finite replay and respects transaction rollback')
        check(refused.status === (recovery ? 409 : scenario === 'authority' ? 401 : 503) && !('checkpoint' in refused.data) && !('snapshot' in refused.data), 'pre-header readiness ' + scenario + ' keeps its domain status and releases no state or checkpoint')
        check(recovery ? refused.data.cursor === null && refused.data.snapshotRequired === true : !('cursor' in refused.data) && !('snapshotRequired' in refused.data), 'only enrollment recovery adds the readiness recovery discriminator for ' + scenario)
        if (scenario === 'renewal') check(Number((await one('SELECT lease_until FROM support_replay_channels WHERE name = ?', [channelName]))!.lease_until) === leaseStarted + 1, 'readiness renewal refusal rolls back its expiry trigger and never extends the lease')
        if (scenario === 'authority') check(refused.data.error.code === 'invalid_session', 'current authority refusal is not serialized as stream unavailability or recovery')
        if (scenario === 'storage') check(streamFailureStage(refused.data.error?.message) === 'request', 'readiness storage failure is reported through the request error response')
      }
      finally {
        await remove(); await query('DROP TABLE realtime_readiness_steps')
        await query('UPDATE support_replay_channels SET incarnation = ?, lease_until = ? WHERE name = ?', [finite.data.cursor.incarnation, leaseStarted + 120000, channelName])
      }
    }
  }
  finally { useRealTime() }
  freezeTime(leaseStarted)
  try {
    await query('UPDATE support_replay_channels SET lease_until = ? WHERE name = ?', [leaseStarted + 120000, channelName])
    const lease = async () => Number((await one('SELECT lease_until FROM support_replay_channels WHERE name = ?', [channelName]))!.lease_until)
    travelTo(leaseStarted + 29999)
    check((await request(widget + '/realtime/replay', 'POST', { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')).status === 200 && await lease() === leaseStarted + 120000, 'replay cannot renew a lease before 30 seconds')
    travelTo(leaseStarted + 30000)
    check((await request(widget + '/realtime/replay', 'POST', { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')).status === 200 && await lease() === leaseStarted + 150000, 'replay renews at 30 seconds for exactly another 120 seconds')
    for (const operation of ['replay', 'snapshot', 'stream']) {
      travelTo(leaseStarted + 119999)
      await query('UPDATE support_replay_channels SET lease_until = ? WHERE name = ?', [leaseStarted + 120000, channelName])
      const remove = await boundaryTrigger('UPDATE support_replay_channels SET lease_until = 0 WHERE id = NEW.id')
      try {
        const boundary = await request(widget + '/realtime/' + operation, 'POST', operation === 'snapshot' ? {} : { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')
        check(boundary.status === 409 && boundary.data.cursor === null && boundary.data.snapshotRequired === true && !('checkpoint' in boundary.data) && !('snapshot' in boundary.data), operation + ' expiry after live selection returns the recovery envelope without state or advancement')
        check(await lease() === leaseStarted + 120000, 'expiry failure rolls back the trigger and cannot renew the persisted lease')
      }
      finally { await remove() }
    }
  }
  finally {
    useRealTime()
    await query('UPDATE support_replay_channels SET lease_until = ? WHERE name = ?', [Date.now() + 120000, channelName])
  }
  const ahead = await request(widget + '/realtime/replay', 'POST', { checkpoint: { ...finite.data.cursor, seq: finite.data.cursor.seq + 1 } }, session.token, 'https://customer.example')
  check(ahead.status === 409 && ahead.data.cursor === null && ahead.data.snapshotRequired, 'cursor ahead requires new snapshot without advancement')
  await query('UPDATE support_replay_channels SET lease_until = ? WHERE name = ?', [Date.now() - 1, `support.customer.${project.id}.${session.contact.id}`])
  const expiredReplay = await request(widget + '/realtime/replay', 'POST', { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')
  check(expiredReplay.status === 409 && expiredReplay.data.cursor === null, 'expired enrollment cannot renew through replay')
  const expiredStream = await request(widget + '/realtime/stream', 'POST', { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')
  check(expiredStream.status === 409, 'expired stream cannot recreate enrollment')
  const successor = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
  check(successor.status === 200 && successor.data.checkpoint.incarnation !== customerHead.incarnation && successor.data.checkpoint.seq === 0, 'authorized snapshot reincarnates expired enrollment cryptographically')
  const stale = await request(widget + '/realtime/replay', 'POST', { checkpoint: finite.data.cursor }, session.token, 'https://customer.example')
  check(stale.status === 409 && stale.data.cursor === null, 'old incarnation cannot replay or renew successor')
  await query('UPDATE support_customer_sessions SET expires_at = 0 WHERE digest = ?', [digest(session.token)])
  check((await request(widget + '/realtime/replay', 'POST', { checkpoint: successor.data.checkpoint }, session.token, 'https://customer.example')).status === 401, 'session expiry rechecked on each finite request')
  await query('UPDATE support_customer_sessions SET expires_at = ? WHERE digest = ?', [Date.now() + 86400000, digest(session.token)])
  await query("UPDATE support_memberships SET status = 'revoked' WHERE workspace_id = ?", [workspaceId])
  check((await browserRequest(agent + '/realtime/replay', { checkpoint: operator.data.checkpoint })).status === 403, 'membership revocation overrides native cached cookie identity')
  await query("UPDATE support_memberships SET status = 'active' WHERE workspace_id = ?", [workspaceId])
  const fullProject = (await one('SELECT * FROM support_projects WHERE id = ?', [project.id]))!
  const baseSnapshot = await request(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, session.token, 'https://customer.example')
  const baseMessages = baseSnapshot.data.snapshot.detail.messages.length
  const races = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
    const mutation = request(agent + '/conversations/' + conversation.id + '/messages', 'POST', { body: 'Race public ' + index, idempotencyKey: 'rt-race-' + index }, token)
    const snap = await request(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, session.token, 'https://customer.example')
    check((await mutation).status === 201, 'concurrent public mutation succeeds')
    return snap
  }))
  for (const snap of races) check(snap.status === 200 && snap.data.snapshot.detail.messages.length - baseMessages === snap.data.checkpoint.seq - baseSnapshot.data.checkpoint.seq, 'snapshot and matching head are atomic against simultaneous public mutations')
  // Test-only SQL triggers synchronize after projection reads, at the matching head read.
  // Two live-lease name updates reach the head read, including a newly leased enrollment.
  const lateSession = (await request(prefix + '/sessions', 'POST', { externalId: 'realtime-late-enrollment' }, keys.ingestKey)).data
  for (const scenario of ['expiry', 'origin', 'membership', 'new-enrollment']) {
    const isNew = scenario === 'new-enrollment', isAgent = scenario === 'membership'
    const credential = isNew ? lateSession.token : session.token
    const targetChannel = isAgent ? `support.agent.${project.id}` : isNew ? `support.customer.${project.id}.${lateSession.contact.id}` : channelName
    const mutation = scenario === 'origin'
      ? `UPDATE support_projects SET allowed_origins = '[]' WHERE id = ${Number(project.id)}`
      : isAgent ? `UPDATE support_memberships SET status = 'revoked' WHERE workspace_id = ${Number(workspaceId)} AND user_id = ${ownerId}`
        : `UPDATE support_customer_sessions SET expires_at = 0 WHERE digest = '${digest(credential)}'`
    await query('CREATE TABLE realtime_boundary_steps (steps INTEGER NOT NULL)')
    await query('INSERT INTO realtime_boundary_steps (steps) VALUES (0)')
    const remove = await boundaryTrigger(`UPDATE realtime_boundary_steps SET steps = steps + 1; ${mutation} AND (SELECT steps FROM realtime_boundary_steps) = 2`, targetChannel)
    try {
      const refused = isAgent ? await browserRequest(agent + '/realtime/snapshot', { conversationId: conversation.id }) : await request(widget + '/realtime/snapshot', 'POST', isNew ? {} : { conversationId: conversation.id }, credential, 'https://customer.example')
      check(refused.status === (scenario === 'expiry' || isNew ? 401 : 403) && !('snapshot' in refused.data) && !('checkpoint' in refused.data) && !('cursor' in refused.data) && !('snapshotRequired' in refused.data), 'post-read ' + scenario + ' change discards snapshot and checkpoint without masking authority failure')
      if (!isAgent) check(refused.headers.get('access-control-allow-origin') === 'https://customer.example', 'error CORS follows the current allowlist restored by transaction rollback')
    }
    finally { await remove(); await query('DROP TABLE realtime_boundary_steps') }
    if (isNew) {
      const noEnrollment = await request(widget + '/realtime/replay', 'POST', { checkpoint }, credential, 'https://customer.example')
      check(noEnrollment.status === 409 && noEnrollment.data.cursor === null && noEnrollment.data.snapshotRequired, 'failed post-read authorization rolls back a newly created enrollment')
    }
  }
  // A held workspace lock makes the HTTP principal stale before read/enrollment.
  let started!: () => void, release!: () => void
  const held = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const holding = workspaceTransaction(Number(workspaceId), async () => { started(); await gate; await query('UPDATE support_customer_sessions SET expires_at = 0 WHERE digest = ?', [digest(session.token)]) })
  await held
  const staleRead = request(widget + '/realtime/replay', 'POST', { checkpoint: baseSnapshot.data.checkpoint }, session.token, 'https://customer.example')
  await Bun.sleep(20); release(); await holding
  check((await staleRead).status === 401, 'finite request waiting on workspace lock resolves current credential after revocation')
  await query('UPDATE support_customer_sessions SET expires_at = ? WHERE digest = ?', [Date.now() + 86400000, digest(session.token)])
  const openStream = async (cursor: any, credential = session.token) => {
    const abort = new AbortController()
    const response = await fetch(base + widget + '/realtime/stream', { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json', origin: 'https://customer.example', authorization: 'Bearer ' + credential }, body: JSON.stringify({ checkpoint: cursor }) })
    try {
      const contentType = response.headers.get('content-type')
      const json = contentType?.startsWith('application/json') === true
      const failure = response.status !== 200 && json ? await response.json().catch(() => null) as { error?: { code?: unknown, message?: unknown } } | null : null
      const code = failure?.error?.code
      assert.deepEqual({
        status: response.status,
        eventStream: contentType === 'text/event-stream',
        json,
        exactOrigin: response.headers.get('access-control-allow-origin') === 'https://customer.example',
        retryAfter: response.status !== 200 && response.headers.has('retry-after'),
        errorCode: typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null,
        failureStage: response.status === 503 ? streamFailureStage(failure?.error?.message) : null,
      }, { status: 200, eventStream: true, json: false, exactOrigin: true, retryAfter: false, errorCode: null, failureStage: null }, 'native authenticated SSE response and current exact CORS')
      checks++
    }
    catch (error) {
      abort.abort()
      throw error
    }
    return { abort, reader: response.body!.getReader() }
  }
  const read = async (reader: ReadableStreamDefaultReader<Uint8Array>, timeout = 3000) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SSE read deadline')), timeout) })]) }
    finally { clearTimeout(timer) }
  }
  const openAgentStream = async (cursor: any, credentialCookie: string) => {
    const abort = new AbortController()
    const response = await fetch(base + agent + '/realtime/stream', { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json', origin: 'https://operator.example', cookie: savedCookie + '; ' + credentialCookie, 'x-csrf-token': csrfToken }, body: JSON.stringify({ checkpoint: cursor }) })
    check(response.status === 200 && response.headers.get('content-type') === 'text/event-stream', 'current native browser credential opens agent SSE')
    const reader = response.body!.getReader()
    check(new TextDecoder().decode((await read(reader)).value).includes(': connected'), 'agent SSE is established before authority changes')
    return { abort, reader }
  }
  // Established streams must read current primary authority on both delivery and idle heartbeat.
  for (const transition of ['membership', 'token', 'password', 'session']) {
    for (const checkpointKind of ['event', 'heartbeat']) {
      const credentialLogin = await request('/login', 'POST', { email: 'owner@example.test', password: 'SecureSupport2026!' })
      const credential = credentialLogin.data.token ?? credentialLogin.data.access_token ?? credentialLogin.data.data?.token
      const browserSession = transition === 'session' ? (await startBrowserSession(credential))! : undefined
      const credentialCookie = browserSession ? 'session_id=' + encodeURIComponent(browserSession.sessionId) : authCookie(credential).split(';')[0]!
      const enrolled = await browserRequest(agent + '/realtime/snapshot', {})
      const established = await openAgentStream(enrolled.data.checkpoint, credentialCookie)
      try {
        if (transition === 'membership') await query("UPDATE support_memberships SET status = 'revoked' WHERE workspace_id = ? AND user_id = ?", [workspaceId, ownerId])
        if (transition === 'token') await Auth.revokeToken(credential)
        if (transition === 'password') await query('UPDATE users SET password_changed_at = ? WHERE id = ?', ['2035-01-01T00:00:00.000', ownerId])
        if (browserSession) await sessionLogout(browserSession.sessionId)
        if (checkpointKind === 'event') await supportReplayInvalidations().publish(`support.agent.${project.id}`)
        check((await read(established.reader, checkpointKind === 'heartbeat' ? 18000 : 3000)).done === true, 'agent ' + transition + ' revocation closes established SSE at ' + checkpointKind + ' without state or error events')
      }
      finally {
        established.abort.abort(); await established.reader.cancel().catch(() => {})
        if (transition === 'membership') await query("UPDATE support_memberships SET status = 'active' WHERE workspace_id = ? AND user_id = ?", [workspaceId, ownerId])
        if (transition === 'password') await query('UPDATE users SET password_changed_at = NULL WHERE id = ?', [ownerId])
        if (browserSession) await sessionLogout(browserSession.sessionId)
      }
    }
  }
  const current = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
  const publicStream = await openStream(current.data.checkpoint)
  check(new TextDecoder().decode((await read(publicStream.reader)).value).includes(': connected'), 'native connected comment does not contain or advance cursor')
  await request(agent + '/conversations/' + conversation.id + '/messages', 'POST', { body: 'Stream public', idempotencyKey: 'rt-stream' }, token)
  const hint = new TextDecoder().decode((await read(publicStream.reader)).value)
  check(hint.includes('"event":"invalidated","data":null') && !hint.includes('Stream public') && !hint.includes('seq') && !hint.includes('incarnation'), 'stream forwards only tiny invalidation metadata with no durable cursor or transcript')
  publicStream.abort.abort(); await publicStream.reader.cancel().catch(() => {})
  if (process.env.SUPPORT_REALTIME_REDIS_URL) {
    const producer = async (body: string, key: string, visibility = 'public', offline = false) => {
      const result = await runIsolated('tests/fixtures/realtime-http-producer.ts', { args: [JSON.stringify({ projectId: project.id, conversationId: conversation.id, userId: ownerId, body, key, visibility })], env: offline ? { SUPPORT_REALTIME_REDIS_URL: 'redis://127.0.0.1:1' } : {}, envFile: false, preload: [], timeoutMs: 20000 })
      assertIsolatedOk(result, 'PASS independent HTTP replay producer')
    }
    const beforeWorker = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
    const independent = await openStream(beforeWorker.data.checkpoint)
    const decoder = new TextDecoder()
    let buffered = ''
    // Keepalive comments can arrive while the producer's process is starting.
    const readIndependentFrame = async (includeComments = false) => {
      const deadline = performance.now() + 20_000
      for (;;) {
        const end = buffered.indexOf('\n\n')
        if (end >= 0) {
          const frame = buffered.slice(0, end)
          buffered = buffered.slice(end + 2)
          if (includeComments || frame.split('\n').some(line => line.length > 0 && !line.startsWith(':'))) return frame
          continue
        }
        const remaining = Math.ceil(deadline - performance.now())
        if (remaining <= 0) throw new Error('SSE read deadline')
        const chunk = await read(independent.reader, remaining)
        if (chunk.done) return ''
        buffered += decoder.decode(chunk.value, { stream: true })
      }
    }
    check((await readIndependentFrame(true)) === ': connected', 'independent Redis subscriber is established before producer changes')
    let observed = false
    const nextHint = readIndependentFrame().then(value => { observed = true; return value })
    await producer('Private independent note', 'rt-process-private', 'internal')
    await Bun.sleep(50)
    check(!observed, 'independent private producer produces no customer invalidation')
    await producer('Independent public reply', 'rt-process-public')
    check((await nextHint).includes('"event":"invalidated","data":null'), 'independent process publication wakes native authorized HTTP SSE subscriber through real Redis')
    const workerPage = await request(widget + '/realtime/replay', 'POST', { checkpoint: beforeWorker.data.checkpoint }, session.token, 'https://customer.example')
    check(workerPage.status === 200 && workerPage.data.messages.length === 1, 'independent public producer advances durable customer replay exactly once')
    observed = false
    const lostHint = readIndependentFrame().then(value => { observed = true; return value })
    await producer('Lost publication public reply', 'rt-process-offline', 'public', true)
    await Bun.sleep(50)
    check(!observed, 'producer-only Redis outage leaves healthy subscriber without the lost hint')
    const recoveredLoss = await request(widget + '/realtime/replay', 'POST', { checkpoint: workerPage.data.cursor }, session.token, 'https://customer.example')
    check(recoveredLoss.status === 200 && recoveredLoss.data.messages.length === 1 && recoveredLoss.data.cursor.seq === workerPage.data.cursor.seq + 1, 'finite HTTP replay recovers lost producer publication while subscriber remains healthy')
    independent.abort.abort(); await independent.reader.cancel().catch(() => {}); await lostHint.catch(() => {})
  }
  const revoked = await openStream(current.data.checkpoint)
  await read(revoked.reader)
  await query('UPDATE support_customer_sessions SET expires_at = 0 WHERE digest = ?', [digest(session.token)])
  await supportReplayInvalidations().publish(`support.customer.${project.id}.${session.contact.id}`)
  check((await read(revoked.reader)).done === true, 'current authorization refusal closes native stream before forwarding event')
  revoked.abort.abort()
  await query('UPDATE support_customer_sessions SET expires_at = ? WHERE digest = ?', [Date.now() + 86400000, digest(session.token)])
  const originStream = await openStream(current.data.checkpoint)
  await read(originStream.reader)
  await query("UPDATE support_projects SET allowed_origins = '[]' WHERE id = ?", [project.id])
  check((await read(originStream.reader, 18000)).done === true, 'heartbeat rechecks current allowlist even without any events')
  originStream.abort.abort()
  await query('UPDATE support_projects SET allowed_origins = ? WHERE id = ?', [JSON.stringify(['https://customer.example']), project.id])
  const orphanSession = (await request(prefix + '/sessions', 'POST', { externalId: 'realtime-orphan' }, keys.ingestKey)).data
  const mismatchedProject = (await request(`/support/workspaces/${workspaceId}/projects`, 'POST', { name: 'Mismatched contact scope' }, token)).data.project
  await query('UPDATE support_contacts SET project_id = ? WHERE id = ? AND project_id = ? AND workspace_id = ?', [mismatchedProject.id, orphanSession.contact.id, project.id, workspaceId])
  check((await request(widget + '/realtime/snapshot', 'POST', {}, orphanSession.token, 'https://customer.example')).status === 401, 'customer session requires a currently existing contact in its exact project/workspace')
  const beforeRollback = await request(widget + '/realtime/replay', 'POST', { checkpoint: current.data.checkpoint }, session.token, 'https://customer.example')
  await assert.rejects(workspaceTransaction(Number(workspaceId), async () => { await reply(fullProject, conversation.id, { body: 'Rolled back', idempotencyKey: 'rt-rolledback' }, { userId: ownerId }); throw new Error('Expected rollback') }), /Expected rollback/)
  const afterRollback = await request(widget + '/realtime/replay', 'POST', { checkpoint: current.data.checkpoint }, session.token, 'https://customer.example')
  assert.deepEqual(afterRollback.data, beforeRollback.data, 'rollback preserves public replay checkpoint and rows'); checks++
  await assert.rejects(workspaceTransaction(Number(workspaceId), async () => await replayOperatorTransaction(async () => undefined)), /outer transaction/, 'operator lock cannot be acquired after workspace lock'); checks++
  const snapshotBeforeGap = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
  await query('DELETE FROM support_replay_events WHERE channel_id IN (SELECT id FROM support_replay_channels WHERE name = ?) AND seq = ?', [`support.customer.${project.id}.${session.contact.id}`, snapshotBeforeGap.data.checkpoint.seq])
  const storageGap = await request(widget + '/realtime/replay', 'POST', { checkpoint: { ...snapshotBeforeGap.data.checkpoint, seq: snapshotBeforeGap.data.checkpoint.seq - 1 } }, session.token, 'https://customer.example')
  check(storageGap.status === 503 && storageGap.data.cursor === null && storageGap.data.snapshotRequired, 'unexplained storage gap fails boundedly without skipping sequence')
  const beforeRetention = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
  for (let index = 0; index < 101; index++) await reply(fullProject, conversation.id, { body: 'Retained public ' + index, idempotencyKey: 'rt-retention-' + index }, { userId: ownerId })
  const retainedGap = await request(widget + '/realtime/replay', 'POST', { checkpoint: beforeRetention.data.checkpoint }, session.token, 'https://customer.example')
  check(retainedGap.status === 409 && retainedGap.data.cursor === null && retainedGap.data.snapshotRequired === true, 'native count-retention gap uses the same recovery envelope without advancing the omitted prefix')
  const bodyBefore = await request(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, session.token, 'https://customer.example')
  const huge = await insert('support_messages', { workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: Number(session.contact.id), body: '界'.repeat(100000), visibility: 'public', author_type: 'agent' })
  const oversized = await request(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, session.token, 'https://customer.example')
  check(oversized.status === 503 && !('checkpoint' in oversized.data) && Buffer.byteLength(JSON.stringify(oversized.data)) < 1024, 'oversized whole row fails snapshot without returning an advancing checkpoint')
  await query('DELETE FROM support_messages WHERE id = ?', [huge.id])
  const recovered = await request(widget + '/realtime/snapshot', 'POST', { conversationId: conversation.id }, session.token, 'https://customer.example')
  assert.deepEqual(recovered.data, bodyBefore.data, 'failed projection leaves snapshot/checkpoint unchanged'); checks++
  const brokenSession = (await request(prefix + '/sessions', 'POST', { externalId: 'realtime-broken' }, keys.ingestKey)).data
  const brokenConversation = await insert('support_conversations', { workspace_id: workspaceId, project_id: project.id, contact_id: Number(brokenSession.contact.id), subject: 'Imported oversized record', status: 'open' })
  const brokenMessage = await insert('support_messages', { workspace_id: workspaceId, project_id: project.id, conversation_id: brokenConversation.id, contact_id: Number(brokenSession.contact.id), body: '界'.repeat(100000), visibility: 'public', author_type: 'agent' })
  check((await request(widget + '/realtime/snapshot', 'POST', { conversationId: String(brokenConversation.id) }, brokenSession.token, 'https://customer.example')).status === 503, 'new enrollment with oversized selected history fails boundedly')
  check((await request(widget + '/realtime/replay', 'POST', { checkpoint }, brokenSession.token, 'https://customer.example')).status === 409, 'failed snapshot rolls back its new enrollment and checkpoint')
  await query('DELETE FROM support_messages WHERE id = ?', [brokenMessage.id])
  const nextSession = (await request(prefix + '/sessions', 'POST', { externalId: 'realtime-next' }, keys.ingestKey)).data
  const channelPolicy = (await one('SELECT policy FROM support_replay_channels LIMIT 1'))!.policy
  const fill = async (target: any, amount: number) => {
    if (!amount) return
    const incarnationPrefix = crypto.randomUUID().slice(0, 24)
    await query("WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < ?) INSERT INTO support_replay_channels (workspace_id, project_id, name, incarnation, high_water_mark, pruned_through, last_recorded_at, lease_until, policy) SELECT ?, ?, ? || CAST(n AS TEXT), ? || substr('000000000000' || CAST(n AS TEXT), length('000000000000' || CAST(n AS TEXT)) - 11, 12), 0, 0, 0, ?, ? FROM numbers", [amount, target.workspace_id, target.id, 'support.fixture.' + crypto.randomUUID() + '.', incarnationPrefix, Date.now() + 3600000, channelPolicy])
  }
  const countProject = Number((await one('SELECT COUNT(*) AS total FROM support_replay_channels WHERE project_id = ?', [project.id]))!.total)
  await fill(fullProject, 1536 - countProject)
  const projectCap = await request(widget + '/realtime/snapshot', 'POST', {}, nextSession.token, 'https://customer.example')
  check(projectCap.status === 200 && projectCap.data.mode === 'snapshot-only' && projectCap.data.checkpoint === null && !JSON.stringify(projectCap.data).includes('1536'), 'persisted project cap returns successful bounded polling snapshot without counts')
  check((await request(widget + '/realtime/replay', 'POST', { checkpoint }, nextSession.token, 'https://customer.example')).status === 409, 'capacity fallback creates no enrollment')
  check((await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')).data.mode === 'realtime', 'existing live enrollment continues at project capacity')
  const concurrentSession = (await request(prefix + '/sessions', 'POST', { externalId: 'realtime-cap-race' }, keys.ingestKey)).data
  await query('DELETE FROM support_replay_channels WHERE id = (SELECT id FROM support_replay_channels WHERE project_id = ? AND name LIKE ? ORDER BY id LIMIT 1)', [project.id, 'support.fixture.%'])
  const racingAdmissions = await Promise.all([nextSession.token, concurrentSession.token].map(credential => request(widget + '/realtime/snapshot', 'POST', {}, credential, 'https://customer.example')))
  check(racingAdmissions.every(result => result.status === 200) && racingAdmissions.map(result => result.data.mode).sort().join() === 'realtime,snapshot-only', 'concurrent snapshots serialize project-cap admission without rejecting core snapshot reads')
  const secondProject = (await request(`/support/workspaces/${workspaceId}/projects`, 'POST', { name: 'Second app' }, token)).data.project
  await fill(secondProject, 512)
  const thirdProject = (await request(`/support/workspaces/${workspaceId}/projects`, 'POST', { name: 'Third app' }, token)).data.project
  const workspaceCap = await browserRequest(`/support/projects/${thirdProject.public_id}/realtime/snapshot`, {})
  check(workspaceCap.status === 200 && workspaceCap.data.mode === 'snapshot-only', 'total persisted workspace cap applies across projects')
  await query('DELETE FROM support_replay_channels WHERE id = (SELECT id FROM support_replay_channels WHERE project_id = ? AND name LIKE ? ORDER BY id LIMIT 1)', [secondProject.id, 'support.fixture.%'])
  const workspaceRace = await Promise.all([secondProject, thirdProject].map(target => browserRequest(`/support/projects/${target.public_id}/realtime/snapshot`, {})))
  check(workspaceRace.every(result => result.status === 200) && workspaceRace.map(result => result.data.mode).sort().join() === 'realtime,snapshot-only', 'concurrent cross-project admission serializes workspace total cap')
  const secondWorkspace = (await request('/support/workspaces', 'POST', { name: 'Second workspace' }, token)).data.workspace
  const remoteProject = (await request(`/support/workspaces/${secondWorkspace.id}/projects`, 'POST', { name: 'Remote app' }, token)).data.project
  await fill(remoteProject, 1024)
  const globalCap = await browserRequest(`/support/projects/${remoteProject.public_id}/realtime/snapshot`, {})
  check(globalCap.status === 200 && globalCap.data.mode === 'snapshot-only', 'operator cap includes all persisted workspaces')
  const remoteSecondProject = (await request(`/support/workspaces/${secondWorkspace.id}/projects`, 'POST', { name: 'Remote second app' }, token)).data.project
  await query('DELETE FROM support_replay_channels WHERE id = (SELECT id FROM support_replay_channels WHERE project_id = ? AND name LIKE ? ORDER BY id LIMIT 1)', [remoteProject.id, 'support.fixture.%'])
  const operatorRace = await Promise.all([remoteProject, remoteSecondProject].map(target => browserRequest(`/support/projects/${target.public_id}/realtime/snapshot`, {})))
  check(operatorRace.every(result => result.status === 200) && operatorRace.map(result => result.data.mode).sort().join() === 'realtime,snapshot-only', 'concurrent workspace admissions serialize total persisted operator cap')
  // Only 127 background rows plus the target can be reclaimed per authorized snapshot.
  await query('UPDATE support_replay_channels SET lease_until = 0 WHERE name LIKE ?', ['support.fixture.%'])
  const persistedBefore = Number((await one('SELECT COUNT(*) AS total FROM support_replay_channels'))!.total)
  const prunedSnapshot = await request(widget + '/realtime/snapshot', 'POST', {}, nextSession.token, 'https://customer.example')
  const persistedAfter = Number((await one('SELECT COUNT(*) AS total FROM support_replay_channels'))!.total)
  check(prunedSnapshot.status === 200 && prunedSnapshot.data.mode === 'realtime' && persistedBefore - persistedAfter <= 128 && persistedBefore - persistedAfter > 0, 'snapshot cleanup is bounded and expired remaining rows still count')
  await query('DELETE FROM support_replay_events WHERE channel_id IN (SELECT id FROM support_replay_channels WHERE name LIKE ?)', ['support.fixture.%'])
  await query('DELETE FROM support_replay_channels WHERE name LIKE ?', ['support.fixture.%'])
  const beforeSlow = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
  const slow = await openStream(beforeSlow.data.checkpoint)
  await read(slow.reader)
  // Trusted local native broadcasts exercise its pending-authorization bound independently of hint coalescing.
  for (let index = 0; index < 100; index++) emit(`support.customer.${project.id}.${session.contact.id}`, 'changed', null)
  check((await read(slow.reader)).done === true, 'native pending/backpressure limit closes slow consumer instead of creating an error event')
  slow.abort.abort()
  const oldIncarnation = await openStream(beforeSlow.data.checkpoint)
  await read(oldIncarnation.reader)
  await query('UPDATE support_replay_channels SET lease_until = 0 WHERE name = ?', [`support.customer.${project.id}.${session.contact.id}`])
  const incarnationSnapshot = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
  await supportReplayInvalidations().publish(`support.customer.${project.id}.${session.contact.id}`)
  check((await read(oldIncarnation.reader)).done === true && incarnationSnapshot.data.checkpoint.incarnation !== beforeSlow.data.checkpoint.incarnation, 'old stream cannot renew or observe a snapshot-created successor incarnation')
  oldIncarnation.abort.abort()
  // Bounded workers keep enrollment and socket setup load finite while retaining 1000 live subscribers.
  const streams: Awaited<ReturnType<typeof openStream>>[] = []
  let nextSubscriber = 0
  let stopOpening = false
  try {
    const openings = await Promise.allSettled(Array.from({ length: 16 }, async () => {
      try {
        while (!stopOpening && nextSubscriber < 1000) {
          const index = nextSubscriber++
          const subscriber = await createSession(fullProject, { externalId: 'realtime-load-' + index })
          const enrolled = await request(widget + '/realtime/snapshot', 'POST', {}, subscriber.token, 'https://customer.example')
          check(enrolled.status === 200 && enrolled.data.mode === 'realtime', 'messenger enrolls within project/workspace/operator and native bounds')
          const liveStream = await openStream(enrolled.data.checkpoint, subscriber.token)
          streams.push(liveStream)
          await read(liveStream.reader)
        }
      }
      catch (error) {
        stopOpening = true
        throw error
      }
    }))
    const failure = openings.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    check(streams.length === 1000, '1000 distinct enrolled messenger channels retain simultaneous native HTTP subscriptions')
    const agentSnapshot = await browserRequest(agent + '/realtime/snapshot', {})
    const abort = new AbortController()
    const agentStream = await fetch(base + agent + '/realtime/stream', { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json', origin: 'https://operator.example', cookie: savedCookie + '; ' + authCookie(token).split(';')[0], 'x-csrf-token': csrfToken }, body: JSON.stringify({ checkpoint: agentSnapshot.data.checkpoint }) })
    check(agentStream.status === 200 && agentStream.headers.get('content-type') === 'text/event-stream', 'agent subscription also fits alongside 1000 messengers')
    abort.abort(); await agentStream.body?.cancel().catch(() => {})
  }
  finally {
    await Promise.all(streams.map(async entry => { entry.abort.abort(); await entry.reader.cancel().catch(() => {}) }))
  }
  // Native public subscriptions prove the physical bound and capacity reuse after routed cleanup.
  // This observes bus registrations; it does not claim introspection of native timers or hooks.
  const releases: (() => void)[] = []
  const capacitySnapshot = await request(widget + '/realtime/snapshot', 'POST', {}, session.token, 'https://customer.example')
  try {
    for (let index = 0; index < 4096; index++) releases.push(await supportReplayInvalidations().subscribe({ channels: [channelName], onInvalidate() {} }))
    const atCapacity = await fetch(base + widget + '/realtime/stream', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://customer.example', authorization: 'Bearer ' + session.token }, body: JSON.stringify({ checkpoint: capacitySnapshot.data.checkpoint }) })
    try {
      check(atCapacity.status === 503, 'native 4096 physical subscription cap refuses a routed stream after prior abort/backpressure cleanup')
      const refused = await atCapacity.json() as any
      check(refused.error?.code === 'realtime_unavailable' && Buffer.byteLength(JSON.stringify(refused)) < 1024, 'capacity failure is a bounded public error without state or enrollment counts')
      check(streamFailureStage(refused.error?.message) === 'stream-open', 'subscription capacity failure is reported through the stream open error response')
    }
    finally { await atCapacity.body?.cancel().catch(() => {}) }
    releases.pop()!()
    const reused = await openStream(capacitySnapshot.data.checkpoint)
    await read(reused.reader)
    reused.abort.abort(); await reused.reader.cancel().catch(() => {})
  }
  finally { for (const releaseSubscription of releases) releaseSubscription() }
  let escapedOperator: (() => Promise<unknown>) | undefined
  await replayOperatorTransaction(async () => {
    const resource = new (await import('node:async_hooks')).AsyncResource('operator-owner-test')
    escapedOperator = resource.bind(async () => await query('SELECT 1'))
    let releaseChild!: () => void, childStarted!: () => void
    const childGate = new Promise<void>(resolve => { releaseChild = resolve })
    const ready = new Promise<void>(resolve => { childStarted = resolve })
    const child = db.transaction(async () => { childStarted(); await childGate })
    await ready
    await assert.rejects(query('SELECT 1'), /active nested transaction/); checks++
    releaseChild(); await child
    await query('SELECT 1')
  })
  await assert.rejects(escapedOperator!(), /Active operator transaction/); checks++
  const durableForRevoke = await browserRequest(agent + '/realtime/snapshot', {})
  check(durableForRevoke.status === 200, 'agent cookie remains valid before explicit native revocation')
  await query('UPDATE users SET password_changed_at = ? WHERE id = ?', ['2035-01-01T00:00:00.000', ownerId])
  check((await browserRequest(agent + '/realtime/snapshot', {})).status === 401, 'native password-version check invalidates an older token cookie')
  await query('UPDATE users SET password_changed_at = NULL WHERE id = ?', [ownerId])
  await Auth.revokeToken(token)
  check((await browserRequest(agent + '/realtime/replay', { checkpoint: durableForRevoke.data.checkpoint })).status === 401, 'native token revocation overrides request identity caches')
  // Initial native bus unavailability stays an HTTP failure; existing streams use native close cleanup.
  const beforeUnavailable = await request(widget + '/realtime/snapshot', 'POST', {}, nextSession.token, 'https://customer.example')
  const beforeBusClose = await openStream(beforeUnavailable.data.checkpoint, nextSession.token)
  await read(beforeBusClose.reader)
  await supportReplayInvalidations().close()
  check((await read(beforeBusClose.reader)).done === true, 'subscriber bus closure closes existing native SSE and removes subscription')
  beforeBusClose.abort.abort()
  const unavailableStream = await request(widget + '/realtime/stream', 'POST', { checkpoint: beforeUnavailable.data.checkpoint }, nextSession.token, 'https://customer.example')
  check(unavailableStream.status === 503, 'unavailable invalidation transport refuses initial SSE subscription')
  console.log(`PASS authorized replay HTTP ${checks} checks`)
}
finally { await server.stop(true) }
