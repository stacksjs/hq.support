import { createMemoryInvalidationBus, createRedisInvalidationBus, createSqlDurableReplayStore } from '@stacksjs/realtime'
import type { InvalidationBus } from '@stacksjs/realtime'
import type { Row, WorkspaceTransaction } from './database'
import { one, requireWorkspaceTransaction } from './database'

// One policy for every process. Policy changes require an explicit incarnation reset.
const replayPolicy = { maxEvents: 100, ttlMs: 300_000, maxPayloadBytes: 32, maxReplayBytes: 32_768 } as const
export const agentReplayChannel = (project: Row) => `support.agent.${Number(project.id)}`
export const customerReplayChannel = (project: Row, contactId: number) => `support.customer.${Number(project.id)}.${contactId}`
let invalidations: InvalidationBus | undefined
/** Explicit Redis opt-in; otherwise hints are local to this process. SQL remains authoritative. */
export function supportReplayInvalidations(): InvalidationBus {
  if (!invalidations) {
    const bounds = { maxChannels: 4096, maxSubscriptions: 4096 }
    const url = process.env.SUPPORT_REALTIME_REDIS_URL
    invalidations = url
      ? createRedisInvalidationBus({ ...bounds, url, namespace: process.env.SUPPORT_REALTIME_NAMESPACE || 'hq-support-replay-v1' })
      : createMemoryInvalidationBus(bounds)
  }
  return invalidations
}

/** Trusted internal adapter. Callers must authorize and select channels before using it. */
export function supportReplayStore(project: Row, tx: WorkspaceTransaction) {
  const workspaceId = Number(project.workspace_id), projectId = Number(project.id)
  if (!Number.isSafeInteger(projectId) || projectId < 1 || requireWorkspaceTransaction(workspaceId) !== tx) throw new Error('Matching active workspace transaction required')
  return createSqlDurableReplayStore({
    ...replayPolicy,
    dialect: tx.dialect,
    tables: { channels: 'support_replay_channels', events: 'support_replay_events' },
    scope: { workspace_id: workspaceId, project_id: projectId },
    async transaction(callback) {
      if (requireWorkspaceTransaction(workspaceId) !== tx) throw new Error('Matching active workspace transaction required')
      const selected = (await tx.query('SELECT id FROM support_projects WHERE id = ? AND workspace_id = ?', [projectId, workspaceId]))[0]
      if (!selected) throw new Error('Replay project does not belong to the locked workspace')
      return await callback(tx.query)
    },
  })
}

/** Only proven public message changes may advance a customer's observable activity. */
async function publicContact(project: Row, kind: string, payload: Row): Promise<number | undefined> {
  if (!['conversation.created', 'message.created'].includes(kind)) return
  const messageId = Number(payload.messageId), conversationId = Number(payload.conversationId)
  if (!Number.isSafeInteger(messageId) || messageId < 1 || !Number.isSafeInteger(conversationId) || conversationId < 1) return
  const row = await one("SELECT c.contact_id FROM support_messages m JOIN support_conversations c ON c.id = m.conversation_id AND c.project_id = m.project_id AND c.workspace_id = m.workspace_id WHERE m.id = ? AND c.id = ? AND m.project_id = ? AND m.workspace_id = ? AND m.visibility = 'public'", [messageId, conversationId, project.id, project.workspace_id])
  return row ? Number(row.contact_id) : undefined
}

/** Joins the mutation transaction; never enrolls a channel or schedules worker-side append. */
export async function appendSupportReplay(project: Row, outbox: Row, payload: Row) {
  const tx = requireWorkspaceTransaction(Number(project.workspace_id))
  const personId = await publicContact(project, String(outbox.kind), payload)
  const names = [agentReplayChannel(project), ...(personId ? [customerReplayChannel(project, personId)] : [])].sort()
  await appendEnrolledChanges(project, tx, names, String(outbox.event_id))
}

export async function appendRoutingReplay(project: Row, auditId: unknown) {
  const tx = requireWorkspaceTransaction(Number(project.workspace_id))
  await appendEnrolledChanges(project, tx, [agentReplayChannel(project)], `routing:${auditId}`)
}

async function appendEnrolledChanges(project: Row, tx: WorkspaceTransaction, names: string[], eventKey: string) {
  const store = supportReplayStore(project, tx)
  for (const channel of names) {
    const enrolled = (await tx.query('SELECT id FROM support_replay_channels WHERE workspace_id = ? AND project_id = ? AND name = ? AND lease_until > ?', [project.workspace_id, project.id, channel, Date.now()]))[0]
    if (!enrolled) continue
    await store.append({ channel, event: 'changed', data: null, idempotencyKey: eventKey })
    tx.afterCommit(async () => {
      // A lost hint cannot alter a cursor. Later finite replay recovers without Redis.
      try { await supportReplayInvalidations().publish(channel) }
      catch { /* Best-effort wakeup; the committed SQL event is the recovery source. */ }
    })
  }
}
