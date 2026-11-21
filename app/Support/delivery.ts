import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { object, secret } from './service'

export type DeliveryResult = { status: 'delivered', receipt: string } | { status: 'retry' | 'unconfigured', reason: string, retryAfterMs?: number }
export type DeliveryHandler = (event: { id: string, kind: string, workspaceId: number, projectId: number, payload: Row, attempt: number }) => Promise<DeliveryResult>

async function claimOutbox(id: number, now: number, leaseMs: number): Promise<Row | null> {
  const initial = await one('SELECT * FROM support_outbox WHERE id = ?', [id])
  if (!initial) return null
  return await workspaceTransaction(Number(initial.workspace_id), async () => {
    const row = await one('SELECT * FROM support_outbox WHERE id = ?', [id])
    if (!row || !['pending', 'processing'].includes(String(row.status)) || Number(row.available_at) > now || Number(row.lease_until) > now) return null
    const lease = secret()
    await query("UPDATE support_outbox SET status = 'processing', lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", [lease, now + leaseMs, new Date(now).toISOString(), id])
    return { ...row, lease_token: lease, attempts: Number(row.attempts) + 1 }
  })
}

/** At-least-once delivery: adapters must forward event.id as the provider's idempotency key. */
export async function drainOutbox(deliver: DeliveryHandler, options: { limit?: number, leaseMs?: number, now?: () => number, kinds?: readonly string[] } = {}) {
  const now = options.now || Date.now, limit = options.limit ?? 50, leaseMs = options.leaseMs ?? 60000
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new TypeError('Invalid delivery batch options')
  const result = { delivered: 0, retry: 0, unconfigured: 0, claimed: 0 }
  const { kinds } = options
  if (kinds?.length === 0) return result
  const kindFilter = kinds ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
  const candidates = await query(`SELECT id FROM support_outbox WHERE status IN ('pending', 'processing') AND available_at <= ? AND lease_until <= ?${kindFilter} ORDER BY id ASC LIMIT ?`, [now(), now(), ...(kinds ?? []), limit])
  for (const candidate of candidates) {
    const claimed = await claimOutbox(Number(candidate.id), now(), leaseMs)
    if (!claimed) continue
    result.claimed++
    let outcome: DeliveryResult
    try {
      outcome = await deliver({ id: String(claimed.event_id), kind: String(claimed.kind), workspaceId: Number(claimed.workspace_id), projectId: Number(claimed.project_id), payload: object(JSON.parse(String(claimed.payload))), attempt: Number(claimed.attempts) })
      if (outcome.status === 'delivered' && (!outcome.receipt || outcome.receipt.length > 2000)) throw new Error('Provider delivery receipt required')
    }
    catch {
      outcome = { status: 'retry', reason: 'Delivery adapter failed. Inspect provider diagnostics.' }
    }
    await workspaceTransaction(Number(claimed.workspace_id), async () => {
      const current = await one('SELECT * FROM support_outbox WHERE id = ?', [claimed.id])
      if (!current || current.lease_token !== claimed.lease_token || current.status !== 'processing') return
      if (outcome.status === 'delivered') {
        await query("UPDATE support_outbox SET status = 'delivered', provider_receipt = ?, delivered_at = ?, lease_until = 0, last_error = '', updated_at = ? WHERE id = ? AND lease_token = ?", [outcome.receipt, now(), new Date(now()).toISOString(), claimed.id, claimed.lease_token])
      }
      else {
        const delay = Math.min(86400000, Math.max(1000, outcome.retryAfterMs ?? 1000 * 2 ** Math.min(Number(claimed.attempts), 16)))
        await query("UPDATE support_outbox SET status = 'pending', available_at = ?, lease_until = 0, last_error = ?, updated_at = ? WHERE id = ? AND lease_token = ?", [now() + delay, outcome.reason.slice(0, 2000), new Date(now()).toISOString(), claimed.id, claimed.lease_token])
      }
      result[outcome.status]++
    })
  }
  return result
}

/** The authenticated provider adapter calls this before allowance checks or downstream work. */
export async function receiveInbound(project: Row, provider: string, providerEventId: string, payload: Row) {
  const channel = text(provider, 'provider', 50), event = text(providerEventId, 'providerEventId', 200)
  const serialized = JSON.stringify(payload)
  if (serialized.length > 1_000_000) fail(413, 'inbound_too_large', 'Inbound event exceeds the durable payload limit.')
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const existing = await one('SELECT * FROM support_inbound WHERE project_id = ? AND provider = ? AND provider_event_id = ?', [project.id, channel, event])
    if (existing) return { id: String(existing.id), accepted: true, duplicate: true }
    const row = await insert('support_inbound', { workspace_id: project.workspace_id, project_id: project.id, provider: channel, provider_event_id: event, payload: serialized, status: 'pending', available_at: Date.now() })
    return { id: String(row.id), accepted: true, duplicate: false }
  })
}

/** Overflow stays pending and recoverable when the handler refuses a new conversation. */
export async function processInbound(id: unknown, handler: (record: Row) => Promise<void>, options: { now?: number, leaseMs?: number } = {}) {
  const recordId = identifier(id), now = options.now ?? Date.now(), leaseMs = options.leaseMs ?? 60000
  const original = await one('SELECT * FROM support_inbound WHERE id = ?', [recordId])
  if (!original) fail(404, 'not_found', 'Inbound event not found.')
  const row: Row | null = await workspaceTransaction(Number(original.workspace_id), async () => {
    const current = await one('SELECT * FROM support_inbound WHERE id = ?', [recordId])
    if (!current || current.status === 'processed' || Number(current.lease_until) > now || Number(current.available_at) > now) return null
    const lease = secret()
    await query("UPDATE support_inbound SET status = 'processing', lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?", [lease, now + leaseMs, recordId])
    return { ...current, lease_token: lease }
  })
  if (!row) return { processed: false }
  let outcome = 'processed', error = ''
  try { await handler(row) }
  catch { outcome = 'pending'; error = 'Inbound processing deferred. Payload retained for recovery.' }
  await workspaceTransaction(Number(row.workspace_id), async () => {
    await query('UPDATE support_inbound SET status = ?, lease_until = 0, available_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [outcome, outcome === 'pending' ? now + 60000 : now, error, new Date(now).toISOString(), row.id, row.lease_token])
  })
  return { processed: outcome === 'processed' }
}
