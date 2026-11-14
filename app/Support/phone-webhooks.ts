import type { RequestInstance } from '@stacksjs/types'
import type { Row } from './database'
import type { PhoneDependencies } from './phone-config'
import { digest, member } from './service'
import { processInbound, receiveInbound } from './delivery'
import { fail } from './errors'
import { one, insert, query, workspaceTransaction } from './database'
import { inboundChannel, phoneContext, prepareCall, publicPhoneCall, terminalCall } from './phone'
import { SqlPhoneJournal } from './phone-journal'
import { phoneOrigin, phoneProvider, streamToken } from './phone-config'

async function fields(request: RequestInstance) {
  if (!request.rawBody) fail(400, 'raw_body_required', 'The original voice form is required.')
  if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) fail(415, 'invalid_content_type', 'Voice callbacks require form encoding.')
  const raw = await request.rawBody()
  if (Buffer.byteLength(raw) > 32_768) fail(413, 'callback_too_large', 'Voice callback is too large.')
  return new URLSearchParams(raw)
}
async function authenticate(request: RequestInstance, form: URLSearchParams, credentials: Row, path: string, origin = phoneOrigin()) {
  const { parseVoiceWebhook } = await import('@stacksjs/telephony')
  try { return parseVoiceWebhook({ url: origin + path, fields: form, signature: request.headers.get('x-twilio-signature') || '', authToken: String(credentials.authToken), accountSid: String(credentials.accountSid) }) }
  catch { fail(401, 'invalid_voice_signature', 'Voice callback authentication failed.') }
}
const xml = (value: string) => new Response(value, { headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } })
async function consentInstructions(call: Row) {
  const { default: twilio } = await import('twilio')
  const response = new twilio.twiml.VoiceResponse()
  response.gather({ input: ['dtmf'], numDigits: 1, timeout: 10, action: `${call.callback_origin}/api/phone/calls/${call.public_id}/consent`, method: 'POST' }).say(String(call.notice))
  response.say('Consent was not received. Please contact support through the website. Goodbye.')
  response.hangup()
  return xml(response.toString())
}
export async function phoneWebhook(request: RequestInstance, operation: 'incoming' | 'instructions' | 'status' | 'consent' | 'agent' | 'dial-complete' | 'wait', dependencies: PhoneDependencies = {}) {
  const form = await fields(request)
  let call: Row
  if (operation === 'incoming') {
    const context = await inboundChannel(request.getParam('channel'))
    const callback = await authenticate(request, form, context.credentials, `/api/phone/channels/${context.channel.public_id}/incoming`)
    if (callback.to !== context.credentials.fromNumber) fail(403, 'phone_destination_mismatch', 'Inbound number does not belong to this channel.')
    const received = await receiveInbound(context.project, 'twilio-voice', callback.callSid, { from: callback.from, to: callback.to, callSid: callback.callSid, status: callback.status })
    let prepared: Awaited<ReturnType<typeof prepareCall>> | undefined
    const outcome = await processInbound(received.id, async () => { prepared = await prepareCall(context.project, { channelId: context.channel.id, idempotencyKey: `inbound:${callback.callSid}`, mode: 'ai' }, null, { inboundSid: callback.callSid, from: callback.from }) })
    if (!outcome.processed || !prepared) {
      const previous = await one('SELECT * FROM support_phone_calls WHERE workspace_id = ? AND operation_key = ?', [context.project.workspace_id, `inbound:${callback.callSid}`])
      if (previous) return await consentInstructions(previous)
      const { voiceResponse } = await import('@stacksjs/telephony')
      return xml(voiceResponse([{ type: 'say', text: 'We cannot accept this call right now. Your missed call has been saved for support.' }, { type: 'hangup' }]))
    }
    call = prepared.row
    return await consentInstructions(call)
  }
  call = await publicPhoneCall(request.getParam('call'))
  const context = await phoneContext(call)
  const callback = await authenticate(request, form, context.credentials, `/api/phone/calls/${call.public_id}/${operation}`, String(call.callback_origin))
  if ((call.provider_sid && callback.callSid !== call.provider_sid) || callback.from !== call.from_number || callback.to !== call.to_number) fail(403, 'phone_call_mismatch', 'Provider callback does not match this call.')
  if (!call.provider_sid) {
    await workspaceTransaction(Number(call.workspace_id), async () => {
      const current = await publicPhoneCall(String(call.public_id))
      if (current.provider_sid && current.provider_sid !== callback.callSid) fail(409, 'phone_call_mismatch', 'Provider call identity conflicts.')
      await query('UPDATE support_phone_calls SET provider_sid = ? WHERE id = ? AND workspace_id = ?', [callback.callSid, call.id, call.workspace_id])
    })
    call = await publicPhoneCall(String(call.public_id))
  }
  if (call.direction === 'outbound' && call.provider_state !== 'succeeded') {
    const actual = await (await phoneProvider(context.channel, context.credentials, dependencies)).getCall(String(call.provider_sid))
    if (actual.sid !== call.provider_sid || actual.from !== call.from_number || actual.to !== call.to_number) fail(503, 'phone_write_uncertain', 'Signed callback requires provider ownership reconciliation.')
    await workspaceTransaction(Number(call.workspace_id), async () => {
      await new SqlPhoneJournal(Number(call.workspace_id), Number(context.channel.id)).resolveConfirmed(`twilio:${context.credentials.accountSid}:call:${call.public_id}:create`, actual)
      await query("UPDATE support_phone_calls SET provider_state = 'succeeded', last_error = '' WHERE id = ? AND workspace_id = ?", [call.id, call.workspace_id])
      const receipt = digest(`reconciled:${actual.sid}`)
      if (!await one('SELECT id FROM support_phone_events WHERE call_id = ? AND digest = ?', [call.id, receipt])) await insert('support_phone_events', { workspace_id: call.workspace_id, call_id: call.id, digest: receipt, sequence: -1, status: 'reconciled', payload: JSON.stringify({ callSid: actual.sid }) })
    })
    call = await publicPhoneCall(String(call.public_id))
  }
  if (operation === 'instructions') return await consentInstructions(call)
  if (operation === 'consent') {
    const { voiceResponse } = await import('@stacksjs/telephony')
    if (form.getAll('Digits').length !== 1 || form.get('Digits') !== '1') return xml(voiceResponse([{ type: 'say', text: 'Consent was declined. Goodbye.' }, { type: 'hangup' }]))
    if (terminalCall(call.status)) return xml(voiceResponse([{ type: 'hangup' }]))
    const bounded = await (await phoneProvider(context.channel, context.credentials, dependencies)).setCallTimeLimit(String(call.provider_sid), Number(call.max_duration_seconds) + 30, { operationKey: `consent-limit:${call.public_id}` })
    if (bounded.sid !== call.provider_sid) fail(503, 'phone_write_uncertain', 'Provider call ownership could not be confirmed.')
    await workspaceTransaction(Number(call.workspace_id), async () => {
      const current = await publicPhoneCall(String(call.public_id))
      if (terminalCall(current.status)) fail(409, 'call_ended', 'This call already ended.')
      await query("UPDATE support_phone_calls SET consent_at = ?, deadline_at = ?, status = 'in-progress', updated_at = ? WHERE id = ? AND workspace_id = ?", [Number(current.consent_at) || Date.now(), Number(current.deadline_at) || Date.now() + Number(call.max_duration_seconds) * 1000, new Date().toISOString(), current.id, current.workspace_id])
    })
    const publicMedia = new URL(process.env.SUPPORT_VOICE_MEDIA_URL || '')
    if (publicMedia.protocol !== 'wss:' || publicMedia.search || publicMedia.pathname !== '/') fail(503, 'voice_media_unavailable', 'The public voice media service URL must be configured.')
    return xml(voiceResponse([{ type: 'say', text: 'You are speaking with our AI support assistant. You can ask for a human.' }, { type: 'stream', url: `${publicMedia.origin}/phone/media/${call.public_id}`, parameters: { call: String(call.public_id), proof: streamToken(String(context.credentials.authToken), String(call.public_id)) } }]))
  }
  if (operation === 'wait' || operation === 'agent') {
    const { default: twilio } = await import('twilio')
    const response = new twilio.twiml.VoiceResponse()
    const remaining = Math.floor((Number(call.deadline_at) - Date.now()) / 1000)
    if (remaining <= 0 || terminalCall(call.status)) { response.hangup(); return xml(response.toString()) }
    if (operation === 'wait') {
      response.say('A human has been requested. Please wait briefly while an agent joins.')
      response.pause({ length: Math.min(30, remaining) })
      response.say('An agent was not available. Your request has been saved for follow up. Goodbye.')
      response.hangup()
    }
    else {
      if (!call.assigned_agent_id) fail(409, 'agent_not_assigned', 'No authenticated agent is assigned.')
      await member(Number(call.assigned_agent_id), Number(call.workspace_id))
      const client = response.dial({ timeLimit: remaining, timeout: 20, callerId: String(context.credentials.fromNumber), action: `${call.callback_origin}/api/phone/calls/${call.public_id}/dial-complete`, method: 'POST' }).client()
      client.identity(`w${call.workspace_id}.p${call.project_id}.u${call.assigned_agent_id}`)
      client.parameter({ name: 'call', value: String(call.public_id) })
    }
    return xml(response.toString())
  }
  if (operation === 'dial-complete') {
    const child = form.get('DialCallSid')
    if (!child || !/^CA[a-f0-9]{32}$/i.test(child)) fail(422, 'invalid_call_receipt', 'Provider child call receipt is required.')
    await workspaceTransaction(Number(call.workspace_id), async () => {
      const fingerprint = digest(`dial:${child}`)
      if (!await one('SELECT id FROM support_phone_events WHERE call_id = ? AND digest = ?', [call.id, fingerprint])) await insert('support_phone_events', { workspace_id: call.workspace_id, call_id: call.id, digest: fingerprint, sequence: -1, status: 'dial-complete', payload: JSON.stringify({ childSid: child }) })
      await query('UPDATE support_phone_calls SET child_sid = ? WHERE id = ? AND workspace_id = ?', [child, call.id, call.workspace_id])
    })
    const { voiceResponse } = await import('@stacksjs/telephony')
    return xml(voiceResponse([{ type: 'hangup' }]))
  }
  if (operation === 'status') {
    const fingerprint = digest(`${request.headers.get('x-twilio-signature')}:${form.toString()}`)
    await workspaceTransaction(Number(call.workspace_id), async () => {
      if (await one('SELECT id FROM support_phone_events WHERE call_id = ? AND digest = ?', [call.id, fingerprint])) return
      const current = await publicPhoneCall(String(call.public_id)), sequence = callback.sequenceNumber ?? -1
      await insert('support_phone_events', { workspace_id: call.workspace_id, call_id: call.id, digest: fingerprint, sequence, status: callback.status, payload: JSON.stringify({ callSid: callback.callSid, status: callback.status, sequence, duration: form.get('CallDuration') }) })
      if ((sequence >= 0 && sequence <= Number(current.last_sequence)) || (terminalCall(current.status) && !terminalCall(callback.status))) return
      await query('UPDATE support_phone_calls SET status = ?, last_sequence = ?, ended_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [callback.status, Math.max(sequence, Number(current.last_sequence)), terminalCall(callback.status) ? Number(current.ended_at) || Date.now() : current.ended_at, new Date().toISOString(), current.id, current.workspace_id])
    })
    return new Response(null, { status: 204 })
  }
  fail(503, 'voice_route_unavailable', 'This voice route is not available.')
}
