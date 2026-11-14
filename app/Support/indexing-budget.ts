import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail } from './errors'
import type { Plan } from './limits'
import { limitsFor, periodOf } from './limits'
import { entitled, usage } from './service'

async function change(workspaceId: number, period: string, delta: number) {
  const row = await one("SELECT id FROM support_usage WHERE workspace_id = ? AND period = ? AND meter = 'indexing_tokens'", [workspaceId, period])
  if (row) await query('UPDATE support_usage SET used = used + ?, updated_at = ? WHERE id = ?', [delta, new Date().toISOString(), row.id])
  else if (delta > 0) await insert('support_usage', { workspace_id: workspaceId, period, meter: 'indexing_tokens', used: delta })
}
/** All mutations are called under the workspace transaction, independently of chat/copilot usage. */
export async function reserveIndexing(workspaceId: number, reserved: number, period: string) {
  if (!Number.isSafeInteger(reserved) || reserved <= 0 || reserved > 1_000_000) fail(422, 'indexing_request_limit', 'An indexing attempt must reserve at most 1,000,000 input tokens.')
  const workspace = await entitled(workspaceId), limit = limitsFor(workspace.plan as Plan).indexingTokens
  if (limit !== null && await usage(workspaceId, 'indexing_tokens', period) + reserved > limit) fail(402, 'indexing_limit', 'This workspace reached its separate monthly knowledge indexing token budget.')
  await change(workspaceId, period, reserved)
}
export async function settleIndexing(index: Row, actual: number, accounting: 'reported' | 'conservative') {
  if (index.reservation_state !== 'held') fail(409, 'index_reservation_lost', 'This indexing reservation is no longer active.')
  const reserved = Number(index.reserved_tokens)
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > reserved) fail(502, 'embedding_invalid_usage', 'The embedding provider returned invalid token usage.')
  await change(Number(index.workspace_id), String(index.period), actual - reserved)
  await query("UPDATE support_knowledge_indexes SET reservation_state = 'settled', actual_tokens = ?, token_accounting = ? WHERE id = ? AND owner_token = ? AND reservation_state = 'held'", [actual, accounting, index.id, index.owner_token])
}
export async function releaseIndexing(indexId: unknown, workspaceId: number, ownerToken: string) {
  const row = await one("SELECT * FROM support_knowledge_indexes WHERE id = ? AND workspace_id = ? AND owner_token = ? AND reservation_state = 'held'", [indexId, workspaceId, ownerToken])
  if (!row) return
  await change(workspaceId, String(row.period), -Number(row.reserved_tokens))
  await query("UPDATE support_knowledge_indexes SET reservation_state = 'released', updated_at = ? WHERE id = ? AND owner_token = ? AND reservation_state = 'held'", [new Date().toISOString(), row.id, ownerToken])
}
export async function recoverIndexingReservations(workspaceId?: number) {
  const rows = await query(`SELECT id, workspace_id, owner_token FROM support_knowledge_indexes WHERE reservation_state = 'held' AND lease_until <= ?${workspaceId === undefined ? '' : ' AND workspace_id = ?'} ORDER BY id LIMIT 100`, [Date.now(), ...(workspaceId === undefined ? [] : [workspaceId])])
  for (const row of rows) await workspaceTransaction(Number(row.workspace_id), async () => {
    await releaseIndexing(row.id, Number(row.workspace_id), String(row.owner_token))
    await query("UPDATE support_knowledge_indexes SET status = 'expired' WHERE id = ? AND owner_token = ? AND reservation_state = 'released' AND status <> 'active'", [row.id, row.owner_token])
  })
  return rows.length
}
export async function indexingBudgetView(workspace: Row) {
  const period = periodOf(), limit = limitsFor(workspace.plan as Plan).indexingTokens, used = await usage(Number(workspace.id), 'indexing_tokens', period)
  return { period, used, limit, remaining: limit === null ? null : Math.max(0, limit - used), includesPendingReservations: true, missingProviderUsage: 'conservative-input-byte-reservation' }
}
