import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail } from './errors'
import { object } from './service'

function integer(value: unknown): number | null { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null }
/** Exact configured token pricing, never substitute missing provider usage with zero. */
function usageNumerator(usage: Row, rates: Row): bigint | null {
  const input = object(usage.input_token_details), output = object(usage.output_token_details), cached = object(input.cached_tokens_details)
  const keys = ['inputText', 'inputAudio', 'cachedText', 'cachedAudio', 'outputText', 'outputAudio']
  if (keys.some(key => integer(rates[key]) === null)) return null
  const it = integer(input.text_tokens), ia = integer(input.audio_tokens), ot = integer(output.text_tokens), oa = integer(output.audio_tokens), cachedTotal = integer(input.cached_tokens)
  if ([it, ia, ot, oa, cachedTotal].some(value => value === null)) return null
  const ct = cachedTotal === 0 ? 0 : integer(cached.text_tokens), ca = cachedTotal === 0 ? 0 : integer(cached.audio_tokens)
  if (ct === null || ca === null || ct > it! || ca > ia! || ct + ca !== cachedTotal || it! + ia! !== usage.input_tokens || ot! + oa! !== usage.output_tokens) return null
  const quantities = [it! - ct, ia! - ca, ct, ca, ot!, oa!]
  let total = 0n
  for (let index = 0; index < keys.length; index++) total += BigInt(quantities[index]!) * BigInt(Number(rates[keys[index]!]))
  return total
}
export function realtimeUsageCost(usage: Row, rates: Row): number | null {
  const total = usageNumerator(usage, rates)
  if (total === null) return null
  const micros = (total + 999999n) / 1000000n
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null
}
export async function recordVoiceUsage(call: Row, responseId: string, usage: Row, rates: Row) {
  if (!/^[\w-]{1,255}$/.test(responseId) || JSON.stringify(usage).length > 16000) fail(422, 'invalid_voice_usage', 'Voice usage is invalid.')
  return await workspaceTransaction(Number(call.workspace_id), async () => {
    const serialized = JSON.stringify({ provider: usage, rates })
    const existing = await one('SELECT * FROM support_phone_usage WHERE workspace_id = ? AND call_id = ? AND response_id = ?', [call.workspace_id, call.id, responseId])
    if (existing) {
      if (existing.usage !== serialized) fail(409, 'voice_usage_conflict', 'Provider usage changed for an existing response.')
    }
    else await insert('support_phone_usage', { workspace_id: call.workspace_id, call_id: call.id, response_id: responseId, usage: serialized, cost_micros: realtimeUsageCost(usage, rates) })
    const rows = await query('SELECT usage FROM support_phone_usage WHERE workspace_id = ? AND call_id = ? ORDER BY id', [call.workspace_id, call.id])
    let numerator = 0n, allPriced = true
    for (const row of rows) {
      const saved = object(JSON.parse(String(row.usage))), cost = usageNumerator(object(saved.provider), object(saved.rates))
      if (cost === null) allPriced = false
      else numerator += cost
    }
    const micros = (numerator + 999999n) / 1000000n
    if (micros > BigInt(Number.MAX_SAFE_INTEGER)) fail(503, 'voice_cost_overflow', 'Provider usage cost exceeds the supported range.')
    return { knownMicros: Number(micros), responses: rows.length, allPriced }

  })
}
export async function appendVoiceTranscript(call: Row, role: string, text: string) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16000 || !['assistant', 'customer'].includes(role)) fail(422, 'invalid_transcript', 'Voice transcript event is invalid.')
  await workspaceTransaction(Number(call.workspace_id), async () => {
    const current = await one('SELECT transcript FROM support_phone_calls WHERE id = ? AND workspace_id = ?', [call.id, call.workspace_id])
    const next = String(current?.transcript || '') + JSON.stringify({ role, text }) + '\n'
    if (Buffer.byteLength(next) > 100000) fail(413, 'transcript_capacity', 'Call transcript capacity reached.')
    await query('UPDATE support_phone_calls SET transcript = ? WHERE id = ? AND workspace_id = ?', [next, call.id, call.workspace_id])
  })
}
