import { createHash } from 'node:crypto'
import { fail } from './errors'
import { object } from './service'

const decimalToken = Symbol('OpenAI Costs amount')
const maxOpenAiCostBytes = 4 * 1024 * 1024

export async function loadOpenAiVoiceCostExport(path: string) {
  const file = Bun.file(path)
  if (file.size > maxOpenAiCostBytes)
    fail(422, 'voice_cost_export_invalid', 'Provide a complete OpenAI Costs JSON response of at most 4 MiB.')
  return await file.bytes()
}

function decimalAmount(amount: unknown) {
  const raw = (amount as { [decimalToken]?: string } | null)?.[decimalToken]
  if (!raw || raw.length > 120)
    fail(422, 'voice_cost_amount_invalid', 'The export must contain finite numeric USD cost amounts.')
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw)
  if (!match)
    fail(422, 'voice_cost_amount_invalid', 'The export must contain finite numeric USD cost amounts.')
  const fraction = match[3] ?? ''
  const power = Number(match[4] ?? 0) - fraction.length + 6
  if (!Number.isSafeInteger(power) || Math.abs(power) > 100)
    fail(422, 'voice_cost_amount_invalid', 'The exported amount is outside the supported precision.')
  return { digits: BigInt(match[1] + match[2]! + fraction), power }
}

/** Read the official Costs response for one closed day and one dedicated key. */
export function readOpenAiVoiceCosts(source: Uint8Array, expected: {
  start: number, end: number, projectId: string, apiKeyId: string, lineItems: string[],
}) {
  if (source.byteLength === 0 || source.byteLength > maxOpenAiCostBytes)
    fail(422, 'voice_cost_export_invalid', 'Provide a complete OpenAI Costs JSON response of at most 4 MiB.')
  let page: ReturnType<typeof object>
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(source)
    page = object(JSON.parse(json, (key, value, context?: { source?: string }) => {
      if (key === 'value' && typeof value === 'number') return { [decimalToken]: context?.source }
      return value
    }))
  }
  catch { fail(422, 'voice_cost_export_invalid', 'Provide a valid UTF-8 OpenAI Costs JSON response.') }
  if (page.object !== 'page' || page.has_more !== false || page.next_page !== null || !Array.isArray(page.data) || page.data.length !== 1)
    fail(422, 'voice_cost_export_incomplete', 'Export the complete Costs page for exactly one UTC day.')
  const bucket = object(page.data[0])
  if (bucket.object !== 'bucket' || bucket.start_time !== expected.start / 1000 || bucket.end_time !== expected.end / 1000
    || !Array.isArray(bucket.results) || bucket.results.length !== expected.lineItems.length)
    fail(422, 'voice_cost_export_scope_invalid', 'The Costs bucket must match the UTC day and every reviewed line item.')

  const remaining = new Set(expected.lineItems)
  const amounts = bucket.results.map((entry: unknown) => {
    const row = object(entry)
    if (row.object !== 'organization.costs.result' || row.project_id !== expected.projectId || row.api_key_id !== expected.apiKeyId
      || typeof row.line_item !== 'string' || !remaining.delete(row.line_item))
      fail(422, 'voice_cost_export_scope_invalid', 'Every cost row must match the exact project, dedicated key, and reviewed line item.')
    const amount = object(row.amount)
    if (amount.currency !== 'usd')
      fail(422, 'voice_cost_amount_invalid', 'The exported cost amounts must be in USD.')
    return decimalAmount(amount.value)
  })

  const scale = Math.min(0, ...amounts.map(amount => amount.power))
  const total = amounts.reduce((sum, amount) => sum + amount.digits * 10n ** BigInt(amount.power - scale), 0n)
  const divisor = 10n ** BigInt(-scale)
  // Sum the exact decimal amounts before rounding the net total to microdollars.
  const micros = (total + divisor / 2n) / divisor
  if (total < 0n || micros > 1_000_000_000_000n)
    fail(422, 'voice_cost_amount_invalid', 'The reviewed USD total is outside the supported wallet range.')
  return { costMicros: Number(micros), sourceSha256: createHash('sha256').update(source).digest('hex') }
}
