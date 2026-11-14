import type { RequestInstance } from '@stacksjs/types'
import type { ChannelDependencies } from './channel-providers'
import type { Row } from './database'
import { verifyHmac } from '@stacksjs/security'
import { channelByPublicId, channelConfig } from './channels'
import { channelOrigin } from './channel-providers'
import { channelDelivery, deliveryCredentials, reconcileChannelDelivery, retainChannelInbound } from './managed-channels'
import { one, query, workspaceTransaction } from './database'
import { digest, object } from './service'
import { fail, text } from './errors'
import { receiveInbound } from './delivery'
import { recordChannelConsent } from './channel-consent'

async function rawBody(request: RequestInstance) {
  if (!request.rawBody) fail(400, 'raw_body_required', 'The original provider request is required.')
  const raw = await request.rawBody()
  if (Buffer.byteLength(raw) > 1_000_000) fail(413, 'provider_body_large', 'Provider event exceeds the durable bound.')
  return raw
}
async function context(reference: string) {
  const channel = await channelByPublicId(reference)
  const project = await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [channel.project_id, channel.workspace_id])
  if (!project) fail(404, 'project_not_found', 'Channel project not found.')
  return { channel, project }
}
function signedHmac(secret: unknown, payload: string, signature: string) {
  try { verifyHmac(text(secret, 'provider signing secret', 2000), payload, signature) }
  catch { fail(401, 'invalid_provider_signature', 'Provider signature authentication failed.') }
}
async function twilioAuthentication(request: RequestInstance, raw: string, channel: Row, config: Row, suffix: string) {
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) fail(415, 'provider_encoding', 'Twilio requires form encoding.')
  const form = new URLSearchParams(raw), fields = Object.fromEntries(form.entries())
  if ([...form.keys()].some(key => form.getAll(key).length !== 1)) fail(400, 'duplicate_provider_fields', 'Duplicate provider fields are not accepted.')
  const { verifyTwilioWebhook } = await import('@stacksjs/sms')
  if (fields.AccountSid !== config.accountSid || !verifyTwilioWebhook(`${channelOrigin()}/api/channels/${channel.public_id}/${suffix}`, fields, request.headers.get('x-twilio-signature') || '', String(config.authToken))) fail(401, 'invalid_provider_signature', 'Provider signature authentication failed.')
  return fields
}
export async function textChannelWebhook(request: RequestInstance, operation: 'incoming' | 'status' | 'challenge', dependencies: ChannelDependencies = {}) {
  const { channel, project } = await context(request.getParam('channel'))
  if (operation === 'status') {
    const delivery = await channelDelivery(project, request.getParam('delivery'))
    if (String(delivery.channel_id) !== String(channel.id)) fail(404, 'delivery_not_found', 'Channel delivery not found.')
    const config = await deliveryCredentials(delivery, channel), raw = await rawBody(request)
    if (!['sms', 'whatsapp'].includes(String(channel.provider))) fail(422, 'unsupported_callback', 'This provider uses its signed inbox event API.')
    const fields = await twilioAuthentication(request, raw, channel, config, `deliveries/${delivery.public_id}/status`)
    const sid = text(fields.MessageSid || fields.SmsSid, 'provider message SID', 100)
    if (!/^(SM|MM)[a-f0-9]{32}$/i.test(sid)) fail(422, 'invalid_message_sid', 'A provider message SID is required.')
    await workspaceTransaction(Number(project.workspace_id), async () => {
      const current = await channelDelivery(project, delivery.public_id)
      if (current.provider_message_id && current.provider_message_id !== sid) fail(409, 'provider_receipt_conflict', 'Provider receipt changed for this operation.')
      if (current.status === 'rejected') fail(409, 'provider_receipt_conflict', 'This operation was rejected before provider dispatch.')
      const retained = await receiveInbound(project, `channel-status:${channel.id}`, digest(`${delivery.public_id}:${raw}`), { deliveryId: delivery.public_id, fields })
      await query("UPDATE support_inbound SET status = 'processed' WHERE id = ?", [retained.id])
      if (!current.provider_message_id) {
        const status = current.wallet_reservation_id ? 'cost_pending' : 'accepted'
        await query('UPDATE support_channel_deliveries SET provider_message_id = ?, status = ?, lease_until = 0, updated_at = ? WHERE id = ?', [sid, status, new Date().toISOString(), current.id])
      }
    })
    // Provider status/cost comes from the account-bound REST receipt, never user-supplied callback price.
    await reconcileChannelDelivery(project, delivery.public_id, dependencies).catch(() => undefined)
    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' } })
  }
  const config = await channelConfig(channel)
  if (operation === 'challenge') {
    if (!['messenger', 'instagram'].includes(String(channel.provider)) || request.get('hub.mode') !== 'subscribe' || request.get('hub.verify_token') !== config.verifyToken) fail(403, 'provider_challenge_refused', 'Provider verification token did not match.')
    return new Response(text(request.get('hub.challenge'), 'provider challenge', 2000), { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } })
  }
  const raw = await rawBody(request)
  if (['sms', 'whatsapp'].includes(String(channel.provider))) {
    if (channel.status !== 'ready' || Number(channel.verified_at) <= 0) fail(409, 'channel_not_ready', 'Verify this channel before accepting provider traffic.')
    const fields = await twilioAuthentication(request, raw, channel, config, 'incoming')
    if (fields.To !== config.fromNumber) fail(403, 'provider_destination_mismatch', 'Incoming destination differs from this connection.')
    const { TwilioDriver, inboundSmsKind } = await import('@stacksjs/sms')
    const sid = text(fields.MessageSid || fields.SmsSid, 'provider message SID', 100)
    // Use provider creation time, not a delayed callback's arrival, for the reply window.
    const source = await new TwilioDriver({ accountSid: String(config.accountSid), authToken: String(config.authToken), from: String(config.fromNumber) }, undefined, dependencies).getReceipt(sid)
    if (source.from !== fields.From || source.to !== fields.To || source.body !== (fields.Body || '')) fail(403, 'provider_message_mismatch', 'Incoming payload differs from its account-bound provider message.')
    const timestamp = Date.parse(source.createdAt || '')
    if (!Number.isSafeInteger(timestamp) || timestamp > Date.now() + 60000) fail(422, 'provider_timestamp_unavailable', 'Provider message creation time is required.')
    const consent = inboundSmsKind(fields)
    await recordChannelConsent(project, channel, fields.From!, consent.kind, sid, timestamp)
    const media = Array.from({ length: Math.min(Number(fields.NumMedia) || 0, 10) }, (_, index) => ({ url: fields[`MediaUrl${index}`], mimeType: fields[`MediaContentType${index}`] }))
    const stored = await retainChannelInbound(project, channel, sid, { sender: fields.From, remoteKey: fields.From, body: fields.Body || '', timestamp, media, mediaOverflow: Number(fields.NumMedia) > 10, consent: consent.kind }, { fields })
    return new Response('<Response/>', { headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store', 'X-Support-Inbound': stored.id } })
  }
  let body: Row
  try { body = object(JSON.parse(raw)) }
  catch { fail(400, 'provider_json_invalid', 'Provider event is not JSON.') }
  if (channel.provider === 'slack') {
    const timestamp = request.headers.get('x-slack-request-timestamp') || ''
    if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) fail(401, 'provider_timestamp_expired', 'Slack event timestamp is outside the authentication window.')
    const signature = request.headers.get('x-slack-signature') || ''
    if (!signature.startsWith('v0=')) fail(401, 'invalid_provider_signature', 'Slack signature is missing.')
    signedHmac(config.signingSecret, `v0:${timestamp}:${raw}`, signature.slice(3))
    if (body.type === 'url_verification') return Response.json({ challenge: text(body.challenge, 'Slack challenge', 2000) })
    if (channel.status !== 'ready' || Number(channel.verified_at) <= 0) fail(409, 'channel_not_ready', 'Verify this channel before accepting provider traffic.')
    if (body.team_id !== config.teamId || body.type !== 'event_callback') fail(403, 'provider_team_mismatch', 'Slack team does not match this connection.')
    const event = object(body.event)
    if (event.channel !== config.channelId) fail(403, 'provider_channel_mismatch', 'Slack event belongs to another channel.')
    if (event.bot_id || event.subtype === 'bot_message') return Response.json({ accepted: true, ignored: true })
    const media = Array.isArray(event.files) ? event.files : []
    const stored = await retainChannelInbound(project, channel, text(body.event_id, 'Slack event ID', 200), { sender: event.user, remoteKey: event.thread_ts || event.ts, body: event.text || '', timestamp: Math.floor(Number(event.ts) * 1000), media }, { raw })
    return Response.json(stored)
  }
  if (['messenger', 'instagram'].includes(String(channel.provider))) {
    signedHmac(config.appSecret, raw, request.headers.get('x-hub-signature-256') || '')
    if (channel.status !== 'ready' || Number(channel.verified_at) <= 0) fail(409, 'channel_not_ready', 'Verify this channel before accepting provider traffic.')
    if (!['page', 'instagram'].includes(String(body.object))) fail(422, 'unsupported_provider_object', 'Unsupported Meta event object.')
    const entries = Array.isArray(body.entry) ? body.entry : []
    let retained = 0
    for (const item of entries) {
      const entry = object(item)
      if (entry.id !== config.accountId) fail(403, 'provider_account_mismatch', 'Meta event account differs from this connection.')
      for (const value of Array.isArray(entry.messaging) ? entry.messaging : []) {
        const event = object(value), message = object(event.message)
        if (message.is_echo || !message.mid) continue
        const sender = String(object(event.sender).id || '')
        if (object(event.recipient).id !== config.accountId) fail(403, 'provider_recipient_mismatch', 'Meta destination differs from this account.')
        await retainChannelInbound(project, channel, String(message.mid), { sender, remoteKey: sender, body: message.text || '', timestamp: Number(event.timestamp), media: Array.isArray(message.attachments) ? message.attachments : [] }, { raw })
        retained++
      }
    }
    return Response.json({ accepted: true, retained })
  }
  fail(422, 'unsupported_provider_webhook', 'This connection receives messages through its native provider inbox poll.')
}
