import type { Row } from './database'
import { one, query, workspaceTransaction } from './database'
import { fail } from './errors'
import { conversation, latestAgentReplyId, member } from './service'

export const inboxPresenceLeaseMs = 24_000
const maxActiveTabs = 16

export async function updateInboxPresence(project: Row, reference: unknown, userId: number, input: Row) {
  const { tabId, sequence, state } = input
  if (Object.keys(input).length !== 3 || typeof tabId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tabId)
    || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1
    || (state !== 'viewing' && state !== 'composing' && state !== 'away')) {
    fail(422, 'invalid_presence', 'Send a tab identity, its sequence, and a supported presence state.')
  }
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id))
    const selected = await conversation(project, reference)
    const now = Date.now(), timestamp = new Date(now).toISOString()
    const identity = [project.workspace_id, userId, tabId]
    const previous = await one('SELECT id, sequence, expires_at FROM support_inbox_presences WHERE workspace_id = ? AND user_id = ? AND tab_id = ?', identity)
    if (!previous || Number(previous.sequence) < sequence) {
      if (!previous || Number(previous.expires_at) <= now) {
        const tabs = await one('SELECT COUNT(*) AS total FROM support_inbox_presences WHERE workspace_id = ? AND user_id = ? AND expires_at > ?', [project.workspace_id, userId, now])
        if (Number(tabs?.total) >= maxActiveTabs) fail(429, 'presence_tab_limit', 'Close an extra inbox tab to show presence here.')
      }
      await query(`INSERT INTO support_inbox_presences (workspace_id, user_id, tab_id, project_id, conversation_id, sequence, state, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, user_id, tab_id) DO UPDATE SET
          project_id = excluded.project_id, conversation_id = excluded.conversation_id, sequence = excluded.sequence,
          state = excluded.state, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      [...identity, project.id, selected.id, sequence, state, now + inboxPresenceLeaseMs, timestamp, timestamp])
    }
    if (state === 'away') return { viewers: [] }
    const viewers = await query(`SELECT p.user_id, MAX(CASE WHEN p.state = 'composing' THEN 1 ELSE 0 END) AS composing
      FROM support_inbox_presences p
      JOIN support_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id AND m.status = 'active'
      WHERE p.workspace_id = ? AND p.project_id = ? AND p.conversation_id = ? AND p.user_id <> ?
        AND p.state IN ('viewing', 'composing') AND p.expires_at > ?
      GROUP BY p.user_id ORDER BY composing DESC, p.user_id LIMIT 50`, [project.workspace_id, project.id, selected.id, userId, now])
    return { viewers: viewers.map(row => ({ userId: String(row.user_id), composing: Number(row.composing) === 1 })), lastAgentReplyId: await latestAgentReplyId(project, selected.id) }
  })
}

export async function pruneInboxPresence() {
  const now = Date.now()
  const deleted = await query('DELETE FROM support_inbox_presences WHERE expires_at <= ? AND id IN (SELECT id FROM support_inbox_presences WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 10000) RETURNING id', [now, now])
  return { deleted: deleted.length }
}
