import { createMemoryInvalidationBus, createRedisInvalidationBus } from '@stacksjs/realtime'
import type { InvalidationBus } from '@stacksjs/realtime'
import type { Row } from './database'
import { db, one, query, workspaceTransaction } from './database'
import { fail } from './errors'
import { supportRealtimeRedisUrl } from './realtime-config'
import { conversation, digest, latestAgentReplyId, member } from './service'

export const inboxPresenceLeaseMs = 24_000
const maxActiveTabs = 16
export const maxTypingStreams = 512
export const customerTypingChannel = (project: Row, conversationId: unknown) => `support.typing.${project.id}.${conversationId}`
let typingInvalidations: InvalidationBus | undefined

export function supportTypingInvalidations(): InvalidationBus {
  if (!typingInvalidations) {
    const bounds = { maxChannels: maxTypingStreams, maxSubscriptions: maxTypingStreams }
    const url = supportRealtimeRedisUrl()
    const namespace = 'hq-support-typing-' + new Bun.CryptoHasher('sha256').update(process.env.SUPPORT_REALTIME_NAMESPACE || 'hq-support-replay-v1').digest('hex')
    typingInvalidations = url ? createRedisInvalidationBus({ ...bounds, url, namespace }) : createMemoryInvalidationBus(bounds)
  }
  return typingInvalidations
}

async function hasCustomerTyping(project: Row, selected: Row, now = Date.now()): Promise<boolean> {
  const composing = await one(`SELECT 1 AS typing FROM support_customer_presences p
    JOIN support_customer_sessions s ON s.id = p.session_id AND s.workspace_id = p.workspace_id AND s.project_id = p.project_id
    WHERE p.workspace_id = ? AND p.project_id = ? AND p.conversation_id = ? AND s.contact_id = ?
      AND p.state = 'composing' AND p.expires_at > ? AND s.expires_at > ? LIMIT 1`,
  [project.workspace_id, project.id, selected.id, selected.contact_id, now, now])
  return Boolean(composing)
}

export async function customerTyping(project: Row, reference: unknown) {
  const selected = await conversation(project, reference)
  return { typing: await hasCustomerTyping(project, selected) }
}

export async function supportTyping(project: Row, reference: unknown, customer: Row) {
  const selected = await conversation(project, reference, customer)
  const composing = await one(`SELECT 1 AS typing FROM support_inbox_presences p
    JOIN support_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = p.user_id AND m.status = 'active'
    WHERE p.workspace_id = ? AND p.project_id = ? AND p.conversation_id = ? AND p.state = 'composing' AND p.expires_at > ?
    LIMIT 1`, [project.workspace_id, project.id, selected.id, Date.now()])
  return { typing: Boolean(composing) }
}

function decodePresence(input: Row, allowViewing: boolean) {
  const { tabId, sequence, state } = input
  if (Object.keys(input).length !== 3 || typeof tabId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(tabId)
    || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1
    || (state !== 'composing' && state !== 'away' && !(allowViewing && state === 'viewing'))) {
    fail(422, 'invalid_presence', 'Send a tab identity, its sequence, and a supported presence state.')
  }
  return { tabId, sequence, state }
}

export async function updateCustomerPresence(project: Row, reference: unknown, token: string, input: Row, acceptedAt: number) {
  const { tabId, sequence, state } = decodePresence(input, false)
  const changed = await db.transaction(async () => {
    // Lock only this session, so its tab limit and credential revocation serialize.
    const session = await one(`UPDATE support_customer_sessions SET expires_at = expires_at
      WHERE digest = ? AND workspace_id = ? AND project_id = ? AND expires_at > ? RETURNING id, contact_id, expires_at`,
    [digest(token), project.workspace_id, project.id, Date.now()])
    const now = Date.now()
    if (!session || Number(session.expires_at) <= now) fail(401, 'invalid_session', 'Customer session is invalid or expired.')
    const selected = await conversation(project, reference, { id: session.contact_id })
    const expiresAt = acceptedAt + inboxPresenceLeaseMs
    if (expiresAt <= now) return []
    const previous = await one('SELECT conversation_id, sequence, state, expires_at FROM support_customer_presences WHERE session_id = ? AND tab_id = ?', [session.id, tabId])
    if (previous && Number(previous.sequence) >= sequence) return []
    if (!previous || Number(previous.expires_at) <= now) {
      const tabs = await one('SELECT COUNT(*) AS total FROM support_customer_presences WHERE session_id = ? AND expires_at > ?', [session.id, now])
      if (Number(tabs?.total) >= maxActiveTabs) fail(429, 'presence_tab_limit', 'Close an extra support tab to show typing here.')
    }
    await query(`INSERT INTO support_customer_presences (workspace_id, project_id, conversation_id, session_id, tab_id, sequence, state, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, tab_id) DO UPDATE SET conversation_id = excluded.conversation_id, sequence = excluded.sequence,
        state = excluded.state, expires_at = excluded.expires_at`,
    [project.workspace_id, project.id, selected.id, session.id, tabId, sequence, state, expiresAt])
    const prior = previous?.state === 'composing' && Number(previous.expires_at) > now ? customerTypingChannel(project, previous.conversation_id) : undefined
    const current = state === 'composing' ? customerTypingChannel(project, selected.id) : undefined
    return prior === current ? [] : [prior, current].filter(channel => channel !== undefined)
  })
  // A hint belongs only to a committed change. Renewal and stale requests need no hint.
  await Promise.allSettled(changed.map(async channel => await supportTypingInvalidations().publish(channel)))
  return { accepted: true }
}

export async function updateInboxPresence(project: Row, reference: unknown, userId: number, input: Row) {
  const { tabId, sequence, state } = decodePresence(input, true)
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
    return { viewers: viewers.map(row => ({ userId: String(row.user_id), composing: Number(row.composing) === 1 })), lastAgentReplyId: await latestAgentReplyId(project, selected.id), customerTyping: await hasCustomerTyping(project, selected, now) }
  })
}

export async function pruneInboxPresence() {
  const now = Date.now()
  const deleted = await query('DELETE FROM support_inbox_presences WHERE expires_at <= ? AND id IN (SELECT id FROM support_inbox_presences WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 10000) RETURNING id', [now, now])
  const customers = await query('DELETE FROM support_customer_presences WHERE expires_at <= ? AND id IN (SELECT id FROM support_customer_presences WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 10000) RETURNING id', [now, now])
  return { deleted: deleted.length + customers.length }
}
