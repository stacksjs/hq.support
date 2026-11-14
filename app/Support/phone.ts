import type { Row } from './database'
import type { PhoneDependencies } from './phone-config'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { managedCostCents, managedCostFromMicros, reserveWallet, settleProviderWallet } from './billing'
import { contact, createConversation, digest, member, object } from './service'
import { channelByPublicId, channelConfig, loadChannel, markChannelReady, requireReadyChannel } from './channels'
import { callView, northAmericanNumber, phoneOrigin, phonePricing, phoneProvider, streamToken } from './phone-config'

const terminal = ['completed', 'busy', 'failed', 'no-answer', 'canceled']
export const terminalCall = (status: unknown) => terminal.includes(String(status))
export async function phoneCapabilities(project: Row) {
  const rows = await query("SELECT * FROM support_channels WHERE workspace_id = ? AND project_id = ? AND provider = 'twilio' ORDER BY id LIMIT 50", [project.workspace_id, project.id])
  const wallet = await one('SELECT wallet_cents, managed_daily_cap_cents, managed_monthly_cap_cents FROM support_workspaces WHERE id = ?', [project.workspace_id])
  const channels = []
  for (const row of rows) {
    let browserAvailable = false, aiAvailable = false, maximum: number | null = null, country: string | null = null, number: string | null = null, reason = 'channel_not_ready'
    if (row.status === 'ready' && Number(row.verified_at) > 0) {
      try {
        const credentials = await channelConfig(row), pricing = phonePricing(credentials)
        const provider = await phoneProvider(row, credentials)
        if (typeof provider.setCallTimeLimit !== 'function') fail(503, 'framework_upgrade_required', 'Upgrade the native telephony package.')
        maximum = pricing.maxDurationSeconds; country = String(credentials.country); number = northAmericanNumber(credentials.fromNumber).number
        browserAvailable = /^SK[a-f0-9]{32}$/i.test(String(credentials.apiKeySid)) && Boolean(credentials.apiKeySecret)
        let mediaReady = false
        try { const media = new URL(process.env.SUPPORT_VOICE_MEDIA_URL || ''); mediaReady = media.protocol === 'wss:' && media.pathname === '/' && !media.search && !media.username && !media.password } catch {}
        aiAvailable = Boolean(process.env.OPENAI_API_KEY && pricing.realtimeModel && mediaReady && Number(wallet?.wallet_cents) > 0 && Number(wallet?.managed_daily_cap_cents) > 0 && Number(wallet?.managed_monthly_cap_cents) > 0)
        reason = aiAvailable ? '' : 'voice_configuration_or_credit_required'
      }
      catch { reason = 'voice_configuration_unavailable' }
    }
    channels.push({ id: String(row.id), label: String(row.label), status: String(row.status), verifiedAt: Number(row.verified_at), browserAvailable, aiAvailable, maxDurationSeconds: maximum, country, number, ...(reason ? { reason } : {}) })
  }
  return { channels, supportedRegions: ['US', 'CA'], features: { inboundAi: true, outboundAi: true, browserIncoming: true, humanTakeover: true, outboundAgent: false, hold: false, voicemail: false, numberPurchase: false, recording: false } }
}
export async function phoneCall(project: Row, reference: string) {
  const row = await one('SELECT * FROM support_phone_calls WHERE public_id = ? AND project_id = ? AND workspace_id = ?', [reference, project.id, project.workspace_id])
  if (!row) fail(404, 'not_found', 'Phone call not found.')
  return row
}
export async function publicPhoneCall(reference: string) {
  const row = await one('SELECT * FROM support_phone_calls WHERE public_id = ?', [reference])
  if (!row) fail(404, 'not_found', 'Phone call not found.')
  return row
}
export async function phoneContext(call: Row) {
  const project = await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [call.project_id, call.workspace_id])
  if (!project) fail(404, 'not_found', 'Phone project not found.')
  const channel = await loadChannel(project, call.channel_id)
  if (channel.provider !== 'twilio') fail(503, 'phone_unavailable', 'This is not a Twilio voice channel.')
  return { project, channel, credentials: await channelConfig(channel) }
}
export async function verifyPhoneChannel(project: Row, reference: unknown, actorId: number, dependencies: PhoneDependencies = {}) {
  await member(actorId, Number(project.workspace_id), ['owner', 'admin'])
  const channel = await loadChannel(project, reference), credentials = await channelConfig(channel)
  if (channel.provider !== 'twilio') fail(422, 'unsupported_provider', 'Choose a Twilio voice channel.')
  const from = northAmericanNumber(credentials.fromNumber)
  if (credentials.country !== from.country) fail(422, 'number_country_mismatch', 'Phone number and verified country differ.')
  phonePricing(credentials)
  const adapter = await phoneProvider(channel, credentials, dependencies)
  if (typeof adapter.setCallTimeLimit !== 'function') fail(503, 'framework_upgrade_required', 'Upgrade native telephony before configuring paid voice.')
  const numbers = await (await phoneProvider(channel, credentials, dependencies)).listNumbers(from.number)
  const owned = numbers.find(number => number.phoneNumber === from.number && number.sid === credentials.phoneNumberSid)
  if (!owned) fail(403, 'number_not_owned', 'The provider account does not own this exact number.')
  // Dedicated callback routing is configured through a durable provider write.
  const configured = await (await phoneProvider(channel, credentials, dependencies)).configureNumber(owned.sid, `${phoneOrigin()}/api/phone/channels/${channel.public_id}/incoming`, { operationKey: `verify:${channel.public_id}:${digest(String(channel.updated_at)).slice(0, 16)}` })
  if (configured.sid !== owned.sid || configured.phoneNumber !== owned.phoneNumber || configured.voiceUrl !== `${phoneOrigin()}/api/phone/channels/${channel.public_id}/incoming` || configured.voiceMethod !== 'POST' || configured.voiceApplicationSid || configured.trunkSid) fail(503, 'phone_verification_uncertain', 'Provider routing could not be confirmed.')
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const current = await loadChannel(project, channel.id)
    if (current.configuration !== channel.configuration) fail(409, 'channel_changed', 'Channel credentials changed during verification.')
    return await markChannelReady(project, channel.id, { externalId: owned.sid, receipt: `owned:${owned.sid}`, expectedConfiguration: String(channel.configuration) })
  })
}
export async function prepareCall(project: Row, input: Row, actorId: number | null, options: { inboundSid?: string, from?: string } = {}) {
  const channel = await requireReadyChannel(project, identifier(input.channelId), 'twilio')
  const credentials = await channelConfig(channel), pricing = phonePricing(credentials)
  const destination = northAmericanNumber(options.inboundSid ? options.from : input.to)
  const owned = northAmericanNumber(credentials.fromNumber)
  if (credentials.country !== owned.country) fail(503, 'phone_unavailable', 'The voice channel country was not verified.')
  const maximum = input.maxDurationSeconds === undefined ? pricing.maxDurationSeconds : Number(input.maxDurationSeconds)
  if (!Number.isSafeInteger(maximum) || maximum < 30 || maximum > pricing.maxDurationSeconds) fail(422, 'invalid_duration', 'Choose a bounded call duration within the configured maximum.')
  const operation = text(input.idempotencyKey, 'idempotencyKey', 150)
  const mode = input.mode ?? 'ai'
  if (mode !== 'ai' && mode !== 'agent') fail(422, 'invalid_mode', 'Choose ai or agent call mode.')
  if (mode === 'agent') fail(503, 'agent_dial_unavailable', 'Agent outbound dialing is not yet available.')
  let media: URL
  try { media = new URL(process.env.SUPPORT_VOICE_MEDIA_URL || '') } catch { fail(503, 'voice_media_unavailable', 'The public voice media service must be configured before paid calls.') }
  if (media.protocol !== 'wss:' || media.pathname !== '/' || media.search || media.username || media.password) fail(503, 'voice_media_unavailable', 'The public voice media service must be a canonical wss origin.')
  if (!process.env.OPENAI_API_KEY || !pricing.realtimeModel || Object.keys(pricing.rates).length !== 6) fail(503, 'voice_ai_unavailable', 'Voice AI provider and exact usage pricing must be configured before paid calls.')
  const adapter = await phoneProvider(channel, credentials)
  if (typeof adapter.setCallTimeLimit !== 'function') fail(503, 'framework_upgrade_required', 'Upgrade native telephony before placing paid calls.')
  const fingerprint = digest(JSON.stringify({ channel: channel.id, credentials: digest(String(channel.configuration)), destination, maximum, mode, inboundSid: options.inboundSid ?? '' }))
  const row = await workspaceTransaction(Number(project.workspace_id), async () => {
    const currentChannel = await requireReadyChannel(project, channel.id, 'twilio')
    if (currentChannel.configuration !== channel.configuration) fail(409, 'channel_changed', 'Channel credentials changed during call preparation.')
    const previous = await one('SELECT * FROM support_phone_calls WHERE workspace_id = ? AND operation_key = ?', [project.workspace_id, operation])
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'This call key used different input.')
      return previous
    }
    if (!options.inboundSid && await one("SELECT id FROM support_phone_calls WHERE workspace_id = ? AND channel_id = ? AND to_number = ? AND direction = 'outbound' AND provider_state IN ('pending', 'uncertain')", [project.workspace_id, channel.id, destination.number])) fail(409, 'phone_write_uncertain', 'Reconcile the existing uncertain call to this destination before a new attempt.')
    const envelopeMinutes = Math.ceil((maximum + 30) / 60)
    const reserved = managedCostCents(envelopeMinutes * pricing.telephonyCeilingCentsPerMinute * 2)
    const aiReserved = managedCostCents(envelopeMinutes * pricing.aiCeilingCentsPerMinute)
    const now = new Date(), day = now.toISOString().slice(0, 10), month = now.toISOString().slice(0, 7)
    for (const [start, cap] of [[day, pricing.dailyCapCents], [month, pricing.monthlyCapCents]] as const) {
      const spent = Number((await one("SELECT COALESCE(SUM(reserved_cents + ai_reserved_cents), 0) AS total FROM support_phone_calls WHERE workspace_id = ? AND created_at >= ? AND provider_state != 'rejected'", [project.workspace_id, start + (start.length === 7 ? '-01' : '') + 'T00:00:00.000Z']))?.total)
      if (spent + reserved + aiReserved > cap) fail(402, 'phone_spending_cap', 'This call exceeds the daily or monthly phone spending ceiling.')
    }
    const publicId = crypto.randomUUID(), origin = phoneOrigin()
    const providerReservation = await reserveWallet(Number(project.workspace_id), `phone:${publicId}`, reserved, 'twilio-voice')
    const aiReservation = await reserveWallet(Number(project.workspace_id), `voice-ai:${publicId}`, aiReserved, 'openai-realtime')
    const person = await contact(project, { externalId: `phone:${destination.number}`, name: destination.number })
    const thread = await createConversation(project, { externalId: person.external_id }, { idempotencyKey: `phone:${publicId}`, subject: `Phone call ${destination.number}`, body: 'Phone call requested.' }, person)
    return await insert('support_phone_calls', {
      workspace_id: project.workspace_id, project_id: project.id, channel_id: channel.id, public_id: publicId, operation_key: operation, fingerprint, actor_id: actorId, contact_id: person.id, conversation_id: thread.conversation.id,
      provider_sid: options.inboundSid ?? null, direction: options.inboundSid ? 'inbound' : 'outbound', from_number: options.inboundSid ? destination.number : owned.number, to_number: options.inboundSid ? owned.number : destination.number, country: destination.country,
      mode, status: options.inboundSid ? 'ringing' : 'pending', provider_state: options.inboundSid ? 'succeeded' : 'pending', max_duration_seconds: maximum, reservation_id: providerReservation.public_id, ai_reservation_id: aiReservation.public_id,
      reserved_cents: reserved, ai_reserved_cents: aiReserved, stream_state: 'pending', stream_digest: digest(streamToken(String(credentials.authToken), publicId)), notice: String(credentials.recordingNotice || 'This call uses an AI assistant. Assistant responses are saved as text. Press 1 to consent, or hang up.'), callback_origin: origin,
    })
  })
  return { row, channel, credentials }
}
export async function createOutboundCall(project: Row, input: Row, actorId: number, dependencies: PhoneDependencies = {}) {
  const { row, channel, credentials } = await prepareCall(project, input, actorId)
  if (row.provider_sid && row.provider_state === 'succeeded') return { call: callView(row) }
  try {
    const created = await (await phoneProvider(channel, credentials, dependencies)).createCall({ from: String(row.from_number), to: String(row.to_number), url: `${row.callback_origin}/api/phone/calls/${row.public_id}/instructions`, statusCallback: `${row.callback_origin}/api/phone/calls/${row.public_id}/status`, timeLimitSeconds: Number(row.max_duration_seconds) + 30 }, { operationKey: `call:${row.public_id}:create` })
    if (created.from !== row.from_number || created.to !== row.to_number) fail(503, 'phone_write_uncertain', 'Provider call ownership could not be confirmed.')
    await workspaceTransaction(Number(row.workspace_id), async () => {
      const current = await publicPhoneCall(String(row.public_id))
      if (current.provider_sid && current.provider_sid !== created.sid) fail(409, 'phone_write_uncertain', 'Provider returned conflicting call identity.')
      await query('UPDATE support_phone_calls SET provider_sid = ?, provider_state = ?, status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [created.sid, 'succeeded', terminalCall(current.status) ? current.status : created.status, new Date().toISOString(), row.id, row.workspace_id])
    })
    return { call: callView(await publicPhoneCall(String(row.public_id))) }
  }
  catch (error) {
    const code = String(object(error).code || 'write_uncertain')
    if (['operation_pending', 'operation_conflict'].includes(code)) fail(409, code, 'This provider operation is pending or has conflicting input.')
    const rejected = ['authentication', 'not_found', 'rate_limited', 'rejected', 'validation'].includes(code)
    await workspaceTransaction(Number(row.workspace_id), async () => {
      await query("UPDATE support_phone_calls SET provider_state = ?, last_error = ? WHERE id = ? AND workspace_id = ? AND provider_state = 'pending'", [rejected ? 'rejected' : 'uncertain', rejected ? 'provider_rejected' : 'write_uncertain', row.id, row.workspace_id])
      if (rejected) {
        await settleProviderWallet(Number(row.workspace_id), String(row.reservation_id), 0, `rejected:${row.public_id}`)
        await settleProviderWallet(Number(row.workspace_id), String(row.ai_reservation_id), 0, `rejected:${row.public_id}`)
      }
    })
    fail(503, rejected ? 'provider_rejected' : 'phone_write_uncertain', rejected ? 'The provider rejected this call.' : 'Call outcome is uncertain. Reconcile this call before another attempt.')
  }
}
export async function endPhoneCall(project: Row, reference: string, dependencies: PhoneDependencies = {}) {
  const call = await phoneCall(project, reference)
  if (!terminalCall(call.status)) {
    if (!call.provider_sid) fail(409, 'phone_write_uncertain', 'Reconcile provider identity before ending the call.')
    const { channel, credentials } = await phoneContext(call)
    const ended = await (await phoneProvider(channel, credentials, dependencies)).endCall(String(call.provider_sid), ['queued', 'ringing', 'pending'].includes(String(call.status)) ? 'canceled' : 'completed', { operationKey: `end:${call.public_id}` })
    if (ended.sid !== call.provider_sid) fail(503, 'phone_write_uncertain', 'Provider call ownership could not be confirmed.')
    await query('UPDATE support_phone_calls SET status = ?, ended_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [ended.status, Date.now(), new Date().toISOString(), call.id, call.workspace_id])
  }
  return { call: callView(await publicPhoneCall(reference)) }
}
export async function takeOverPhoneCall(project: Row, reference: string, userId: number, dependencies: PhoneDependencies = {}) {
  await member(userId, Number(project.workspace_id))
  const call = await phoneCall(project, reference)
  if (!call.provider_sid || terminalCall(call.status) || Number(call.consent_at) <= 0 || Number(call.deadline_at) <= Date.now()) fail(409, 'call_ended', 'This call cannot be transferred.')
  await workspaceTransaction(Number(call.workspace_id), async () => {
    await member(userId, Number(call.workspace_id))
    const current = await publicPhoneCall(reference)
    const unusedAi = current.stream_state === 'pending'
    await query("UPDATE support_phone_calls SET assigned_agent_id = ?, mode = 'agent', transfer_at = ?, ai_cost_micros = ?, stream_state = ? WHERE id = ? AND workspace_id = ?", [userId, Date.now(), unusedAi ? 0 : current.ai_cost_micros, unusedAi ? 'handed-off' : current.stream_state, call.id, call.workspace_id])
  })
  const { channel, credentials } = await phoneContext(call)
  await (await phoneProvider(channel, credentials, dependencies)).redirectCall(String(call.provider_sid), { url: `${call.callback_origin}/api/phone/calls/${call.public_id}/agent` }, { operationKey: `takeover:${call.public_id}:${userId}` })
  return { call: callView(await publicPhoneCall(reference)) }
}
export async function browserPhoneToken(project: Row, channelId: unknown, userId: number) {
  await member(userId, Number(project.workspace_id))
  const channel = await requireReadyChannel(project, channelId, 'twilio'), credentials = await channelConfig(channel)
  if (!/^SK[a-f0-9]{32}$/i.test(String(credentials.apiKeySid)) || !credentials.apiKeySecret) fail(503, 'browser_phone_unavailable', 'The workspace browser phone API key is not configured.')
  const { default: twilio } = await import('twilio')
  const identity = `w${project.workspace_id}.p${project.id}.u${userId}`
  const token = new twilio.jwt.AccessToken(String(credentials.accountSid), String(credentials.apiKeySid), String(credentials.apiKeySecret), { identity, ttl: 300 })
  token.addGrant(new twilio.jwt.AccessToken.VoiceGrant({ incomingAllow: true }))
  return { token: token.toJwt(), identity, expiresAt: Date.now() + 300000, outboundEnabled: false }
}
export const voiceChargeCents = managedCostFromMicros
export async function reconcilePhoneCall(project: Row, reference: string, dependencies: PhoneDependencies = {}) {
  const call = await phoneCall(project, reference)
  if (!call.provider_sid) fail(409, 'phone_write_uncertain', 'Provider call identity requires operator reconciliation.')
  const { channel, credentials } = await phoneContext(call)
  const actual = await (await phoneProvider(channel, credentials, dependencies)).getCall(String(call.provider_sid))
  if (actual.sid !== call.provider_sid || actual.from !== call.from_number || actual.to !== call.to_number) fail(503, 'phone_write_uncertain', 'Provider call ownership could not be confirmed.')
  if (!terminalCall(actual.status) || actual.priceMicros == null || actual.priceCurrency !== 'USD' || actual.durationSeconds == null) return { call: callView(call), pending: true }
  let providerMicros = actual.priceMicros
  if (Number(call.transfer_at) > 0) {
    const events = await query("SELECT payload FROM support_phone_events WHERE workspace_id = ? AND call_id = ? AND status = 'dial-complete'", [call.workspace_id, call.id])
    const children = [...new Set(events.map(event => String(object(JSON.parse(String(event.payload))).childSid)))]
    if (!children.length || children.length > 20) return { call: callView(call), pending: true }
    for (const childSid of children) {
      const child = await (await phoneProvider(channel, credentials, dependencies)).getCall(childSid)
      if (child.sid !== childSid || child.parentSid !== call.provider_sid || !terminalCall(child.status) || child.priceMicros == null || child.priceCurrency !== 'USD') return { call: callView(call), pending: true }
      providerMicros += child.priceMicros
      if (!Number.isSafeInteger(providerMicros)) fail(503, 'phone_cost_unavailable', 'Provider call charge is outside the supported range.')
    }
  }
  return await workspaceTransaction(Number(call.workspace_id), async () => {
    const current = await publicPhoneCall(reference)
    await settleProviderWallet(Number(call.workspace_id), String(call.reservation_id), providerMicros, `twilio:${actual.sid}`)
    const aiCost = current.ai_cost_micros == null && Number(current.consent_at) <= 0 ? 0 : current.ai_cost_micros
    if (aiCost != null) await settleProviderWallet(Number(call.workspace_id), String(call.ai_reservation_id), Number(aiCost), `openai:${call.public_id}`)
    await query('UPDATE support_phone_calls SET status = ?, provider_cost_micros = ?, duration_seconds = ?, settled_at = ?, ended_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [actual.status, providerMicros, actual.durationSeconds, aiCost == null ? 0 : Date.now(), Number(current.ended_at) || Date.now(), new Date().toISOString(), current.id, current.workspace_id])
    return { call: callView(await publicPhoneCall(reference)), pending: aiCost == null }
  })
}
export async function inboundChannel(reference: string) {
  const channel = await channelByPublicId(reference)
  if (channel.provider !== 'twilio' || channel.status !== 'ready') fail(503, 'phone_unavailable', 'Voice channel is not ready.')
  const project = await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [channel.project_id, channel.workspace_id])
  if (!project) fail(404, 'not_found', 'Project not found.')
  return { channel, project, credentials: await channelConfig(channel) }
}
