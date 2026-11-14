import type { Row } from './database'
import { insert, one } from './database'
import { conversation } from './service'
import { fail, identifier } from './errors'

/** Caller owns the workspace transaction. Bindings never retarget old operations. */
export async function bindChannelConversation(project: Row, thread: Row, id: unknown) {
  const row = await conversation(project, id)
  if (Number(row.workspace_id) !== Number(project.workspace_id) || Number(thread.workspace_id) !== Number(project.workspace_id) || Number(thread.project_id) !== Number(project.id) || Number(thread.contact_id) !== Number(row.contact_id)) fail(409, 'channel_thread_identity', 'Channel history belongs to a different customer or workspace.')
  const existing = await one('SELECT * FROM support_channel_conversations WHERE workspace_id = ? AND project_id = ? AND channel_id = ? AND conversation_id = ?', [project.workspace_id, project.id, thread.channel_id, row.id])
  if (existing && Number(existing.thread_id) !== Number(thread.id)) fail(409, 'channel_thread_identity', 'This request already belongs to a different provider thread.')
  if (!existing) await insert('support_channel_conversations', { workspace_id: project.workspace_id, project_id: project.id, channel_id: thread.channel_id, thread_id: thread.id, conversation_id: row.id })
}
/** Return the selected historical request context, not the mutable inbound pointer. */
export async function conversationChannelThread(project: Row, id: unknown, channelId?: unknown): Promise<Row | undefined> {
  const conversationId = identifier(id)
  const selectedChannel = channelId === undefined ? [] : [identifier(channelId)]
  const thread = await one(`SELECT t.* FROM support_channel_threads t WHERE t.workspace_id = ? AND t.project_id = ?${channelId === undefined ? '' : ' AND t.channel_id = ?'} AND (t.conversation_id = ? OR EXISTS (SELECT 1 FROM support_channel_conversations h WHERE h.workspace_id = t.workspace_id AND h.project_id = t.project_id AND h.channel_id = t.channel_id AND h.thread_id = t.id AND h.conversation_id = ?)) ORDER BY t.id ASC LIMIT 1`, [project.workspace_id, project.id, ...selectedChannel, conversationId, conversationId])
  if (!thread) return undefined
  const row = await conversation(project, conversationId)
  if (Number(row.workspace_id) !== Number(project.workspace_id) || Number(row.contact_id) !== Number(thread.contact_id)) fail(409, 'channel_thread_identity', 'Channel history belongs to a different customer or workspace.')
  return { ...thread, conversation_id: row.id }
}
/** Durable delivery target is the immutable message row, including legacy deliveries. */
export async function deliveryChannelThread(project: Row, delivery: Row): Promise<Row> {
  const message = await one('SELECT * FROM support_messages WHERE id = ? AND project_id = ? AND workspace_id = ?', [delivery.message_id, project.id, project.workspace_id])
  const thread = await one('SELECT * FROM support_channel_threads WHERE id = ? AND channel_id = ? AND project_id = ? AND workspace_id = ?', [delivery.thread_id, delivery.channel_id, project.id, project.workspace_id])
  if (!message || !thread || Number(message.contact_id) !== Number(thread.contact_id)) fail(409, 'channel_delivery_target_missing', 'The original provider delivery target is unavailable.')
  const row = await conversation(project, message.conversation_id)
  if (Number(row.workspace_id) !== Number(project.workspace_id) || Number(row.contact_id) !== Number(thread.contact_id)) fail(409, 'channel_delivery_target_missing', 'The original provider delivery target is unavailable.')
  return { ...thread, conversation_id: message.conversation_id }
}
