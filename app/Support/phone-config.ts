import type { Row } from './database'
import type { TelephonyFetch } from '@stacksjs/telephony'
import { createHmac } from 'node:crypto'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { fail } from './errors'
import { object } from './service'
import { SqlPhoneJournal } from './phone-journal'

export interface PhoneDependencies { fetch?: TelephonyFetch }
export interface PhonePricing { telephonyCeilingCentsPerMinute: number, aiCeilingCentsPerMinute: number, dailyCapCents: number, monthlyCapCents: number, maxDurationSeconds: number, realtimeModel: string, rates: Row }
export function northAmericanNumber(value: unknown): { number: string, country: 'US' | 'CA' } {
  if (typeof value !== 'string' || !/^\+1\d{10}$/.test(value)) fail(422, 'unsupported_number', 'Use a valid US or Canadian E.164 telephone number.')
  const parsed = parsePhoneNumberFromString(value)
  if (!parsed?.isValid() || !['US', 'CA'].includes(parsed.country ?? '')) fail(422, 'unsupported_number', 'Only US and Canadian destinations are supported.')
  return { number: parsed.number, country: parsed.country as 'US' | 'CA' }
}
export function phonePricing(credentials: Row): PhonePricing {
  let policies: Row = {}
  try { policies = object(JSON.parse(process.env.SUPPORT_PHONE_PRICING || '{}')) }
  catch { fail(503, 'phone_pricing_unavailable', 'Phone pricing ceilings are not configured.') }
  const row = object(policies[String(credentials.accountSid)])
  for (const key of ['telephonyCeilingCentsPerMinute', 'aiCeilingCentsPerMinute', 'dailyCapCents', 'monthlyCapCents', 'maxDurationSeconds']) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1) fail(503, 'phone_pricing_unavailable', 'Phone pricing ceilings are not configured.')
  }
  if (Number(row.maxDurationSeconds) < 30 || Number(row.maxDurationSeconds) > 900 || Number(row.dailyCapCents) > Number(row.monthlyCapCents)) fail(503, 'phone_pricing_unavailable', 'Phone spending policy is invalid.')
  const rates = object(row.rates)
  if (typeof row.realtimeModel !== 'string' || !/^[\w.:-]{1,128}$/.test(row.realtimeModel) || ['inputText', 'inputAudio', 'cachedText', 'cachedAudio', 'outputText', 'outputAudio'].some(key => !Number.isSafeInteger(rates[key]) || Number(rates[key]) < 0)) fail(503, 'phone_pricing_unavailable', 'Exact model usage prices are required before paid voice AI.')
  return { ...row, rates: object(row.rates) } as unknown as PhonePricing
}
export function phoneOrigin() {
  const url = new URL(process.env.APP_URL || 'https://hq.support')
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') fail(503, 'phone_unavailable', 'Phone requires the canonical HTTPS application origin.')
  return url.origin
}
export function streamToken(authToken: string, callPublicId: string) { return createHmac('sha256', authToken).update(`hq-support-stream:${callPublicId}`).digest('hex') }
export async function phoneProvider(channel: Row, credentials: Row, dependencies: PhoneDependencies = {}) {
  const { TwilioTelephony } = await import('@stacksjs/telephony')
  return new TwilioTelephony({ accountSid: String(credentials.accountSid || ''), authToken: String(credentials.authToken || ''), journal: new SqlPhoneJournal(Number(channel.workspace_id), Number(channel.id)), ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}) })
}
export function callView(row: Row) {
  return { id: row.public_id, channelId: String(row.channel_id), projectId: row.project_id, status: row.status, direction: row.direction, from: row.from_number, to: row.to_number, mode: row.mode, maxDurationSeconds: row.max_duration_seconds, durationSeconds: row.duration_seconds, providerState: row.provider_state, settlement: Number(row.settled_at) > 0 ? 'settled' : 'pending', reservedCents: Number(row.reserved_cents) + Number(row.ai_reserved_cents), transcript: row.transcript, lastError: row.last_error }
}
