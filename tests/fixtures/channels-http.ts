import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { Storage, createSignedStorageToken } from '@stacksjs/storage'
import { upload } from '../../app/Support/attachments'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { runIsolated, assertIsolatedOk } from '@stacksjs/testing/isolated'
import { channelAction } from '../../app/Actions/Support/ChannelAction'
import { one, query } from '../../app/Support/database'
import { createChannelReply, dispatchChannelDelivery, applyChannelInbound, retainChannelInbound, pollDiscordChannel, recoverChannelWork, deliveryView } from '../../app/Support/managed-channels'
import { configureBillingGateway, configureWalletLimits, createWalletCheckout, receivePayment } from '../../app/Support/billing'
import { channelOptedOut, recordChannelConsent } from '../../app/Support/channel-consent'
import { loadChannel, saveChannel } from '../../app/Support/channels'
import { agentProject } from '../../app/Support/service'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVgAAAABJRU5ErkJggg==', 'base64')
let applicationOrigin = '', providerMediaGets = 0, lastMediaUrl = '', inboundMediaUrlOverride = '', providerMediaDownloads = 0
let rotateSlack: (() => Promise<void>) | undefined
let providerPosts = 0, failure: 'unknown' | 'rejected' | undefined, smsCallback = '', whatsappCallback = ''
const accountSid = `AC${'a'.repeat(32)}`, numberSid = `PN${'b'.repeat(32)}`, senderSid = `XE${'c'.repeat(32)}`, contentSid = `HX${'d'.repeat(32)}`, authToken = 'channel-fixture-secret'
process.env.SUPPORT_MESSAGING_PRICING = JSON.stringify({ [accountSid]: { smsMaxMicrosPerSegment: 20000, mmsMaxMicros: 100000, whatsappMaxMicros: 100000 } })
const messages = new Map<string, Record<string, unknown>>()
const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
  const original = new URL(request.headers.get('x-provider-url')!)
  const auth = request.headers.get('authorization')
  if (original.hostname.includes('twilio.com')) {
    assert.equal(auth, `Basic ${btoa(`${accountSid}:${authToken}`)}`)
    if (original.pathname.includes('/Media/')) { providerMediaDownloads++; return new Response(image, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(image.length) } }) }
    if (original.pathname.includes('/IncomingPhoneNumbers')) return Response.json({ incoming_phone_numbers: [{ sid: numberSid, phone_number: '+14155550100', sms_url: smsCallback, sms_method: 'POST', sms_application_sid: null }] })
    if (original.pathname.includes('/Channels/Senders/')) return Response.json({ sid: senderSid, sender_id: 'whatsapp:+14155550100', status: 'ONLINE', webhook: { callback_url: whatsappCallback } })
    if (original.pathname.includes('/ApprovalRequests')) return Response.json({ sid: contentSid, account_sid: accountSid, whatsapp: { status: 'approved', category: 'UTILITY' } })
    if (request.method === 'POST' && original.pathname.endsWith('/Messages.json')) {
      providerPosts++
      const fields = new URLSearchParams(await request.text())
      const mediaUrl = fields.get('MediaUrl')
      if (mediaUrl) {
        lastMediaUrl = mediaUrl
        const parsed = new URL(mediaUrl)
        assert.equal(parsed.origin, 'https://support.example.test')
        for (const method of ['HEAD', 'GET']) {
          const response = await fetch(applicationOrigin + parsed.pathname + parsed.search, { method })
          assert.equal(response.status, 200)
          assert.equal(response.headers.get('content-type'), 'image/png')
          assert.equal(Number(response.headers.get('content-length')), image.length)
          if (method === 'GET') assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
          providerMediaGets++
        }
      }
      const sid = 'SM' + providerPosts.toString(16).padStart(32, '0')
      const message = { sid, from: fields.get('From'), to: fields.get('To'), body: fields.get('Body') || '', status: 'queued', date_created: new Date().toUTCString(), price: null, price_unit: 'USD' }
      messages.set(sid, message)
      if (failure === 'unknown') { failure = undefined; return new Response(null, { status: 503 }) }
      if (failure === 'rejected') { failure = undefined; return Response.json({ code: 21610, message: 'Rejected' }, { status: 400 }) }
      return Response.json(message, { status: 201 })
    }
    const sid = /\/(SM[a-f0-9]{32})\.json$/.exec(original.pathname)?.[1]
    return sid && messages.has(sid) ? Response.json(messages.get(sid)) : Response.json({}, { status: 404 })
  }
  if (original.hostname === 'slack.com') {
    assert.equal(auth, 'Bearer tenant-slack')
    if (original.pathname.endsWith('/auth.test')) { if (rotateSlack) { const rotate = rotateSlack; rotateSlack = undefined; await rotate() } return Response.json({ ok: true, team_id: 'Tfixture', bot_id: 'Bfixture' }) }
    if (original.pathname.endsWith('/conversations.info')) return Response.json({ ok: true, channel: { id: 'Cfixture', is_member: true, is_archived: false } })
    if (original.pathname.endsWith('/chat.postMessage')) { providerPosts++; return Response.json({ ok: true, ts: `${Date.now()}.1` }) }
  }
  if (original.hostname === 'discord.com') {
    assert.equal(auth, 'Bot tenant-discord')
    if (original.pathname.endsWith('/users/@me')) return Response.json({ id: '123', bot: true })
    if (original.pathname === '/api/v10/channels/456') return Response.json({ id: '456', type: 0, last_message_id: '100' })
    if (original.pathname.endsWith('/messages') && request.method === 'GET') return Response.json(original.searchParams.get('after') === '100' ? [{ id: '101', channel_id: '456', type: 0, content: 'Discord customer', timestamp: new Date().toISOString(), edited_timestamp: null, author: { id: '789', username: 'Customer' }, attachments: [] }, { id: '102', channel_id: '456', type: 0, content: 'Own bot echo', timestamp: new Date().toISOString(), edited_timestamp: null, author: { id: '123', username: 'Bot', bot: true }, attachments: [] }] : [])
  }
  return Response.json({}, { status: 404 })
} })
const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers); headers.set('x-provider-url', String(input))
  return await fetch(`http://127.0.0.1:${provider.port}/provider`, { ...init, headers })
}) as typeof fetch
const dependencies = { fetch: transport, mediaFetch: transport }
for (const [suffix, operation, method] of [['channels', 'list', 'GET'], ['channels', 'save', 'POST'], ['channels/{channel}/verify', 'verify', 'POST'], ['channels/{channel}/poll', 'poll', 'POST'], ['channel-deliveries/{delivery}/reconcile', 'reconcile', 'POST']] as const) route[method === 'GET' ? 'get' : 'post'](`/api/_channels/projects/{project}/${suffix}`, channelAction(operation, method, dependencies)).middleware('auth')
route.post('/api/_channels/{channel}/incoming', channelAction('incoming', 'POST', dependencies)).skipCsrf()
route.post('/api/_channels/{channel}/deliveries/{delivery}/status', channelAction('status', 'POST', dependencies)).skipCsrf()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
applicationOrigin = `http://127.0.0.1:${server.port}`
let csrf = '', cookie = '', checks = 0
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) })
  const raw = await response.text(); let data: any
  try { data = JSON.parse(raw) } catch { data = raw }
  return { status: response.status, data, headers: response.headers }
}
async function inbound(channel: any, body: string, sid: string, sender = '+14155550101', media = false) {
  const from = channel.provider === 'whatsapp' ? `whatsapp:${sender}` : sender, to = channel.provider === 'whatsapp' ? 'whatsapp:+14155550100' : '+14155550100'
  messages.set(sid, { sid, from, to, body, status: 'received', date_created: new Date().toUTCString() })
  const form = new URLSearchParams({ AccountSid: accountSid, MessageSid: sid, From: from, To: to, Body: body, NumMedia: media ? '1' : '0', ...(media ? { MediaUrl0: inboundMediaUrlOverride || `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages/${sid}/Media/ME${'3'.repeat(32)}`, MediaContentType0: 'image/png' } : {}) })
  let signed = `https://support.example.test/api/channels/${channel.publicId}/incoming`
  for (const key of [...form.keys()].sort()) signed += key + form.get(key)
  return await http(`/_channels/${channel.publicId}/incoming`, 'POST', form.toString(), undefined, { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': createHmac('sha1', authToken).update(signed).digest('base64') })
}
async function processLastInbound() { const row = await one("SELECT * FROM support_inbound WHERE provider LIKE 'channel:%' ORDER BY id DESC LIMIT 1"); assert.ok(row); return await applyChannelInbound(row.id, dependencies) }
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  await http('/register', 'POST', { name: 'Channel Owner', email: 'channels@example.test', password: 'ChannelFixture2026!', password_confirmation: 'ChannelFixture2026!' })
  const login = await http('/login', 'POST', { email: 'channels@example.test', password: 'ChannelFixture2026!' }), token = login.data.access_token
  assert.equal(typeof token, 'string')
  const owner = await one("SELECT id FROM users WHERE email = 'channels@example.test'"); assert.ok(owner)
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Channel A' }, token)).data.workspace
  const created = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'A app' }, token)).data.project
  const project = await agentProject(Number(owner.id), created.public_id)
  const scope = `/_channels/projects/${project.public_id}`
  check((await http(`${scope}/channels`)).status === 401, 'native authentication protects credentials')
  const saved = await http(`${scope}/channels`, 'POST', { provider: 'sms', configuration: { accountSid, authToken, fromNumber: '+14155550100', phoneNumberSid: numberSid, country: 'US' } }, token)
  check(saved.status === 201 && saved.data.channel.status === 'pending', 'saving credentials never fabricates readiness')
  const sms = saved.data.channel
  check(!JSON.stringify(saved.data).includes(authToken), 'HTTP channel views redact credentials')
  const encrypted = (await one('SELECT configuration FROM support_channels WHERE id = ?', [sms.id]))!.configuration
  check(!String(encrypted).includes(authToken), 'native encrypted credentials are opaque at rest')
  check((await http(`${scope}/channels/${sms.id}/verify`, 'POST', {}, token)).status === 409, 'missing provider routing prevents readiness')
  smsCallback = `https://support.example.test/api/channels/${sms.publicId}/incoming`
  check((await http(`${scope}/channels/${sms.id}/verify`, 'POST', {}, token)).status === 200, 'owned exact number and native routing probe qualify connection')
  const incomingSid = `SM${'e'.repeat(32)}`
  check((await inbound(sms, 'First SMS', incomingSid)).status === 200, 'signed account-bound inbound is accepted')
  check((await processLastInbound()).processed, 'durable inbound creates real contact and conversation')
  await inbound(sms, 'First SMS', incomingSid); await processLastInbound()
  check(Number((await one('SELECT COUNT(*) AS count FROM support_channel_threads WHERE project_id = ?', [project.id]))!.count) === 1, 'provider retries deduplicate the thread')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ?', [project.id]))!.count) === 1, 'inbound restart does not duplicate the original message')
  const thread = (await one('SELECT * FROM support_channel_threads WHERE channel_id = ?', [sms.id]))!
  await assert.rejects(createChannelReply(project, thread.conversation_id, { body: 'Reply', idempotencyKey: 'no-credit' }, Number(owner.id), dependencies), /credit/)
  let checkoutId = ''
  configureBillingGateway({ async checkout(input) { checkoutId = input.checkoutId; return { id: 'cs_channel_fixture', url: 'https://checkout.stripe.com/channel-fixture' } }, async event() { return { id: 'evt_channel_fixture', type: 'checkout.session.completed', object: { id: 'cs_channel_fixture', payment_status: 'paid', amount_total: 2000, currency: 'usd', payment_intent: 'pi_channel_fixture', client_reference_id: String(workspace.id), metadata: { service: 'supporthq', checkout_id: checkoutId } } } } })
  await createWalletCheckout(Number(owner.id), Number(workspace.id), { amountCents: 2000, idempotencyKey: 'channel-wallet-fixture' }); await receivePayment('fixture', 'external-provider-seam')
  await configureWalletLimits(Number(owner.id), Number(workspace.id), { dailyLimitCents: 1000, monthlyLimitCents: 2000 })
  const sent = await createChannelReply(project, thread.conversation_id, { body: 'Reply', idempotencyKey: 'reply-1' }, Number(owner.id), dependencies)
  const delivery = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [sent.delivery!.id]))!
  check((await dispatchChannelDelivery(Number(delivery.id), dependencies)).outcome === 'accepted', 'real HTTP native SMS request returns provider acceptance')
  const current = (await one('SELECT * FROM support_channel_deliveries WHERE id = ?', [delivery.id]))!
  check(current.status === 'cost_pending', 'missing provider price holds reservation without fabricated cost')
  messages.get(String(current.provider_message_id))!.price = '-0.007900'; messages.get(String(current.provider_message_id))!.status = 'delivered'
  const reconciled = await http(`${scope}/channel-deliveries/${delivery.public_id}/reconcile`, 'POST', {}, token)
  check(reconciled.status === 200 && reconciled.data.delivery.status === 'delivered', 'provider delivery and cost settle through native wallet')
  const reservation = (await one('SELECT * FROM support_wallet_reservations WHERE public_id = ?', [current.wallet_reservation_id]))!
  check(Number(reservation.provider_cost_micros) === 7900 && Number(reservation.actual_cents) === 1, 'fractional provider cost gets markup and cents rounding exactly once')
  const beforePosts = providerPosts
  await createChannelReply(project, thread.conversation_id, { body: 'Reply', idempotencyKey: 'reply-1' }, Number(owner.id), dependencies); await dispatchChannelDelivery(Number(delivery.id), dependencies)
  check(providerPosts === beforePosts, 'same operation and job replay never repeats accepted provider creation')
  await assert.rejects(createChannelReply(project, thread.conversation_id, { body: 'Changed', idempotencyKey: 'reply-1' }, Number(owner.id), dependencies), /changed/)
  const uncertain = await createChannelReply(project, thread.conversation_id, { body: 'Lost acknowledgement', idempotencyKey: 'reply-unknown' }, Number(owner.id), dependencies)
  const uncertainRow = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [uncertain.delivery!.id]))!
  failure = 'unknown'; await dispatchChannelDelivery(Number(uncertainRow.id), dependencies)
  check((await one('SELECT status FROM support_channel_deliveries WHERE id = ?', [uncertainRow.id]))!.status === 'unknown', '503 after provider acceptance remains unknown')
  const oncePosts = providerPosts; await dispatchChannelDelivery(Number(uncertainRow.id), dependencies); await recoverChannelWork(dependencies)
  check(providerPosts === oncePosts, 'recovery never blindly repeats an uncertain provider send')
  const unknownSid = 'SM' + oncePosts.toString(16).padStart(32, '0')
  messages.get(unknownSid)!.price = '-0.010000'; messages.get(unknownSid)!.status = 'delivered'
  const callback = new URLSearchParams({ AccountSid: accountSid, MessageSid: unknownSid, MessageStatus: 'delivered' })
  let callbackSigned = `https://support.example.test/api/channels/${sms.publicId}/deliveries/${uncertainRow.public_id}/status`
  for (const key of [...callback.keys()].sort()) callbackSigned += key + callback.get(key)
  const callbackSignature = createHmac('sha1', authToken).update(callbackSigned).digest('base64')
  check((await http(`/_channels/${sms.publicId}/deliveries/${uncertainRow.public_id}/status`, 'POST', callback.toString(), undefined, { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': callbackSignature })).status === 200, 'signed callback binds a lost acknowledgement to its exact persisted operation')
  check((await one('SELECT status FROM support_channel_deliveries WHERE id = ?', [uncertainRow.id]))!.status === 'delivered', 'unknown send reconciles without a duplicate provider creation')
  const rejected = await createChannelReply(project, thread.conversation_id, { body: 'Definitive rejection', idempotencyKey: 'reply-rejected' }, Number(owner.id), dependencies)
  const rejectedRow = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [rejected.delivery!.id]))!
  failure = 'rejected'; await dispatchChannelDelivery(Number(rejectedRow.id), dependencies)
  check((await one('SELECT status FROM support_wallet_reservations WHERE public_id = ?', [rejectedRow.wallet_reservation_id]))!.status === 'released', 'definitive provider rejection releases the reservation exactly once')
  const crashed = await createChannelReply(project, thread.conversation_id, { body: 'Worker restart', idempotencyKey: 'reply-crash' }, Number(owner.id), dependencies)
  const crashedRow = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [crashed.delivery!.id]))!
  await query("UPDATE support_channel_deliveries SET status = 'dispatching', lease_until = ? WHERE id = ?", [Date.now() - 1, crashedRow.id])
  const restartPosts = providerPosts
  assertIsolatedOk(await runIsolated('tests/fixtures/channel-recover.ts', { args: [String(crashedRow.id)], envFile: false, preload: [], timeoutMs: 30000 }), 'PASS channel restart')
  check(providerPosts === restartPosts, 'fresh process conservatively holds an expired dispatch lease without HTTP')
  const mediaFile = (await upload(project, thread.conversation_id, new File([image], 'customer-image.png', { type: 'image/png' }), 'outbound-image-fixture')).attachment
  const mediaReply = await createChannelReply(project, thread.conversation_id, { body: '', attachmentIds: [mediaFile.id], idempotencyKey: 'reply-private-image' }, Number(owner.id), dependencies)
  const mediaDelivery = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [mediaReply.delivery!.id]))!
  check((await dispatchChannelDelivery(Number(mediaDelivery.id), dependencies)).outcome === 'accepted' && providerMediaGets === 2, 'native provider GET and HEAD fetch a scoped signed private image')
  const mediaUrl = new URL(lastMediaUrl)
  check((await fetch(applicationOrigin + mediaUrl.pathname)).status === 403, 'private provider media requires its exact capability')
  const expired = createSignedStorageToken(`channel-media/${mediaDelivery.public_id}/${mediaFile.id}`, { expiresIn: new Date(Date.now() - 1000), issuer: 'hq-support-provider-media' })
  check((await fetch(applicationOrigin + mediaUrl.pathname + '?token=' + encodeURIComponent(expired))).status === 403, 'expired provider image URLs are refused')
  check((await fetch(applicationOrigin + mediaUrl.pathname.replace(/\/\d+$/, '/9999999') + mediaUrl.search)).status === 403, 'media tokens cannot be replayed against another attachment')
  const mediaBeforeMessages = Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ?', [thread.conversation_id]))!.count)
  const mediaInboundSid = `SM${'4'.repeat(32)}`
  await inbound(sms, '', mediaInboundSid, '+14155550101', true)
  check((await processLastInbound()).processed, 'real provider media-only inbound is stored privately without invented transcript text')
  const sourceMedia = (await one("SELECT * FROM support_inbound WHERE provider_event_id = ?", [mediaInboundSid]))!
  const chargedStorage = Number((await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspace.id]))!.storage_bytes)
  await query("UPDATE support_inbound SET status = 'pending', lease_until = 0, available_at = 0 WHERE id = ?", [sourceMedia.id])
  check((await applyChannelInbound(sourceMedia.id, dependencies)).processed, 'media checkpoint replay resumes through native source idempotency')
  check(Number((await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspace.id]))!.storage_bytes) === chargedStorage, 'provider media recovery never double-charges storage')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ?', [thread.conversation_id]))!.count) === mediaBeforeMessages + 1, 'provider media replay never duplicates the customer message')
  const badImage = (await upload(project, thread.conversation_id, new File(['<script>not an image</script>'], 'spoofed.png', { type: 'image/png' }), 'spoofed-image-fixture')).attachment
  await assert.rejects(createChannelReply(project, thread.conversation_id, { body: '', attachmentIds: [badImage.id], idempotencyKey: 'spoofed-image-send' }, Number(owner.id), dependencies), /bytes must match/)
  const fetchesBefore = providerMediaDownloads
  inboundMediaUrlOverride = 'http://127.0.0.1:5432/private'; const privateMediaSid = `SM${'5'.repeat(32)}`
  await inbound(sms, '', privateMediaSid, '+14155550101', true)
  check(!(await processLastInbound()).processed && providerMediaDownloads === fetchesBefore, 'private or off-provider source URLs never reach the external fetch transport')
  check(String((await one('SELECT payload FROM support_inbound WHERE provider_event_id = ?', [privateMediaSid]))!.payload).includes(inboundMediaUrlOverride), 'refused provider media remains in durable provenance for review')
  inboundMediaUrlOverride = ''
  const stoppedSid = `SM${'f'.repeat(32)}`
  await inbound(sms, 'STOP', stoppedSid)
  check(await channelOptedOut(await loadChannel(project, sms.id), '+14155550101'), 'signed STOP persists before conversation admission')
  await assert.rejects(createChannelReply(project, thread.conversation_id, { body: 'Blocked', idempotencyKey: 'after-stop' }, Number(owner.id), dependencies), /opted out/)
  const secondWorkspace = (await http('/support/workspaces', 'POST', { name: 'Channel B' }, token)).data.workspace
  const secondCreated = (await http(`/support/workspaces/${secondWorkspace.id}/projects`, 'POST', { name: 'B app' }, token)).data.project
  const secondProject = await agentProject(Number(owner.id), secondCreated.public_id)
  const secondChannel = await saveChannel(secondProject, { provider: 'sms', configuration: { accountSid, authToken, fromNumber: '+14155550102', phoneNumberSid: numberSid, country: 'US' } }, Number(owner.id))
  check(!await channelOptedOut(secondChannel, '+14155550101'), 'workspace A STOP does not leak into workspace B')
  await recordChannelConsent(project, await loadChannel(project, sms.id), '+14155550101', 'start', 'stale-start', Date.now() - 86400000)
  check(await channelOptedOut(await loadChannel(project, sms.id), '+14155550101'), 'stale START cannot undo a newer STOP')
  check((await http(`/_channels/projects/${secondProject.public_id}/channels/${sms.id}/verify`, 'POST', {}, token)).status === 404, 'channel IDs cannot cross projects')
  const rawBefore = Number((await one('SELECT COUNT(*) AS count FROM support_inbound'))!.count)
  check((await http(`/_channels/${sms.publicId}/incoming`, 'POST', 'AccountSid=wrong', undefined, { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bad' })).status === 401, 'invalid signature is refused')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_inbound'))!.count) === rawBefore, 'unauthenticated input never reaches durable source records')
  const whatsappSaved = await http(`${scope}/channels`, 'POST', { provider: 'whatsapp', configuration: { transport: 'twilio', accountSid, authToken, fromNumber: 'whatsapp:+14155550100', senderSid } }, token), whatsapp = whatsappSaved.data.channel
  whatsappCallback = `https://support.example.test/api/channels/${whatsapp.publicId}/incoming`
  check((await http(`${scope}/channels/${whatsapp.id}/verify`, 'POST', {}, token)).status === 200, 'WhatsApp uses exact ONLINE Twilio sender and configured webhook')
  await inbound(whatsapp, 'WhatsApp customer', `SM${'1'.repeat(32)}`); await processLastInbound()
  const waThread = (await one('SELECT * FROM support_channel_threads WHERE channel_id = ?', [whatsapp.id]))!
  await query('UPDATE support_channel_threads SET last_inbound_at = ? WHERE id = ?', [Date.now() - 86400001, waThread.id])
  await assert.rejects(createChannelReply(project, waThread.conversation_id, { body: 'Window closed', idempotencyKey: 'wa-window' }, Number(owner.id), dependencies), /template/)
  const template = await createChannelReply(project, waThread.conversation_id, { body: 'Approved local rendering', contentSid, contentVariables: { 1: 'Chris' }, idempotencyKey: 'wa-template' }, Number(owner.id), dependencies)
  check(template.delivery!.status === 'pending', 'fresh provider template approval admits an out-of-window send')
  const slackSaved = await http(`${scope}/channels`, 'POST', { provider: 'slack', configuration: { botToken: 'tenant-slack', signingSecret: 'slack-signing', teamId: 'Tfixture', channelId: 'Cfixture' } }, token), slack = slackSaved.data.channel
  check((await http(`${scope}/channels/${slack.id}/verify`, 'POST', {}, token)).status === 200, 'native Slack probes exact team membership and room')
  const slackEvent = JSON.stringify({ type: 'event_callback', team_id: 'Tfixture', event_id: 'Evfixture', event: { type: 'message', channel: 'Cfixture', user: 'Ucustomer', text: 'Slack customer', ts: String(Date.now() / 1000) } }), timestamp = String(Math.floor(Date.now() / 1000))
  check((await http(`/_channels/${slack.publicId}/incoming`, 'POST', slackEvent, undefined, { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': 'v0=' + createHmac('sha256', 'slack-signing').update(`v0:${timestamp}:${slackEvent}`).digest('hex') })).status === 200, 'signed Slack event is retained')
  await processLastInbound()
  const discordSaved = await http(`${scope}/channels`, 'POST', { provider: 'discord', configuration: { botToken: 'tenant-discord', channelId: '456' } }, token), discord = discordSaved.data.channel
  check((await http(`${scope}/channels/${discord.id}/verify`, 'POST', {}, token)).status === 200, 'native bot identity and room probe establish Discord watermark')
  check((await pollDiscordChannel(project, discord.id, dependencies)).retained === 1, 'native Discord poll retains customer traffic and ignores own bot echo')
  await processLastInbound()
  check((await pollDiscordChannel(project, discord.id, dependencies)).retained === 0, 'durable Discord cursor resumes after retained page')
  const meter = (await one("SELECT * FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id]))!
  const priorUsed = Number(meter.used)
  await query('UPDATE support_usage SET used = 120 WHERE id = ?', [meter.id])
  check((await inbound(sms, 'Must survive allowance overflow', `SM${'2'.repeat(32)}`, '+14155550103')).status === 200, 'signed inbound persists before an exhausted conversation allowance')
  check(!(await processLastInbound()).processed, 'overflow processing waits without fabricating a conversation')
  const overflow = (await one("SELECT * FROM support_inbound WHERE provider = ? ORDER BY id DESC LIMIT 1", [`channel:${sms.id}`]))!
  check(overflow.status === 'pending' && String(overflow.payload).includes('Must survive allowance overflow'), 'complete overflow payload remains durable')
  await query('UPDATE support_usage SET used = ? WHERE id = ?', [priorUsed, meter.id]); await query('UPDATE support_inbound SET available_at = 0 WHERE id = ?', [overflow.id])
  check((await applyChannelInbound(overflow.id)).processed, 'retained overflow resumes when allowance becomes available')
  const historical = (await one('SELECT * FROM support_channel_threads WHERE channel_id = ? AND recipient = ?', [sms.id, '+14155550103']))!
  const historicalImage = (await upload(project, historical.conversation_id, new File([image], 'historical.png', { type: 'image/png' }), 'historical-before-rollover')).attachment
  const delayedReply = await createChannelReply(project, historical.conversation_id, { body: 'Queued before customer continuation', attachmentIds: [historicalImage.id], idempotencyKey: 'historical-delivery-before-rollover' }, Number(owner.id), dependencies)
  await query("UPDATE support_conversations SET status = 'closed', resolved_at = ? WHERE id = ?", [Date.now() - 7 * 86400000 - 1000, historical.conversation_id])
  const continuedSms = `SM${'6'.repeat(32)}`
  await inbound(sms, '', continuedSms, '+14155550103', true)
  check((await processLastInbound()).processed, 'signed late SMS media ingress admits a linked request before private ingestion')
  const advanced = (await one('SELECT * FROM support_channel_threads WHERE id = ?', [historical.id]))!
  check(String(advanced.conversation_id) !== String(historical.conversation_id) && String((await one('SELECT continued_from_id FROM support_conversations WHERE id = ?', [advanced.conversation_id]))!.continued_from_id) === String(historical.conversation_id), 'SMS provider thread advances to its scoped successor and preserves request lineage')
  check(Number((await one("SELECT COUNT(*) AS count FROM support_attachments WHERE conversation_id = ? AND status = 'stored' AND contact_id = ?", [advanced.conversation_id, advanced.contact_id]))!.count) === 1, 'late inbound private media belongs to the new request and its exact customer')
  const delayed = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [delayedReply.delivery!.id]))!, getsBeforeDelayed = providerMediaGets
  check((await dispatchChannelDelivery(Number(delayed.id), dependencies)).outcome === 'accepted' && providerMediaGets === getsBeforeDelayed + 2, 'queued historical send and provider image capability still target the original message after inbound rollover')
  check(Number((await one("SELECT COUNT(*) AS count FROM support_channel_conversations WHERE thread_id = ?", [historical.id]))!.count) === 2, 'historical provider bindings retain both original and current request')
  const lateReplay = (await one('SELECT id FROM support_inbound WHERE provider_event_id = ?', [continuedSms]))!
  await query("UPDATE support_inbound SET status = 'pending', available_at = 0, lease_until = 0 WHERE id = ?", [lateReplay.id])
  const meterBeforeReplay = Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id]))!.used)
  check((await applyChannelInbound(lateReplay.id, dependencies)).processed && Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id]))!.used) === meterBeforeReplay, 'retained late media recovery replays its original destination without a second conversation unit')
  await query("UPDATE support_conversations SET status = 'snoozed', resolved_at = 0 WHERE id = ?", [waThread.conversation_id])
  await inbound(whatsapp, 'Resume snoozed WhatsApp', `SM${'7'.repeat(32)}`); await processLastInbound()
  check((await one('SELECT status FROM support_conversations WHERE id = ?', [waThread.conversation_id]))!.status === 'open', 'signed WhatsApp customer ingress resumes a snoozed request')
  for (const connection of [slack, discord]) {
    const retained = (await one('SELECT payload FROM support_inbound WHERE provider = ? ORDER BY id ASC LIMIT 1', [`channel:${connection.id}`]))!
    const normalized = JSON.parse(String(retained.payload)).normalized
    const previous = (await one('SELECT * FROM support_channel_threads WHERE channel_id = ? AND remote_key = ?', [connection.id, normalized.remoteKey]))!
    await query("UPDATE support_conversations SET status = 'closed', resolved_at = ? WHERE id = ?", [Date.now() - 7 * 86400000 - 1000, previous.conversation_id])
    const event = await retainChannelInbound(project, await loadChannel(project, connection.id), `reopen-${connection.id}`, { ...normalized, body: 'Provider-normalized late continuation', timestamp: Date.now() }, { fixture: 'verified-provider-normalization' })
    check((await applyChannelInbound(event.id, dependencies)).processed && String((await one('SELECT conversation_id FROM support_channel_threads WHERE id = ?', [previous.id]))!.conversation_id) !== String(previous.conversation_id), `${connection.provider} normalized customer ingress uses the shared late-request admission`)
  }
  const delayedCurrent = (await one('SELECT * FROM support_channel_threads WHERE id = ?', [historical.id]))!
  await query("UPDATE support_conversations SET status = 'closed', resolved_at = ? WHERE id = ?", [Date.now() - 8 * 86400000, delayedCurrent.conversation_id])
  const delayedSid = `SM${'8'.repeat(32)}`
  await inbound(sms, 'Accepted within the reopen window, processed after outage', delayedSid, '+14155550103')
  const delayedInbound = (await one('SELECT id FROM support_inbound WHERE provider_event_id = ?', [delayedSid]))!
  await query('UPDATE support_inbound SET created_at = ? WHERE id = ?', [new Date(Date.now() - 2 * 86400000).toISOString(), delayedInbound.id])
  const delayedMeter = Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id]))!.used)
  check((await applyChannelInbound(delayedInbound.id, dependencies)).processed && String((await one('SELECT conversation_id FROM support_channel_threads WHERE id = ?', [historical.id]))!.conversation_id) === String(delayedCurrent.conversation_id) && Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [workspace.id]))!.used) === delayedMeter, 'verified event accepted inside seven days resumes its admission even when outage processing happens later')
  const futureSid = `SM${'9'.repeat(32)}`
  await inbound(sms, 'Invalid future server receipt time remains recoverable', futureSid, '+14155550103')
  const futureInbound = (await one('SELECT id FROM support_inbound WHERE provider_event_id = ?', [futureSid]))!
  await query('UPDATE support_inbound SET created_at = ? WHERE id = ?', [new Date(Date.now() + 86400000).toISOString(), futureInbound.id])
  const messagesBeforeFuture = Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ?', [project.id]))!.count)
  check(!(await applyChannelInbound(futureInbound.id, dependencies)).processed && Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ?', [project.id]))!.count) === messagesBeforeFuture && (await one('SELECT status FROM support_inbound WHERE id = ?', [futureInbound.id]))!.status === 'pending', 'future internal acceptance time creates no customer message and keeps the verified source recoverable')
  const admissionThread = (await one('SELECT * FROM support_channel_threads WHERE id = ?', [historical.id]))!
  await query("UPDATE support_conversations SET status = 'closed', resolved_at = ? WHERE id = ?", [Date.now() - 70 * 86400000, admissionThread.conversation_id])
  const priorMonth = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 7)
  const priorMonthUsed = Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND period = ? AND meter = 'conversations'", [workspace.id, priorMonth]))?.used || 0)
  const monthSid = `SM${'a'.repeat(32)}`
  await inbound(sms, 'Retained old-month event admitted in current UTC month', monthSid, '+14155550103')
  const monthInbound = (await one('SELECT id FROM support_inbound WHERE provider_event_id = ?', [monthSid]))!
  await query('UPDATE support_inbound SET created_at = ? WHERE id = ?', [new Date(Date.now() - 35 * 86400000).toISOString(), monthInbound.id])
  check((await applyChannelInbound(monthInbound.id, dependencies)).processed && Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations' AND period = ?", [workspace.id, new Date().toISOString().slice(0, 7)]))!.used) === delayedMeter + 1 && Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND period = ? AND meter = 'conversations'", [workspace.id, priorMonth]))?.used || 0) === priorMonthUsed, 'new conversation usage belongs to actual current UTC admission month rather than retained-event month')
  rotateSlack = async () => { await saveChannel(project, { id: slack.id, provider: 'slack', configuration: { botToken: 'tenant-slack', signingSecret: 'slack-signing', teamId: 'Tfixture', channelId: 'Cfixture' } }, Number(owner.id)) }
  check((await http(`${scope}/channels/${slack.id}/verify`, 'POST', {}, token)).status === 409, 'a provider probe cannot mark newly changed credentials ready')
  check((await loadChannel(project, slack.id)).status === 'pending', 'changed connection stays pending despite stale successful evidence')
  await saveChannel(project, { id: sms.id, provider: 'sms', configuration: { accountSid, authToken: 'rotated-new-token', fromNumber: '+14155550100', phoneNumberSid: numberSid, country: 'US' } }, Number(owner.id))
  check((await http(`${scope}/channel-deliveries/${delivery.public_id}/reconcile`, 'POST', {}, token)).status === 200, 'encrypted original credential snapshot reconciles old operations after connection rotation')
  check(!JSON.stringify(deliveryView(current)).includes(authToken), 'delivery views never expose encrypted credential snapshots')
  console.log(`PASS managed channel HTTP (${checks} checks)`)
}
finally { configureBillingGateway(undefined); server.stop(true); provider.stop(true) }
