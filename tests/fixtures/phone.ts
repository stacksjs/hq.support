import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { phoneAction } from '../../app/Actions/Support/PhoneAction'
import { one, query } from '../../app/Support/database'
import { configureWalletLimits } from '../../app/Support/billing'
import { saveChannel } from '../../app/Support/channels'
import { executeSupportTool } from '../../app/Support/tools'
import { createArticle } from '../../app/Support/knowledge'
import { recoverPhoneRevocations } from '../../app/Support/phone-agents'
import { startVoiceServer } from '../../app/Support/voice-server'
import type { RealtimeSocket } from '@stacksjs/ai/realtime'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const accountSid = `AC${'a'.repeat(32)}`, numberSid = `PN${'b'.repeat(32)}`, apiKeySid = `SK${'c'.repeat(32)}`, authToken = 'fixture-voice-secret'
let providerWrites = 0, providerCreates = 0, failure: 'uncertain' | 'rejected' | undefined
let lostEndForChild: string | undefined
let observeOnParentRead: { sid: string, run: () => Promise<void> } | undefined
const calls = new Map<string, Record<string, unknown>>()
const hiddenListChildren = new Set<string>()
const provider = async (url: string, init?: RequestInit) => {
  assert.ok(url.startsWith(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/`))
  assert.equal(new Headers(init?.headers).get('authorization'), 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'))
  const method = init?.method ?? 'GET', body = new URLSearchParams(String(init?.body || ''))
  if (url.includes('IncomingPhoneNumbers')) {
    if (method === 'GET') return Response.json({ incoming_phone_numbers: [{ sid: numberSid, phone_number: '+14155550100', voice_url: null }] })
    providerWrites++
    return Response.json({ sid: numberSid, phone_number: '+14155550100', voice_url: body.get('VoiceUrl'), voice_method: body.get('VoiceMethod') })
  }
  const list = new URL(url)
  if (list.pathname.endsWith('/Calls.json') && method === 'GET') {
    const parent = list.searchParams.get('ParentCallSid')
    assert.ok(parent && calls.has(parent))
    return Response.json({ calls: [...calls.values()].filter(call => call.parent_call_sid === parent && !hiddenListChildren.has(String(call.sid))) })
  }
  const create = url.endsWith('/Calls.json') && method === 'POST'
  if (create) {
    providerWrites++; providerCreates++
    if (failure === 'rejected') { failure = undefined; return Response.json({ secret: 'provider error body must not leak' }, { status: 400 }) }
    assert.ok(Number(body.get('TimeLimit')) > 0 && Number(body.get('TimeLimit')) <= 930)
    const sid = 'CA' + providerCreates.toString(16).padStart(32, '0')
    const call = { sid, from: body.get('From'), to: body.get('To'), status: 'queued', direction: 'outbound-api', time_limit: Number(body.get('TimeLimit')), duration: null, price: null, price_unit: null }
    calls.set(sid, call)
    await Bun.sleep(20)
    if (failure === 'uncertain') { failure = undefined; throw new Error('Simulated response loss after provider commit') }
    return Response.json(call, { status: 201 })
  }
  const sid = /\/Calls\/(CA[a-f0-9]{32})\.json$/.exec(url)?.[1]
  const call = sid ? calls.get(sid) : undefined
  if (!call) return Response.json({}, { status: 404 })
  const observation = observeOnParentRead
  if (method === 'GET' && observation && observation.sid === sid) {
    observeOnParentRead = undefined
    await observation.run()
  }
  if (method === 'POST') {
    providerWrites++
    if (body.has('Status')) {
      if (call.status === 'ringing') assert.equal(body.get('Status'), 'canceled')
      if (call.status === 'in-progress') assert.equal(body.get('Status'), 'completed')
      call.status = body.get('Status')
      if (call.sid === lostEndForChild) { lostEndForChild = undefined; throw new Error('Simulated response loss after ending the child') }
    }
    if (body.has('TimeLimit')) call.time_limit = Number(body.get('TimeLimit'))
  }
  return Response.json(call)
}
const dependencies = { fetch: provider }
for (const [suffix, operation] of [['verify', 'verify'], ['calls', 'create'], ['token', 'token']] as const) {
  const path = suffix === 'verify' ? '/api/_phone/projects/{project}/channels/{channel}/verify' : `/api/_phone/projects/{project}/${suffix}`
  route.post(path, phoneAction(operation, 'POST', dependencies)).middleware('auth')
}
for (const operation of ['end', 'reconcile', 'takeover'] as const) route.post(`/api/_phone/projects/{project}/calls/{call}/${operation}`, phoneAction(operation, 'POST', dependencies)).middleware('auth')
route.get('/api/_phone/projects/{project}/capabilities', phoneAction('capabilities', 'GET', dependencies)).middleware('auth')
route.get('/api/_phone/projects/{project}/calls', phoneAction('list', 'GET', dependencies)).middleware('auth')
for (const operation of ['instructions', 'status', 'consent', 'agent', 'agent-progress', 'dial-complete', 'wait'] as const) route.post(`/api/_phone/calls/{call}/${operation}`, phoneAction(operation, 'POST', dependencies)).skipCsrf()
route.post('/api/_phone/channels/{channel}/incoming', phoneAction('incoming', 'POST', dependencies)).skipCsrf()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
let checks = 0, csrf = '', cookie = ''
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function request(path: string, method = 'GET', body?: unknown, token?: string) {
  const result = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const raw = await result.text()
  let data: any
  try { data = raw ? JSON.parse(raw) : null } catch { throw new Error(`${path} returned ${result.status}: ${raw.slice(0, 200)}`) }
  return { status: result.status, data }
}
async function nativeAccount(email: string) {
  check([200, 201].includes((await request('/register', 'POST', { name: 'Phone User', email, password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })).status), 'native phone account registers')
  const login = await request('/login', 'POST', { email, password: 'SecureSupport2026!' })
  return login.data.token ?? login.data.access_token ?? login.data.data?.token
}
function signature(publicUrl: string, fields: URLSearchParams) {
  let text = publicUrl
  for (const key of [...new Set(fields.keys())].sort()) for (const value of [...new Set(fields.getAll(key))].sort()) text += key + value
  return createHmac('sha1', authToken).update(text).digest('base64')
}
async function callback(callId: string, operation: string, call: Record<string, unknown>, extra: Record<string, string> = {}, valid = true) {
  const fields = new URLSearchParams({ AccountSid: accountSid, CallSid: String(call.sid), From: String(call.from), To: String(call.to), CallStatus: String(call.status), ...extra })
  const publicUrl = `https://support.example.test/api/phone/calls/${callId}/${operation}`
  const result = await fetch(base + `/_phone/calls/${callId}/${operation}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': valid ? signature(publicUrl, fields) : 'invalid' }, body: fields })
  return { status: result.status, text: await result.text() }
}
class ProviderRealtimeSocket extends EventTarget implements RealtimeSocket {
  readyState = 0
  bufferedAmount = 0
  sent: any[] = []
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) }) }
  emit(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
  send(raw: string) { const value = JSON.parse(raw); this.sent.push(value); if (value.type === 'session.update') queueMicrotask(() => this.emit({ type: 'session.updated', session: { id: 'fixture-realtime' } })) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')) }
}
async function until(condition: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await Bun.sleep(10) }
  throw new Error('Timed out: ' + label)
}
let mediaServer: Awaited<ReturnType<typeof startVoiceServer>> | undefined
try {
  const csrfResponse = await fetch(base + '/csrf-token'); csrf = (await csrfResponse.json() as { token: string }).token; cookie = csrfResponse.headers.get('set-cookie')!.split(';')[0]!
  const owner = await nativeAccount('phone-owner@example.test'), outsider = await nativeAccount('phone-outsider@example.test')
  const workspace = (await request('/support/workspaces', 'POST', { name: 'Phone Workspace' }, owner)).data.workspace
  const foreign = (await request('/support/workspaces', 'POST', { name: 'Other Phone Workspace' }, outsider)).data.workspace
  const project = (await request(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Phone Project' }, owner)).data.project
  await query('UPDATE support_workspaces SET wallet_cents = 10000 WHERE id = ?', [workspace.id])
  const user = await one('SELECT id FROM users WHERE email = ?', ['phone-owner@example.test'])
  await configureWalletLimits(Number(user!.id), Number(workspace.id), { dailyLimitCents: 20000, monthlyLimitCents: 40000 })
  const channel = await saveChannel(project, { provider: 'twilio', label: 'Support phone', configuration: { accountSid, authToken, fromNumber: '+14155550100', phoneNumberSid: numberSid, country: 'US', apiKeySid, apiKeySecret: 'fixture-api-key-secret', recordingNotice: 'This AI call creates a transcript. Press 1 to consent.' } }, Number(user!.id))
  check(!String(channel.configuration).includes(authToken), 'provider credentials encrypted in real SQL')
  process.env.SUPPORT_PHONE_PRICING = JSON.stringify({ [accountSid]: { telephonyCeilingCentsPerMinute: 25, aiCeilingCentsPerMinute: 50, dailyCapCents: 20000, monthlyCapCents: 40000, maxDurationSeconds: 60, realtimeModel: 'gpt-realtime', rates: { inputText: 1000000, inputAudio: 1000000, cachedText: 1000000, cachedAudio: 1000000, outputText: 1000000, outputAudio: 1000000 } } })
  const path = `/_phone/projects/${project.public_id}`
  const verified = await request(`${path}/channels/${channel.id}/verify`, 'POST', {}, owner)
  check(verified.status === 200 && verified.data.channel.status === 'ready', `phone ownership verified through provider HTTP ${JSON.stringify(verified.data)}`)
  check(!JSON.stringify(verified.data).includes(authToken), 'phone verification never returns credential')
  const capability = await request(`/_phone/projects/${project.public_id}/capabilities`, 'GET', undefined, owner)
  check(capability.status === 200 && capability.data.channels[0].browserAvailable && capability.data.channels[0].aiAvailable && capability.data.features.numberPurchase === false, 'capabilities expose verified readiness without promising unsupported purchases')
  check(!JSON.stringify(capability.data).includes(authToken) && !JSON.stringify(capability.data).includes('fixture-api-key-secret'), 'capabilities omit provider secrets')
  const beforeForeign = providerWrites
  check((await request(`${path}/channels/${channel.id}/verify`, 'POST', {}, outsider)).status === 403 && providerWrites === beforeForeign, 'foreign workspace user cannot verify channel or spend')
  check((await request(`${path}/calls`, 'POST', { channelId: channel.id, idempotencyKey: 'unsupported-country', to: '+12425550100', maxDurationSeconds: 60 }, owner)).status === 422, 'NANP outside US/Canada refused')
  const beforeBudget = providerCreates
  const aiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  check((await request(path + '/calls', 'POST', { channelId: channel.id, idempotencyKey: 'missing-ai', to: '+16135550109' }, owner)).status === 503 && providerCreates === beforeBudget, 'missing AI configuration fails before paid provider work')
  process.env.OPENAI_API_KEY = aiKey
  await query('UPDATE support_workspaces SET wallet_cents = 0 WHERE id = ?', [workspace.id])
  check((await request(path + '/calls', 'POST', { channelId: channel.id, idempotencyKey: 'no-wallet', to: '+16135550109' }, owner)).status === 402 && providerCreates === beforeBudget, 'prepaid wallet must cover maximum before any call')
  await query('UPDATE support_workspaces SET wallet_cents = 10000 WHERE id = ?', [workspace.id])
  const policies = JSON.parse(process.env.SUPPORT_PHONE_PRICING!)
  policies[accountSid].dailyCapCents = 100
  process.env.SUPPORT_PHONE_PRICING = JSON.stringify(policies)
  check((await request(path + '/calls', 'POST', { channelId: channel.id, idempotencyKey: 'daily-ceiling', to: '+16135550109' }, owner)).status === 402 && providerCreates === beforeBudget, 'daily maximum-cost ceiling stops paid provider work')
  policies[accountSid].dailyCapCents = 20000
  process.env.SUPPORT_PHONE_PRICING = JSON.stringify(policies)
  const projectWallet = `/support/projects/${project.public_id}/wallet/limits`
  check((await request(projectWallet, 'POST', { dailyLimitCents: 115, monthlyLimitCents: null }, owner)).status === 200, 'owner configures the project voice ceiling')
  const splitHold = await request(path + '/calls', 'POST', { channelId: channel.id, idempotencyKey: 'project-voice-ceiling', to: '+16135550109', maxDurationSeconds: 60 }, owner)
  check(splitHold.status === 402 && splitHold.data.error.code === 'project_wallet_limit' && providerCreates === beforeBudget, 'project must cover both projected telephony and AI costs before dialing')
  check(Number((await one('SELECT wallet_cents FROM support_workspaces WHERE id = ?', [workspace.id]))?.wallet_cents) === 10000 && (await query('SELECT id FROM support_wallet_reservations WHERE workspace_id = ?', [workspace.id])).length === 0, 'refusing the second voice reservation rolls back the first reservation and balance debit')
  await request(projectWallet, 'POST', { dailyLimitCents: null, monthlyLimitCents: null }, owner)
  const input = { channelId: channel.id, idempotencyKey: 'one-outbound', to: '+16135550100', maxDurationSeconds: 60 }
  const simultaneous = await Promise.all([request(path + '/calls', 'POST', input, owner), request(path + '/calls', 'POST', input, owner)])
  check(providerCreates === 1 && simultaneous.some(result => result.status === 201), `concurrent call attempts send one provider request ${JSON.stringify(simultaneous)}`)
  const created = await request(path + '/calls', 'POST', input, owner)
  check(created.status === 201 && providerCreates === 1, 'successful durable operation replays without new provider write')
  const callId = created.data.call.id
  const stored = await one('SELECT * FROM support_phone_calls WHERE public_id = ?', [callId])
  const providerCall = calls.get(String(stored!.provider_sid))!
  check(Number(providerCall.time_limit) === 90, 'hard call duration bound sent to actual provider boundary')
  check((await request(`/_phone/projects/${project.public_id}/calls`, 'GET', undefined, outsider)).status === 403, 'phone call list scoped to workspace membership')
  check((await callback(callId, 'instructions', providerCall, {}, false)).status === 401, 'unsigned phone callback rejected before state changes')
  const instructions = await callback(callId, 'instructions', providerCall)
  check(instructions.status === 200 && instructions.text.includes('<Gather') && !instructions.text.includes('<Stream'), 'voice asks explicit consent before media streaming')
  const consent = await callback(callId, 'consent', providerCall, { Digits: '1' })
  check(consent.status === 200 && consent.text.includes('wss://voice.example.test/phone/media/'), `consented call gets bound stream ${consent.text}`)
  const consented = await one('SELECT consent_at, deadline_at FROM support_phone_calls WHERE id = ?', [stored!.id])
  check(Number(consented?.consent_at) > 0 && Number(consented?.deadline_at) > Date.now(), 'consent and deadline work with native BIGINT fields on both databases')
  const grant = await request(path + '/token', 'POST', { channelId: channel.id }, owner)
  const tokenClaims = JSON.parse(Buffer.from(grant.data.token.split('.')[1], 'base64url').toString())
  check(grant.status === 200 && tokenClaims.grants.voice.incoming.allow === true && !tokenClaims.grants.voice.outgoing, 'official SDK token is agent/project-bound and cannot create unbudgeted outbound calls')
  await createArticle(project, { slug: 'phone-public', title: 'Phone answer', body: 'Public phone information', status: 'published', visibility: 'public' }, Number(user!.id))
  await createArticle(project, { slug: 'phone-private', title: 'Phone secret', body: 'Private phone secret', status: 'published', visibility: 'internal' }, Number(user!.id))
  let realtime: ProviderRealtimeSocket | undefined
  const streamCapacity = Number(process.env.SUPPORT_TEST_VOICE_STREAMS ?? 4)
  assert.ok(Number.isSafeInteger(streamCapacity) && streamCapacity > 0 && streamCapacity <= 32)
  const realtimePeers: ProviderRealtimeSocket[] = []
  mediaServer = await startVoiceServer({ port: 0, hostname: '127.0.0.1', maxStreams: streamCapacity, fetch: provider, realtimeSocket: () => {
    realtime = new ProviderRealtimeSocket()
    realtimePeers.push(realtime)
    return realtime
  } })
  const mediaPath = `/phone/media/${callId}`, publicMedia = `https://voice.example.test${mediaPath}`
  const unauthenticatedUpgrade = await fetch(`http://127.0.0.1:${mediaServer.port}${mediaPath}`, { headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'), 'sec-websocket-version': '13' } })
  check(unauthenticatedUpgrade.status === 401, 'provider media upgrade requires the exact signed public URL')
  const ClientSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket }
  const client = new ClientSocket(`ws://127.0.0.1:${mediaServer.port}${mediaPath}`, { headers: { 'x-twilio-signature': signature(publicMedia, new URLSearchParams()) } })
  const messages: any[] = []
  client.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolve, reject) => { client.addEventListener('open', () => resolve(), { once: true }); client.addEventListener('error', () => reject(new Error('Media connection failed')), { once: true }) })
  client.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }))
  const streamSid = `MZ${'d'.repeat(32)}`, proof = createHmac('sha256', authToken).update(`hq-support-stream:${callId}`).digest('hex')
  client.send(JSON.stringify({ event: 'start', sequenceNumber: '1', streamSid, start: { streamSid, accountSid, callSid: providerCall.sid, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { call: callId, proof } } }))
  await until(() => Boolean(realtime?.sent.some(value => value.type === 'session.update')), 'native realtime session initializes')
  client.send(JSON.stringify({ event: 'media', sequenceNumber: '2', streamSid, media: { track: 'inbound', chunk: '1', timestamp: '0', payload: Buffer.alloc(160, 255).toString('base64') } }))
  await until(() => Boolean(realtime?.sent.some(value => value.type === 'input_audio_buffer.append')), 'caller mulaw reaches native realtime transport')
  realtime!.emit({ type: 'response.created', response: { id: 'response-1' } })
  realtime!.emit({ type: 'response.output_audio.delta', item_id: 'assistant-item', delta: Buffer.alloc(320, 255).toString('base64') })
  await until(() => messages.some(value => value.event === 'mark'), 'assistant audio and playback marks reach actual provider socket')
  const mark = messages.find(value => value.event === 'mark')
  client.send(JSON.stringify({ event: 'mark', sequenceNumber: '3', streamSid, mark: mark.mark }))
  await Bun.sleep(20)
  realtime!.emit({ type: 'input_audio_buffer.speech_started', item_id: 'customer-barge-in' })
  await until(() => messages.some(value => value.event === 'clear'), 'barge-in clears provider playback')
  check(realtime!.sent.some(value => value.type === 'conversation.item.truncate' && value.audio_end_ms === 40), 'barge-in truncates only acknowledged played audio')
  const knowledge = await executeSupportTool(callId, 'knowledge-one', 'search_knowledge', { query: 'phone' })
  check(JSON.stringify(knowledge).includes('Public phone information') && !JSON.stringify(knowledge).includes('Private phone secret'), 'voice tools retrieve only published public project knowledge')
  const denied = await executeSupportTool(callId, 'denied-authority', 'create_ticket', { title: 'Injected', description: 'Injected', workspaceId: foreign.id })
  check(denied.error === 'unsupported_tool_arguments', 'voice tool cannot supply its own workspace authority')
  const ticket = await executeSupportTool(callId, 'ticket-one', 'create_ticket', { title: 'Voice ticket', description: 'Customer requested follow up' })
  const ticketAgain = await executeSupportTool(callId, 'ticket-one', 'create_ticket', { description: 'Customer requested follow up', title: 'Voice ticket' })
  check(JSON.stringify(ticket) === JSON.stringify(ticketAgain) && Number((await one("SELECT COUNT(*) AS total FROM support_tickets WHERE title = 'Voice ticket'", []))?.total) === 1, 'voice tool canonical idempotency creates exactly one customer-bound ticket')
  check(Number((await one('SELECT COUNT(*) AS total FROM support_phone_tool_results WHERE call_id = ?', [stored!.id]))?.total) === 3, 'allowed and refused tool calls have durable audit records')
  realtime!.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Caller requested support.' })
  realtime!.emit({ type: 'response.done', response: { id: 'response-1', usage: { input_tokens: 10, output_tokens: 6, input_token_details: { text_tokens: 5, audio_tokens: 5, cached_tokens: 0 }, output_token_details: { text_tokens: 2, audio_tokens: 4 } } } })
  await until(async () => Number((await one('SELECT COUNT(*) AS total FROM support_phone_usage WHERE call_id = ?', [stored!.id]))?.total) === 1, 'provider usage persists before close')
  client.send(JSON.stringify({ event: 'stop', sequenceNumber: '4', streamSid, stop: { accountSid, callSid: providerCall.sid } }))
  await until(async () => (await one('SELECT stream_state FROM support_phone_calls WHERE id = ?', [stored!.id]))?.stream_state === 'finished', 'provider stop closes native realtime session')
  check(realtime!.readyState === 3, 'media completion cleans up provider realtime transport')
  providerCall.status = 'completed'; providerCall.duration = '61'; providerCall.price = '-0.012345'; providerCall.price_unit = 'USD'
  const reconciled = await request(`${path}/calls/${callId}/reconcile`, 'POST', {}, owner)
  check(reconciled.status === 200 && !reconciled.data.pending, `exact actual-cost reconciliation ${JSON.stringify(reconciled.data)}`)
  const reservations = await query('SELECT * FROM support_wallet_reservations WHERE workspace_id = ? ORDER BY id', [workspace.id])
  check(reservations.length === 2 && Number(reservations[0]!.actual_cents) === 2 && Number(reservations[1]!.actual_cents) === 1, 'actual provider micros plus 15 percent round once per separate prepaid service')
  const wallet = Number((await one('SELECT wallet_cents FROM support_workspaces WHERE id = ?', [workspace.id]))?.wallet_cents)
  await request(`${path}/calls/${callId}/reconcile`, 'POST', {}, owner)
  check(Number((await one('SELECT wallet_cents FROM support_workspaces WHERE id = ?', [workspace.id]))?.wallet_cents) === wallet, 'usage reconciliation is idempotent')
  check((await callback(callId, 'status', providerCall, { SequenceNumber: '2' })).status === 204, 'signed terminal callback accepted')
  providerCall.status = 'ringing'
  await callback(callId, 'status', providerCall, { SequenceNumber: '1' })
  check((await one('SELECT status FROM support_phone_calls WHERE id = ?', [stored!.id]))?.status === 'completed', 'out-of-order provider callback cannot revive completed call')
  failure = 'uncertain'
  const uncertainInput = { ...input, idempotencyKey: 'uncertain-outbound', to: '+16135550101' }
  const uncertain = await request(path + '/calls', 'POST', uncertainInput, owner), attempts = providerCreates
  check(uncertain.status === 503 && uncertain.data.error.code === 'phone_write_uncertain', 'lost provider response remains explicitly uncertain')
  await request(path + '/calls', 'POST', uncertainInput, owner)
  check(providerCreates === attempts, 'durable uncertain operation never repeats provider write')
  check((await request(path + '/calls', 'POST', { ...uncertainInput, idempotencyKey: 'changed-uncertain-key' }, owner)).status === 409 && providerCreates === attempts, 'fresh key cannot bypass unresolved call ambiguity')
  const uncertainRow = await one("SELECT * FROM support_phone_calls WHERE workspace_id = ? AND operation_key = 'uncertain-outbound'", [workspace.id])
  const committedProviderCall = [...calls.values()].find(call => call.to === uncertainInput.to)!
  check((await callback(String(uncertainRow!.public_id), 'instructions', committedProviderCall)).status === 200, 'signed callback plus exact provider resource reconciles uncertain call identity')
  check((await request(path + '/calls', 'POST', uncertainInput, owner)).status === 201 && providerCreates === attempts, 'reconciled operation replays safely without another provider write')
  failure = 'rejected'
  const rejected = await request(path + '/calls', 'POST', { ...input, idempotencyKey: 'rejected-outbound', to: '+16135550102' }, owner)
  check(rejected.status === 503 && !JSON.stringify(rejected.data).includes('provider error body'), 'confirmed rejection remains safe and does not leak provider response')
  const rejectedRow = await one("SELECT public_id, status, ended_at FROM support_phone_calls WHERE workspace_id = ? AND operation_key = 'rejected-outbound'", [workspace.id])
  check(rejectedRow?.status === 'failed' && Number(rejectedRow.ended_at) > 0, 'confirmed rejection is terminal and does not appear as an active pending call')
  const rejectedReservations = await query('SELECT status, provider_cost_micros FROM support_wallet_reservations WHERE workspace_id = ? AND operation_key IN (?, ?)', [workspace.id, `phone:${rejectedRow!.public_id}`, `voice-ai:${rejectedRow!.public_id}`])
  check(rejectedReservations.length === 2 && rejectedReservations.every(row => row.status === 'released' && Number(row.provider_cost_micros) === 0), 'confirmed rejected call releases both prepaid holds with known zero cost')
  const handoffCreated = await request(path + '/calls', 'POST', { ...input, idempotencyKey: 'human-takeover', to: '+16135550103' }, owner)
  check(handoffCreated.status === 201, 'bounded human takeover starts with reserved paid call')
  const handoffId = handoffCreated.data.call.id
  const handoffRow = await one('SELECT * FROM support_phone_calls WHERE public_id = ?', [handoffId])
  const parentCall = calls.get(String(handoffRow!.provider_sid))!
  await callback(handoffId, 'consent', parentCall, { Digits: '1' })
  check((await request(`${path}/calls/${handoffId}/takeover`, 'POST', {}, outsider)).status === 403, 'foreign account cannot take over a phone call')
  check((await request(`${path}/calls/${handoffId}/takeover`, 'POST', {}, owner)).status === 200, 'native authenticated agent claims bounded phone handoff')
  const agentInstructions = await callback(handoffId, 'agent', parentCall)
  check(agentInstructions.status === 200 && agentInstructions.text.includes(`<Identity>w${workspace.id}.p${project.id}.u${user!.id}</Identity>`) && agentInstructions.text.includes('timeLimit='), `handoff TwiML uses server-derived browser identity and duration ${agentInstructions.text}`)
  const childSid = 'CA' + 'e'.repeat(32)
  calls.set(childSid, { sid: childSid, from: '+14155550100', to: `client:w${workspace.id}.p${project.id}.u${user!.id}`, parent_call_sid: parentCall.sid, direction: 'outbound-dial', status: 'completed', duration: '20', price: '-0.005000', price_unit: 'USD' })
  parentCall.status = 'completed'; parentCall.duration = '30'; parentCall.price = '-0.010000'; parentCall.price_unit = 'USD'
  check((await callback(handoffId, 'dial-complete', parentCall, { DialCallSid: childSid })).status === 200, 'signed parent callback binds exact child leg receipt')
  const handoffSettled = await request(`${path}/calls/${handoffId}/reconcile`, 'POST', {}, owner)
  check(handoffSettled.status === 200 && !handoffSettled.data.pending, `parent and exact owned child settle together ${JSON.stringify(handoffSettled.data)}`)
  const handoffCharge = await one('SELECT provider_cost_micros, actual_cents FROM support_wallet_reservations WHERE public_id = ?', [handoffRow!.reservation_id])
  check(Number(handoffCharge?.provider_cost_micros) === 15000 && Number(handoffCharge?.actual_cents) === 2, 'handoff sums both actual leg microcharges before one cents rounding')
  process.env.SUPPORT_DEPLOYMENT_MODE = 'hosted'
  await query("UPDATE support_workspaces SET plan = 'enterprise' WHERE id = ?", [workspace.id])
  await query("UPDATE support_conversations SET status = 'closed', updated_at = ? WHERE id = ? AND workspace_id = ?", [new Date(Date.now() - 100 * 86400000).toISOString(), stored!.conversation_id, workspace.id])
  const directoryPath = `/support/workspaces/${workspace.id}/enterprise`
  const scimPath = `/scim/v2/${workspace.id}/Users`
  const revokedEmail = 'phone-deprovisioned@example.test'
  const scopedAgent = await nativeAccount(revokedEmail)
  const directoryUser = await one('SELECT id FROM users WHERE email = ?', [revokedEmail])
  assert.ok(directoryUser)
  assert.equal((await request(directoryPath + '/provider', 'POST', { protocol: 'oidc', issuer: 'https://directory.example.test', clientId: 'owned-phone-fixture' }, owner)).status, 201)
  const directoryToken = (await request(directoryPath + '/scim-tokens', 'POST', {}, owner)).data.token
  assert.ok(directoryToken)
  const provisioned = await request(scimPath, 'POST', { userName: revokedEmail, externalId: 'phone-agent', active: true }, directoryToken)
  assert.equal(provisioned.status, 201)
  await query("UPDATE support_memberships SET user_id = ?, status = 'active' WHERE workspace_id = ? AND email = ?", [directoryUser.id, workspace.id, revokedEmail])
  const activeLeg = await request(path + '/calls', 'POST', { ...input, idempotencyKey: 'native-membership-revocation', to: '+16135550104' }, owner)
  assert.equal(activeLeg.status, 201)
  const legId = activeLeg.data.call.id
  const callRow = await one('SELECT * FROM support_phone_calls WHERE public_id = ?', [legId])
  assert.ok(callRow)
  const providerLeg = calls.get(String(callRow.provider_sid))
  assert.ok(providerLeg)
  assert.equal((await callback(legId, 'consent', providerLeg, { Digits: '1' })).status, 200)
  assert.equal((await request(`${path}/calls/${legId}/takeover`, 'POST', {}, scopedAgent)).status, 200)
  const connectedInstructions = await callback(legId, 'agent', providerLeg)
  assert.equal(connectedInstructions.status, 200)
  assert.ok(connectedInstructions.text.includes('<Client '))
  providerLeg.status = 'in-progress'
  const browserLeg = { sid: 'CA' + 'f'.repeat(32), from: '+14155550100', to: `client:w${workspace.id}.p${project.id}.u${directoryUser.id}`, parent_call_sid: providerLeg.sid, direction: 'outbound-dial', status: 'in-progress' }
  const peerLeg = { ...browserLeg, sid: 'CA' + 'a'.repeat(32), to: `client:w${workspace.id}.p${project.id}.u${user!.id}` }
  calls.set(browserLeg.sid, browserLeg)
  calls.set(peerLeg.sid, peerLeg)
  const ringingLeg = { ...browserLeg, sid: 'CA' + 'b'.repeat(32), status: 'ringing' }
  calls.set(ringingLeg.sid, ringingLeg)
  assert.ok(connectedInstructions.text.includes('agent-progress'))
  const legacyCreated = await request(path + '/calls', 'POST', { ...input, idempotencyKey: 'legacy-reassigned-dial', to: '+16135550105' }, owner)
  assert.equal(legacyCreated.status, 201)
  const legacyId = legacyCreated.data.call.id
  const legacyCall = await one('SELECT * FROM support_phone_calls WHERE public_id = ?', [legacyId])
  assert.ok(legacyCall)
  await query('UPDATE support_phone_calls SET tracks_agent_dials = ? WHERE id = ?', [false, legacyCall.id])
  const legacyParent = calls.get(String(legacyCall.provider_sid))
  assert.ok(legacyParent)
  assert.equal((await callback(legacyId, 'consent', legacyParent, { Digits: '1' })).status, 200)
  assert.equal((await request(`${path}/calls/${legacyId}/takeover`, 'POST', {}, owner)).status, 200)
  legacyParent.status = 'in-progress'
  const legacyChild = { ...browserLeg, sid: 'CA' + '6'.repeat(32), parent_call_sid: legacyParent.sid, status: 'in-progress' }
  calls.set(legacyChild.sid, legacyChild)
  const requestsBeforeRevocation = providerWrites
  const revoked = await request(scimPath + '/' + provisioned.data.id, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }, directoryToken)
  assert.equal(revoked.status, 200)
  assert.equal(revoked.data.active, false)
  assert.equal((await callback(legId, 'agent', providerLeg)).status, 403)
  const revocation = await one('SELECT * FROM support_phone_agent_dials WHERE call_id = ? AND agent_id = ?', [callRow.id, directoryUser.id])
  check(Number(revocation?.revoked_at) > 0, 'SCIM persists an agent-specific dial revocation before provider writes')
  check(providerWrites === requestsBeforeRevocation, 'the native directory transaction commits without waiting on provider operations')
  const nativeQueued = await one("SELECT id FROM jobs WHERE queue = 'support-workflows' AND payload LIKE ?", ['%EndRevokedPhoneLegs%'])
  check(nativeQueued, 'SCIM dispatches the native provider cleanup job')
  const repeated = await request(scimPath + '/' + provisioned.data.id, 'PUT', { userName: revokedEmail, active: false }, directoryToken)
  check(repeated.status === 200, 'repeat deactivation is accepted')
  check(Number((await one('SELECT COUNT(*) AS total FROM support_phone_agent_dials WHERE call_id = ? AND agent_id = ?', [callRow.id, directoryUser.id]))?.total) === 1, 'repeat deactivation reuses one persisted intent')
  assert.equal((await callback(legId, 'agent-progress', browserLeg, { ParentCallSid: 'CA' + '7'.repeat(32) })).status, 403)
  assert.equal((await callback(legId, 'agent-progress', browserLeg, { ParentCallSid: String(providerLeg.sid) }, false)).status, 401)
  // A child progress callback queued before revocation can arrive after the directory transaction.
  assert.equal((await callback(legId, 'agent-progress', browserLeg, { ParentCallSid: String(providerLeg.sid) })).status, 204)
  hiddenListChildren.add(browserLeg.sid)
  lostEndForChild = browserLeg.sid
  await recoverPhoneRevocations(dependencies)
  check(browserLeg.status === 'completed' && ringingLeg.status === 'canceled' && peerLeg.status === 'in-progress', 'the worker terminates connected and ringing legs for the revoked identity and preserves the other agent')
  check(legacyChild.status === 'completed', 'the worker also recovers an exact previous-agent leg on an untracked legacy parent')
  check(providerWrites === requestsBeforeRevocation + 3, 'each scoped leg receives a single provider operation')
  const uncertainEnd = await one("SELECT id FROM support_phone_operations WHERE key LIKE ? AND state = 'uncertain'", ['%:revoke-agent:%'])
  check(uncertainEnd, 'the lost response is journaled as uncertain')
  providerLeg.status = 'completed'
  const lateLeg = { ...browserLeg, sid: 'CA' + '5'.repeat(32), status: 'ringing' }
  hiddenListChildren.add(lateLeg.sid)
  observeOnParentRead = { sid: String(providerLeg.sid), async run() {
    calls.set(lateLeg.sid, lateLeg)
    assert.equal((await callback(legId, 'agent-progress', lateLeg, { ParentCallSid: String(providerLeg.sid) })).status, 204)
  } }
  const peerServer = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    return provider('https://api.twilio.com' + url.pathname + url.search, { method: request.method, headers: request.headers, body: request.method === 'POST' ? await request.text() : undefined })
  } })
  try {
    const restart = async () => {
      const result = await runIsolated('tests/fixtures/phone-revocation-worker.ts', { env: { SUPPORT_TEST_PHONE_PROVIDER: peerServer.url.origin }, envFile: false, preload: [], timeoutMs: 12000 })
      assertIsolatedOk(result, 'PASS native phone revocation recovery')
    }
    await query('UPDATE support_phone_agent_dials SET available_at = 0, lease_until = ? WHERE id = ?', [Date.now() + 60_000, revocation!.id])
    await restart()
    check((await one('SELECT state FROM support_phone_operations WHERE id = ?', [uncertainEnd!.id]))?.state === 'uncertain', 'a fresh worker respects the existing lease')
    await query('UPDATE support_phone_agent_dials SET lease_until = 0 WHERE id = ?', [revocation!.id])
    await restart()
  }
  finally { await peerServer.stop(true) }
  check(providerWrites === requestsBeforeRevocation + 3, 'restart recovery verifies terminal state without a duplicate provider write')
  check((await one('SELECT state FROM support_phone_operations WHERE id = ?', [uncertainEnd!.id]))?.state === 'succeeded', 'the exact terminal child resolves the uncertain journal')
  check(Number((await one('SELECT finished_at FROM support_phone_agent_dials WHERE id = ?', [revocation!.id]))?.finished_at) === 0 && !observeOnParentRead, 'late provider progress during a lease keeps the intent open')
  await recoverPhoneRevocations(dependencies)
  check(lateLeg.status === 'canceled' && providerWrites === requestsBeforeRevocation + 4, 'the new durable progress signal ends the late child once')
  await query('UPDATE support_phone_agent_dials SET available_at = 0 WHERE id = ?', [revocation!.id])
  await recoverPhoneRevocations(dependencies)
  check(Number((await one('SELECT finished_at FROM support_phone_agent_dials WHERE id = ?', [revocation!.id]))?.finished_at) > 0, 'recovery finishes after the provider parent ends')
  const billingChildren = await query("SELECT payload FROM support_phone_events WHERE call_id = ? AND status = 'dial-complete'", [callRow.id])
  assert.deepEqual(billingChildren.map(row => JSON.parse(String(row.payload)).childSid).sort(), [browserLeg.sid, ringingLeg.sid, lateLeg.sid].sort(), 'terminal child evidence remains available for billing')
  check((await request(scimPath + '/' + provisioned.data.id, 'PUT', { userName: revokedEmail, active: true }, directoryToken)).status === 200, 'the directory can reactivate the workspace member')
  check((await callback(legId, 'agent', providerLeg)).status === 403, 'a reactivated member cannot revive a previously revoked dial')
  check((await request(`${path}/calls/${legId}/takeover`, 'POST', {}, scopedAgent)).status === 403, 'a reactivated member cannot redirect the old caller back to their browser')
  assert.equal((await callback(legId, 'status', providerLeg, { SequenceNumber: '10' })).status, 204)
  Object.assign(providerLeg, { duration: '30', price: '-0.010000', price_unit: 'USD' })
  Object.assign(browserLeg, { duration: '12', price: '-0.003000', price_unit: 'USD' })
  Object.assign(ringingLeg, { duration: '0', price: '0.000000', price_unit: 'USD' })
  Object.assign(lateLeg, { duration: '0', price: '0.000000', price_unit: 'USD' })
  Object.assign(peerLeg, { status: 'completed', duration: '14', price: '-0.004000', price_unit: 'USD' })
  const agentDialComplete = await callback(legId, 'dial-complete', providerLeg, { DialCallSid: peerLeg.sid })
  assert.equal(agentDialComplete.status, 200)
  assert.match(agentDialComplete.text, /<Hangup\s*\/>/, 'completed browser dial follows the existing caller hangup instructions')
  const agentSettlement = await request(`${path}/calls/${legId}/reconcile`, 'POST', {}, owner)
  check(agentSettlement.status === 200 && !agentSettlement.data.pending, 'the original authorization and all actual child costs reconcile after deprovisioning')
  const endedCharge = await one('SELECT provider_cost_micros FROM support_wallet_reservations WHERE public_id = ?', [callRow.reservation_id])
  check(Number(endedCharge?.provider_cost_micros) === 17000, 'each confirmed child contributes its actual charge once')
  const retention = `/support/workspaces/${workspace.id}/enterprise/retention`
  check((await request(retention, 'PUT', { days: 30, enabled: true }, owner)).status === 200, 'enterprise voice content retention uses native paid-plan authority')
  await request(retention + `/holds/${stored!.conversation_id}`, 'PUT', { active: true, reason: 'Voice legal hold' }, owner)
  await request(retention + '/run', 'POST', {}, owner)
  check(String((await one('SELECT transcript FROM support_phone_calls WHERE id = ?', [stored!.id]))?.transcript).includes('Caller requested support'), 'conversation legal hold also preserves its voice transcript')
  await request(retention + `/holds/${stored!.conversation_id}`, 'PUT', { active: false, reason: 'Hold released' }, owner)
  const retained = await request(retention + '/run', 'POST', {}, owner)
  check(retained.status === 200 && retained.data.processed === 1 && (await one('SELECT transcript FROM support_phone_calls WHERE id = ?', [stored!.id]))?.transcript === '[Removed by retention policy]', `closed voice transcript follows native retention policy ${JSON.stringify(retained.data)}`)
  check(!String((await one("SELECT result FROM support_phone_tool_results WHERE call_id = ? AND tool_call_id = 'ticket-one'", [stored!.id]))?.result).includes('Voice ticket'), 'voice tool response copies obey the same retention policy')

  const concurrentCalls = []
  for (let index = 0; index <= streamCapacity; index++) {
    const started = await request(path + '/calls', 'POST', { ...input, idempotencyKey: `media-load-${index}`, to: `+161355501${20 + index}` }, owner)
    assert.equal(started.status, 201)
    const id = String(started.data.call.id)
    const row = (await one('SELECT provider_sid FROM support_phone_calls WHERE public_id = ?', [id]))!
    const provider = calls.get(String(row.provider_sid))!
    assert.equal((await callback(id, 'consent', provider, { Digits: '1' })).status, 200)
    concurrentCalls.push({ id, sid: String(row.provider_sid), stream: `MZ${(index + 1).toString(16).padStart(32, '0')}` })
  }
  const mediaHeaders = (id: string) => ({ 'x-twilio-signature': signature(`https://voice.example.test/phone/media/${id}`, new URLSearchParams()) })
  const upgrade = (id: string) => fetch(`http://127.0.0.1:${mediaServer!.port}/phone/media/${id}`, { headers: { ...mediaHeaders(id), upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'), 'sec-websocket-version': '13' } })
  async function openMedia(id: string) {
    const socket = new ClientSocket(`ws://127.0.0.1:${mediaServer!.port}/phone/media/${id}`, { headers: mediaHeaders(id) })
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('Concurrent media connection failed')), { once: true })
    })
    return socket
  }
  const streams = await Promise.all(concurrentCalls.slice(0, streamCapacity).map(async call => ({ ...call, socket: await openMedia(call.id) })))
  const overflow = concurrentCalls[streamCapacity]!
  check((await upgrade(streams[0]!.id)).status === 409, 'a pending call admits exactly one signed media socket')
  check((await upgrade(overflow.id)).status === 503, 'media listener rejects new sessions at its configured capacity')
  const firstPeer = realtimePeers.length
  const startedAt = performance.now()
  for (const { id, sid, stream, socket } of streams) {
    socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }))
    socket.send(JSON.stringify({ event: 'start', sequenceNumber: '1', streamSid: stream, start: { streamSid: stream, accountSid, callSid: sid, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { call: id, proof: createHmac('sha256', authToken).update(`hq-support-stream:${id}`).digest('hex') } } }))
  }
  await until(() => realtimePeers.length === firstPeer + streams.length, 'all admitted streams initialize their independent native realtime sessions')
  const framesPerStream = 50
  const payload = Buffer.alloc(160, 255).toString('base64')
  for (let frame = 0; frame < framesPerStream; frame++) {
    for (const { stream, socket } of streams) socket.send(JSON.stringify({ event: 'media', sequenceNumber: String(frame + 2), streamSid: stream, media: { track: 'inbound', chunk: String(frame + 1), timestamp: String(frame * 20), payload } }))
    await Bun.sleep(20)
  }
  const loadedPeers = realtimePeers.slice(firstPeer)
  await until(() => loadedPeers.every(peer => peer.sent.filter(event => event.type === 'input_audio_buffer.append').length === framesPerStream), 'every frame reaches the correct realtime session under concurrent load')
  for (const { sid, stream, socket } of streams) socket.send(JSON.stringify({ event: 'stop', sequenceNumber: String(framesPerStream + 2), streamSid: stream, stop: { accountSid, callSid: sid } }))
  await until(() => loadedPeers.every(peer => peer.readyState === 3), 'all concurrent realtime sessions release resources after stop')
  await until(() => streams.every(stream => calls.get(stream.sid)?.status === 'completed'), 'all closed media streams finish the test provider calls')
  const next = await openMedia(overflow.id)
  check(next.readyState !== WebSocket.CONNECTING, 'a new signed media socket can use released capacity')
  console.log(`PASS voice load (${streams.length} parallel streams, ${streams.length * framesPerStream} audio frames, ${Math.round(performance.now() - startedAt)} ms)`)
  const nextPeerIndex = realtimePeers.length
  next.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }))
  next.send(JSON.stringify({ event: 'start', sequenceNumber: '1', streamSid: overflow.stream, start: { streamSid: overflow.stream, accountSid, callSid: overflow.sid, tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { call: overflow.id, proof: createHmac('sha256', authToken).update(`hq-support-stream:${overflow.id}`).digest('hex') } } }))
  await until(() => realtimePeers.length > nextPeerIndex && realtimePeers[nextPeerIndex]!.sent.some(event => event.type === 'session.update'), 'the new session opens its realtime provider connection')
  const nextPeer = realtimePeers[nextPeerIndex]!
  for (let event = 0; event < 101; event++) nextPeer.emit({ type: 'input_audio_buffer.speech_started', item_id: 'fixture-burst' })
  await until(() => next.readyState === WebSocket.CLOSED && nextPeer.readyState === 3, 'a stalled realtime consumer closes both sockets when its queue is full')
  await until(async () => (await one('SELECT last_error FROM support_phone_calls WHERE public_id = ?', [overflow.id]))?.last_error === 'realtime_backpressure', 'provider backlog is recorded as a failed media stream')
  console.log(`PASS phone HTTP and media (${checks} checks)`)
  if (process.env.SUPPORT_PHONE_BROWSER_FIXTURE === '1') {
    const statePath = process.env.SUPPORT_PHONE_FIXTURE_STATE
    if (!statePath) throw new Error('SUPPORT_PHONE_FIXTURE_STATE is required for the browser fixture')
    const nativeFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.hostname === 'api.twilio.com') return await provider(url.href, init)
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('External network is blocked by the phone browser fixture')
      return await nativeFetch(input, init)
    }) as typeof fetch
    const policy = JSON.parse(process.env.SUPPORT_PHONE_PRICING!)
    policy[accountSid].maxDurationSeconds = 900
    process.env.SUPPORT_PHONE_PRICING = JSON.stringify(policy)
    const live = await request(path + '/calls', 'POST', { ...input, idempotencyKey: 'browser-incoming-fixture', to: '+16135550105', maxDurationSeconds: 900 }, owner)
    const liveRow = await one('SELECT * FROM support_phone_calls WHERE public_id = ?', [live.data.call.id])
    await callback(live.data.call.id, 'consent', calls.get(String(liveRow!.provider_sid))!, { Digits: '1' })
    const freshLogin = await request('/login', 'POST', { email: 'phone-owner@example.test', password: 'SecureSupport2026!' })
    const freshToken = freshLogin.data.token ?? freshLogin.data.access_token ?? freshLogin.data.data?.token
    const { startBrowserSession, browserSessionCookie } = await import('@stacksjs/auth')
    const browser = await startBrowserSession(freshToken)
    assert.ok(browser)
    await Bun.write(statePath, JSON.stringify({ apiOrigin: base.replace(/\/api$/, ''), project: project.public_id, workspaceId: workspace.id, channelId: String(channel.id), callId: live.data.call.id, browserCookie: browserSessionCookie(browser).split(';')[0], mediaOrigin: `http://127.0.0.1:${mediaServer.port}` }))
    await (await import('node:fs/promises')).chmod(statePath, 0o600)
    console.log('READY phone browser fixture')
    await new Promise<void>(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
  }

}
finally { mediaServer?.stop(true); server.stop(true) }
