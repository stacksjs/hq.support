import { managedCostFromMicros } from './billing'
import { one, query } from './database'
import { fail } from './errors'
import { terminalCall } from './phone'
import { digest, object } from './service'
import { realtimeBillingScope } from './voice-billing-scope'

const format = 'openai-realtime-costs-v1'
const dayMs = 86_400_000
const scopeLimit = 100

export async function previewVoiceCosts(input: unknown, now = Date.now()) {
  const report = object(input)
  const { day, sourceSha256, costMicros, exclusive, complete } = report
  if (report.format !== format || report.currency !== 'USD'
    || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)
    || typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)
    || typeof exclusive !== 'boolean' || typeof complete !== 'boolean'
    || typeof costMicros !== 'number' || !Number.isSafeInteger(costMicros) || costMicros < 0)
    fail(422, 'voice_cost_evidence_invalid', 'Provide a reviewed USD Realtime daily cost file with scope and evidence digest.')
  const start = Date.parse(day + 'T00:00:00.000Z')
  const end = start + dayMs
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day)
    fail(422, 'voice_cost_day_invalid', 'Use a valid UTC day for the provider evidence.')
  if (end > now)
    fail(409, 'voice_cost_day_open', 'Wait until the UTC day has closed before reviewing provider evidence.')
  managedCostFromMicros(costMicros)
  let scope: string
  try { scope = realtimeBillingScope(report.scope) }
  catch { fail(422, 'voice_cost_scope_invalid', 'Provide the organization, project and dedicated API key identifiers from the export.') }

  const rows = await query(`
    SELECT call.public_id, call.workspace_id, call.project_id, call.status, call.stream_state, call.ai_cost_micros,
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
    return { ...preview, state: 'incomplete_evidence' as const }
  if (rows.length !== 1)
    return { ...preview, state: rows.length === 0 ? 'no_matching_calls' as const : 'ambiguous_cohort' as const }
  const row = rows[0]!
  const closedAt = Number(row.ai_stream_closed_at)
  if (Number(row.ai_stream_opened_at) < start || closedAt < Number(row.ai_stream_opened_at)
    || closedAt >= end || row.stream_state === 'active' || !terminalCall(row.status))
    return { ...preview, state: 'incomplete_call' as const }
  if (row.hold_status === 'settled' || row.hold_status === 'released')
    return { ...preview, state: 'already_settled' as const }
  if (!row.hold_id || row.hold_status !== 'reserved' || row.ai_cost_micros != null
    || Number(row.actual_cents) !== 0 || Number(row.hold_cost_micros) !== -1 || row.provider_reference !== '')
    return { ...preview, state: 'hold_changed' as const }

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
  const chargedCents = managedCostFromMicros(priorCost + costMicros) - priorCharge
  const reservedCents = Number(row.reserved_cents)
  if (!Number.isSafeInteger(reservedCents) || chargedCents < 0 || chargedCents > reservedCents)
    return { ...preview, state: 'hold_exceeded' as const }
  return {
    ...preview,
    state: 'matched' as const,
    allocation: { callId: String(row.public_id), chargedCents, releasedCents: reservedCents - chargedCents },
    approval: digest(JSON.stringify([format, scope, day, sourceSha256, costMicros, row.public_id, row.workspace_id,
      row.project_id, row.ai_stream_opened_at, closedAt, row.hold_id, reservedCents, period, priorCost, priorCharge])),
  }
}
