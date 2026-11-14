import type { Row } from './database'
import { insert, one, query } from './database'
import { fail } from './errors'
import type { Plan } from './limits'
import { limitsFor, periodOf } from './limits'
import { entitled, usage } from './service'

export function copilotLimitsFor(plan: Plan) {
  const limits = limitsFor(plan)
  return { requests: limits.copilotRequests, tokens: limits.copilotTokens }
}
/** Caller holds the workspace transaction; counters include pending provider reservations. */
async function change(workspaceId: number, period: string, meter: string, delta: number) {
  const row = await one('SELECT id FROM support_usage WHERE workspace_id = ? AND period = ? AND meter = ?', [workspaceId, period, meter])
  if (row) await query('UPDATE support_usage SET used = used + ?, updated_at = ? WHERE id = ?', [delta, new Date().toISOString(), row.id])
  else if (delta > 0) await insert('support_usage', { workspace_id: workspaceId, period, meter, used: delta })
}
export async function assertCopilotBudget(workspaceId: number, tokens: number, period: string) {
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > 20_000) fail(422, 'copilot_request_limit', 'Copilot requests have a 20,000-token maximum.')
  const workspace = await entitled(workspaceId), limits = copilotLimitsFor(workspace.plan as Plan)
  const requests = await usage(workspaceId, 'copilot_requests', period), usedTokens = await usage(workspaceId, 'copilot_tokens', period)
  if ((limits.requests !== null && requests >= limits.requests) || (limits.tokens !== null && usedTokens + tokens > limits.tokens)) fail(402, 'copilot_limit', 'The workspace reached its separate monthly copilot budget.')
}
export async function reserveCopilot(workspaceId: number, tokens: number, period: string) {
  await assertCopilotBudget(workspaceId, tokens, period)
  await change(workspaceId, period, 'copilot_requests', 1)
  await change(workspaceId, period, 'copilot_tokens', tokens)
}
export async function releaseCopilot(workspaceId: number, period: string, tokens: number) {
  await change(workspaceId, period, 'copilot_requests', -1)
  await change(workspaceId, period, 'copilot_tokens', -tokens)
}
export async function settleCopilot(workspaceId: number, period: string, reserved: number, actual: number) {
  await change(workspaceId, period, 'copilot_tokens', actual - reserved)
}
export async function copilotBudgetView(workspace: Row) {
  const period = periodOf(), limits = copilotLimitsFor(workspace.plan as Plan)
  const requests = await usage(Number(workspace.id), 'copilot_requests', period), tokens = await usage(Number(workspace.id), 'copilot_tokens', period)
  return { period, used: { requests, tokens }, limits, remaining: { requests: limits.requests === null ? null : Math.max(0, limits.requests - requests), tokens: limits.tokens === null ? null : Math.max(0, limits.tokens - tokens) }, maxRequestTokens: 20_000, includesPendingReservations: true }
}
