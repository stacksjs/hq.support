import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { conversationChannelThread } from './channel-history'
import { fail, identifier } from './errors'
import { routeConversation } from './routing'
import { assertConversationWritable, conversation, enqueue, idempotent, member } from './service'

const mergeView = (row: Row) => ({
  id: String(row.id),
  primaryId: String(row.primary_id),
  secondaryId: String(row.secondary_id),
})

function authorizePair(actor: Row, userId: number, ...rows: Row[]) {
  if (['owner', 'admin'].includes(String(actor.role))) return
  if (actor.role !== 'agent' || rows.some(row => ![0, userId].includes(Number(row.assignee_id))))
    fail(403, 'merge_forbidden', 'Ask a workspace owner or admin to consolidate conversations assigned to another agent.')
}

async function eligible(project: Row, row: Row) {
  if (row.channel !== 'widget' || row.continuation_id || await conversationChannelThread(project, row.id))
    fail(409, 'merge_ineligible', 'Choose a Messenger conversation without a newer or linked provider thread.')
  const ticket = await one('SELECT id FROM support_tickets WHERE workspace_id = ? AND project_id = ? AND conversation_id = ?', [project.workspace_id, project.id, row.id])
  if (ticket) fail(409, 'merge_ineligible', 'Conversations with a linked ticket must be handled through the ticket.')
  const pendingAnswer = await one("SELECT id FROM support_ai_runs WHERE workspace_id = ? AND project_id = ? AND conversation_id = ? AND status = 'pending' AND lease_until > ?", [project.workspace_id, project.id, row.id, Date.now()])
  if (pendingAnswer) fail(409, 'merge_busy', 'Wait for the active AI answer before consolidating this conversation.')
}

export async function activeConversationMerge(project: Row, secondary: Row) {
  const merged = await one('SELECT * FROM support_conversation_merges WHERE workspace_id = ? AND project_id = ? AND secondary_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1', [project.workspace_id, project.id, secondary.id])
  if (!merged || String(merged.primary_id) !== String(secondary.merged_into_id))
    fail(409, 'merge_history_invalid', 'The conversation consolidation could not be verified.')
  return merged
}

export async function conversationMergeDetails(project: Row, row: Row, before?: string) {
  if (row.merged_into_id) return { primary: mergeView(await activeConversationMerge(project, row)) }
  const scope = [project.workspace_id, project.id, row.id]
  const rows = await query(`SELECT id, primary_id, secondary_id FROM support_conversation_merges WHERE workspace_id = ? AND project_id = ? AND primary_id = ? AND undone_at IS NULL${before ? ' AND id < ?' : ''} ORDER BY id DESC LIMIT 51`, before ? [...scope, identifier(before)] : scope)
  if (!rows.length && before === undefined) return
  const duplicates = rows.slice(0, 50).map(mergeView)
  return { duplicates, nextCursor: rows.length > 50 ? duplicates.at(-1)!.id : null }
}

export async function mergeConversation(project: Row, reference: unknown, input: Row, userId: number) {
  const secondaryId = identifier(reference), primaryId = identifier(input.primaryConversationId)
  if (secondaryId === primaryId) fail(422, 'merge_same_conversation', 'Choose a different conversation.')
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const actor = await member(userId, Number(project.workspace_id), ['owner', 'admin', 'agent'])
    return await idempotent(project, `merge:${secondaryId}:${userId}`, input.idempotencyKey, { primaryId }, async () => {
      const secondary = await conversation(project, secondaryId), primary = await conversation(project, primaryId)
      authorizePair(actor, userId, primary, secondary)
      if (String(primary.contact_id) !== String(secondary.contact_id))
        fail(422, 'merge_contact_mismatch', 'Choose another conversation for the same customer.')
      const contact = await one('SELECT id FROM support_contacts WHERE id = ? AND workspace_id = ? AND project_id = ?', [primary.contact_id, project.workspace_id, project.id])
      if (!contact) fail(404, 'not_found', 'Customer not found.')
      assertConversationWritable(primary)
      assertConversationWritable(secondary)
      if (await one('SELECT id FROM support_conversation_merges WHERE workspace_id = ? AND project_id = ? AND primary_id = ? AND undone_at IS NULL', [project.workspace_id, project.id, secondary.id]))
        fail(409, 'merge_has_duplicates', 'Undo existing duplicates before consolidating this conversation.')
      await eligible(project, primary)
      await eligible(project, secondary)

      const merge = await insert('support_conversation_merges', {
        workspace_id: project.workspace_id,
        project_id: project.id,
        primary_id: primary.id,
        secondary_id: secondary.id,
        merged_by: userId,
        previous_status: secondary.status,
        previous_routing_reason: secondary.routing_reason,
        previous_snoozed_until: secondary.snoozed_until,
      })
      await query("UPDATE support_conversations SET merged_into_id = ?, status = 'closed', snoozed_until = NULL, routing_reason = 'duplicate_conversation', updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ?", [primary.id, new Date().toISOString(), project.workspace_id, project.id, secondary.id])
      await enqueue(project, 'conversation.merged', { conversationId: secondary.id, primaryConversationId: primary.id, mergeId: merge.id })
      return { merge: mergeView(merge) }
    })
  })
}

export async function undoConversationMerge(project: Row, reference: unknown, input: Row, userId: number) {
  const secondaryId = identifier(reference), mergeId = identifier(input.mergeId)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const actor = await member(userId, Number(project.workspace_id), ['owner', 'admin', 'agent'])
    return await idempotent(project, `undo-merge:${secondaryId}:${userId}`, input.idempotencyKey, { mergeId }, async () => {
      const secondary = await conversation(project, secondaryId)
      if (!secondary.merged_into_id) fail(409, 'merge_already_undone', 'This conversation is already separate.')
      const active = await activeConversationMerge(project, secondary)
      if (Number(active.id) !== mergeId) fail(409, 'merge_changed', 'The consolidation changed. Refresh before undoing it.')
      const primary = await conversation(project, active.primary_id)
      authorizePair(actor, userId, primary, secondary)

      const snooze = active.previous_snoozed_until === null ? null : Number(active.previous_snoozed_until)
      const reopen = active.previous_status === 'open' || (active.previous_status === 'snoozed' && snooze !== null && snooze <= Date.now())
      await query('UPDATE support_conversations SET merged_into_id = NULL, status = ?, snoozed_until = ?, routing_reason = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ?', [reopen ? 'closed' : active.previous_status, reopen ? null : snooze, active.previous_routing_reason, new Date().toISOString(), project.workspace_id, project.id, secondary.id])
      if (reopen)
        await routeConversation(project, secondary.id, { status: 'open' }, { source: 'ingress' })
      await query('UPDATE support_conversation_merges SET undone_at = ?, undone_by = ?, updated_at = ? WHERE workspace_id = ? AND project_id = ? AND id = ? AND undone_at IS NULL', [Date.now(), userId, new Date().toISOString(), project.workspace_id, project.id, active.id])
      await enqueue(project, 'conversation.merge_undone', { conversationId: secondary.id, primaryConversationId: primary.id, mergeId: active.id })
      return { merge: mergeView(active), undone: true }
    })
  })
}
