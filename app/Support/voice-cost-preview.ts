import { managedCostFromMicros } from './billing'
import { one, query } from './database'
import { fail } from './errors'
import { readOpenAiVoiceCosts } from './openai-voice-costs'
import { terminalCall } from './phone'
import { digest, object } from './service'
import { realtimeBillingScope } from './voice-billing-scope'

const format = 'openai-realtime-costs-v1'
const dayMs = 86_400_000
const scopeLimit = 100

export function normalizeVoiceCostEvidence(input: unknown, source: Uint8Array, now: number) {
  const report = object(input)
  const { day, lineItems, exclusive, complete, replaces = '' } = report
  if (report.format !== format || report.currency !== 'USD'
    || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
    || typeof replaces !== 'string' || (replaces !== '' && !/^[a-f0-9]{64}$/.test(replaces))
    || typeof exclusive !== 'boolean' || typeof complete !== 'boolean'
    || !Array.isArray(lineItems) || lineItems.length > 1000 || new Set(lineItems).size !== lineItems.length
    || lineItems.some(item => typeof item !== 'string' || !item.trim() || item.length > 250))
    fail(422, 'voice_cost_evidence_invalid', 'Provide a reviewed USD Realtime daily scope and its exact line items.')
  const start = Date.parse(day + 'T00:00:00.000Z')
  const end = start + dayMs
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day)
    fail(422, 'voice_cost_day_invalid', 'Use a valid UTC day for the provider evidence.')
  if (end > now)
    fail(409, 'voice_cost_day_open', 'Wait until the UTC day has closed before reviewing provider evidence.')
  let identifiers: ReturnType<typeof realtimeBillingScope>
  try { identifiers = realtimeBillingScope(report.scope) }
  catch { fail(422, 'voice_cost_scope_invalid', 'Provide the organization, project and dedicated API key identifiers from the export.') }
  const { projectId, apiKeyId, digest: scope } = identifiers
  const { sourceSha256, costMicros } = readOpenAiVoiceCosts(source, { start, end, projectId, apiKeyId, lineItems })
  const inputSha256 = digest(JSON.stringify([format, scope, day, sourceSha256, costMicros, exclusive, complete, replaces, [...lineItems].sort()]))
  return { format, scope, day, start, end, sourceSha256, costMicros, exclusive, complete, replaces, inputSha256 }
}

type VoiceCostEvidence = ReturnType<typeof normalizeVoiceCostEvidence>

export async function planVoiceCosts(evidence: VoiceCostEvidence) {
  const { scope, day, start, end, sourceSha256, costMicros, complete, exclusive, replaces, inputSha256 } = evidence
  const rows = await query(`
    SELECT call.id, call.public_id, call.workspace_id, call.project_id, call.status, call.stream_state, call.ai_cost_micros,
      call.ai_stream_opened_at, call.ai_stream_closed_at, hold.public_id AS hold_id, hold.reserved_cents,
      hold.status AS hold_status, hold.actual_cents, hold.provider_cost_micros AS hold_cost_micros,
      hold.provider_reference, hold.created_at AS hold_created_at
    FROM support_phone_calls call
    LEFT JOIN support_wallet_reservations hold ON hold.public_id = call.ai_reservation_id
      AND hold.workspace_id = call.workspace_id AND hold.project_id = call.project_id
      AND hold.provider = 'openai-realtime' AND hold.operation_key = 'voice-ai:' || call.public_id
    WHERE call.ai_billing_scope = ? AND call.ai_stream_opened_at > 0 AND call.ai_stream_opened_at < ?
      AND (call.ai_stream_closed_at = 0 OR call.ai_stream_closed_at >= ?)
    ORDER BY call.ai_stream_opened_at, call.id LIMIT 101
  `, [scope, end, start])
  const calls = rows.slice(0, scopeLimit).map(row => ({
    callId: String(row.public_id),
    workspaceId: Number(row.workspace_id),
    projectId: Number(row.project_id),
    hold: String(row.hold_status ?? 'missing'),
  }))
  const preview = { format, day, sourceSha256, costMicros, calls, truncated: rows.length > scopeLimit }
  if (!complete || !exclusive)
    return { preview: { ...preview, state: 'incomplete_evidence' as const } }
  if (rows.length !== 1)
    return { preview: { ...preview, state: rows.length === 0 ? 'no_matching_calls' as const : 'ambiguous_cohort' as const } }
  const row = rows[0]!
  const closedAt = Number(row.ai_stream_closed_at)
  if (Number(row.ai_stream_opened_at) < start || closedAt < Number(row.ai_stream_opened_at)
    || closedAt >= end || row.stream_state === 'active' || !terminalCall(row.status))
    return { preview: { ...preview, state: 'incomplete_call' as const } }

  const latest = await one(`
    SELECT id, call_id, approval, cost_micros, charged_cents FROM support_voice_cost_revisions
    WHERE billing_scope = ? AND day = ? ORDER BY id DESC LIMIT 1
  `, [scope, day])
  if (String(latest?.approval ?? '') !== replaces || (latest && String(latest.call_id) !== String(row.id)))
    return { preview: { ...preview, state: 'revision_changed' as const, latestApproval: String(latest?.approval ?? '') } }
  const previousCost = Number(row.hold_cost_micros)
  const previousCharge = Number(row.actual_cents)
  const reserved = row.hold_status === 'reserved'
  const openHold = reserved && row.ai_cost_micros == null && previousCharge === 0 && previousCost === -1
    && row.provider_reference === '' && !latest
  const appliedHold = (row.hold_status === 'settled' || row.hold_status === 'released')
    && row.provider_reference === `openai:${row.public_id}`
    && previousCost >= 0 && row.ai_cost_micros != null && Number(row.ai_cost_micros) === previousCost
    && (!latest || (Number(latest.cost_micros) === previousCost && Number(latest.charged_cents) === previousCharge))
  if (!row.hold_id || (!openHold && !appliedHold))
    return { preview: { ...preview, state: 'hold_changed' as const } }
  if (appliedHold && previousCost === costMicros)
    return { preview: { ...preview, state: 'already_settled' as const } }

  const created = new Date(row.hold_created_at as string | Date)
  if (!Number.isFinite(created.getTime()))
    fail(503, 'voice_cost_wallet_unavailable', 'The wallet reservation period could not be read.')
  const period = created.toISOString().slice(0, 7)
  const bucket = await one(`
    SELECT provider_cost_micros, charged_cents FROM support_provider_cost_buckets
    WHERE workspace_id = ? AND provider = 'openai-realtime' AND period = ?
  `, [row.workspace_id, period])
  const priorCost = Number(bucket?.provider_cost_micros ?? 0)
  const priorCharge = Number(bucket?.charged_cents ?? 0)
  const withoutCall = priorCost - (appliedHold ? previousCost : 0)
  if (withoutCall < 0 || priorCharge !== managedCostFromMicros(priorCost))
    return { preview: { ...preview, state: 'wallet_cost_changed' as const } }
  const aggregateMicros = withoutCall + costMicros
  const aggregateCents = managedCostFromMicros(aggregateMicros)
  const chargedCents = previousCharge + aggregateCents - priorCharge
  const reservedCents = Number(row.reserved_cents)
  if (!Number.isSafeInteger(reservedCents) || !Number.isSafeInteger(chargedCents) || chargedCents < 0 || chargedCents > reservedCents)
    return { preview: { ...preview, state: 'hold_exceeded' as const } }
  const receiptRows = await query(`
    SELECT response_id, usage, cost_micros FROM support_phone_usage
    WHERE workspace_id = ? AND call_id = ? ORDER BY response_id
  `, [row.workspace_id, row.id])
  const receiptSha256 = digest(JSON.stringify(receiptRows.map(receipt => [String(receipt.response_id), String(receipt.usage), receipt.cost_micros == null ? null : Number(receipt.cost_micros)])))
  const walletDeltaCents = (reserved ? reservedCents : previousCharge) - chargedCents
  return {
    row,
    receiptSha256,
    wallet: { reserved, period, priorCost, priorCharge, aggregateMicros, aggregateCents, previousCost, previousCharge, chargedCents, walletDeltaCents },
    preview: {
      ...preview,
      state: 'matched' as const,
      allocation: { callId: String(row.public_id), previouslyChargedCents: previousCharge, chargedCents, walletDeltaCents },
      approval: digest(JSON.stringify([
        inputSha256, String(row.public_id), String(row.workspace_id), String(row.project_id),
        Number(row.ai_stream_opened_at), closedAt, String(row.hold_id), reserved, reservedCents, previousCost,
        previousCharge, period, priorCost, priorCharge, aggregateCents, chargedCents, walletDeltaCents, receiptSha256,
      ])),
    },
  }
}

export async function previewVoiceCosts(input: unknown, source: Uint8Array, now = Date.now()) {
  return (await planVoiceCosts(normalizeVoiceCostEvidence(input, source, now))).preview
}
