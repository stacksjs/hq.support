import type { Row } from './database'
import { one, query } from './database'
import { fail } from './errors'
import { conversation, createConversation, enqueue } from './service'
import { routeConversation } from './routing'

export const customerReopenWindowMs = 7 * 86400000
/** Caller owns the workspace transaction. Never follow unscoped or unbounded lineage. */
export async function admitCustomerReply(project: Row, original: Row, customer: Row, input: Row, mediaOnly = false, receivedAt?: number) {
  const now = Date.now(), acceptedAt = receivedAt ?? now
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0 || acceptedAt > now) fail(422, 'invalid_acceptance_time', 'The server acceptance time could not be verified. Retry this operation.')
  let row = original
  const visited = new Set<number>()
  for (let depth = 0; ; depth++) {
    if (depth >= 64 || visited.has(Number(row.id))) fail(409, 'conversation_lineage_invalid', 'Request history cannot be safely followed. Contact the support team.')
    visited.add(Number(row.id))
    if (Number(row.workspace_id) !== Number(project.workspace_id) || Number(row.contact_id) !== Number(customer.id)) fail(404, 'not_found', 'Conversation not found.')
    if (!row.continuation_id) break
    const next = await conversation(project, row.continuation_id, customer)
    if (Number(next.continued_from_id) !== Number(row.id)) fail(409, 'conversation_lineage_invalid', 'Request history cannot be safely followed. Contact the support team.')
    row = next
  }
  if (row.status === 'closed' && Number(row.resolved_at) > 0 && acceptedAt - Number(row.resolved_at) > customerReopenWindowMs) {
    const created = await createConversation(project, { externalId: customer.external_id }, { body: input.body, subject: row.subject, idempotencyKey: `continued:${row.id}` }, customer, undefined, { mediaOnly, continuedFrom: row })
    const destination = await conversation(project, created.conversation.id, customer)
    await query('UPDATE support_conversations SET continuation_id = ? WHERE id = ? AND workspace_id = ? AND project_id = ? AND continuation_id IS NULL', [destination.id, row.id, project.workspace_id, project.id])
    await enqueue(project, 'conversation.continued', { conversationId: destination.id, previousConversationId: row.id, customerId: customer.id, acceptedAt })
    const first = await one('SELECT * FROM support_messages WHERE workspace_id = ? AND project_id = ? AND conversation_id = ? ORDER BY id ASC LIMIT 1', [project.workspace_id, project.id, destination.id])
    if (!first) throw new Error('Admitted continuation has no first message')
    return { row: destination, first, previousConversationId: String(row.id) }
  }
  if (row.status !== 'open') {
    const grandfathered = row.status === 'closed' && Number(row.resolved_at) === 0
    await routeConversation(project, row.id, { status: 'open' }, { source: 'ingress' })
    await enqueue(project, 'conversation.reopened', { conversationId: row.id, customerId: customer.id, previousStatus: row.status, grandfathered, acceptedAt })
    row = await conversation(project, row.id, customer)
  }
  return { row, first: undefined, previousConversationId: undefined }
}
