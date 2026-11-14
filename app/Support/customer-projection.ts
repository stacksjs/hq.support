import { ensureDatabaseConfigLoaded, parseSqlDateTime, resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import type { Row } from './database'
import { one } from './database'
import { fail, identifier } from './errors'

export const customerProjectionLimits = { responseBytes: 512 * 1024, summaryBytes: 128 * 1024, messageBytes: 256 * 1024, attachmentBytes: 64 * 1024 } as const

/** SQLite stores both SQL-space and ISO timestamps. Compare instants, never their text. */
export async function customerSummarySelect() {
  await ensureDatabaseConfigLoaded()
  const latest = resolvedDatabaseConfig().driver === 'postgres' ? 'MAX(m.created_at)' : 'ROUND((MAX(julianday(m.created_at)) - 2440587.5) * 86400000)'
  const activity = `(SELECT ${latest} FROM support_messages m WHERE m.workspace_id = support_conversations.workspace_id AND m.project_id = support_conversations.project_id AND m.conversation_id = support_conversations.id AND m.contact_id = support_conversations.contact_id AND m.visibility = 'public') AS public_activity_at`
  const lineage = ['continued_from_id', 'continuation_id'].map(column => `(SELECT linked.id FROM support_conversations linked WHERE linked.id = support_conversations.${column} AND linked.workspace_id = support_conversations.workspace_id AND linked.project_id = support_conversations.project_id AND linked.contact_id = support_conversations.contact_id) AS public_${column}`)
  return [activity, ...lineage].join(', ')
}

export function normalizedTime(value: unknown): string {
  const time = parseSqlDateTime(value)
  if (!time || !Number.isFinite(time.getTime())) fail(503, 'projection_unavailable', 'Conversation history is temporarily unavailable.')
  return time.toISOString()
}

export function customerSummary(row: Row) {
  const created = normalizedTime(row.created_at)
  const activity = row.public_activity_at == null ? created : normalizedTime(row.public_activity_at)
  return { id: String(row.id), subject: String(row.subject), status: String(row.status), resolved_at: Number(row.resolved_at || 0), continued_from_id: row.public_continued_from_id ? String(row.public_continued_from_id) : null, continuation_id: row.public_continuation_id ? String(row.public_continuation_id) : null, customer_id: String(row.contact_id), updated_at: created > activity ? created : activity, unread_count: Number(row.unread_count) }
}

export async function customerConversationSummary(row: Row) {
  const projected = await one(`SELECT support_conversations.*, ${await customerSummarySelect()} FROM support_conversations WHERE id = ? AND workspace_id = ? AND project_id = ? AND contact_id = ?`, [row.id, row.workspace_id, row.project_id, row.contact_id])
  if (!projected) fail(404, 'not_found', 'Conversation not found.')
  return customerSummary(projected)
}

export function historyCursor(value?: string | null) {
  if (value == null) return Number.MAX_SAFE_INTEGER
  if (!/^[1-9]\d*$/.test(value)) fail(422, 'invalid_cursor', 'Use the history cursor returned by the previous page.')
  return identifier(value)
}

export function historyLimit(value: unknown, maximum: number, fallback: number) {
  const limit = value === undefined ? fallback : typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) fail(422, 'invalid_limit', `History limit must be a whole number from 1 to ${maximum}.`)
  return limit
}

/** Descending SQL lookahead plus whole UTF-8 JSON rows. Cursor always names the last emitted row. */
export function boundedPage<T>(rows: Row[], limit: number, bytes: number, view: (row: Row) => T) {
  const items: T[] = []
  let used = 2
  for (const row of rows.slice(0, limit)) {
    const item = view(row), size = Buffer.byteLength(JSON.stringify(item), 'utf8') + (items.length ? 1 : 0)
    if (used + size > bytes) {
      if (!items.length) fail(503, 'projection_unavailable', 'Conversation history is temporarily unavailable.')
      break
    }
    items.push(item); used += size
  }
  return { items, nextCursor: rows.length > items.length ? String(rows[items.length - 1]!.id) : null }
}

export function boundedEnvelope<T>(body: T): T {
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > customerProjectionLimits.responseBytes) fail(503, 'projection_unavailable', 'Conversation history is temporarily unavailable.')
  return body
}
