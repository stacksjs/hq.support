import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { identifier, fail } from './errors'
import { conversation } from './service'

export async function unreadCount(project: Row, conversationId: unknown, userId: number) {
  return Number((await one("SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ? AND conversation_id = ? AND author_type = 'customer' AND visibility = 'public' AND id > COALESCE((SELECT last_message_id FROM support_conversation_reads WHERE conversation_id = ? AND user_id = ?), 0)", [project.id, identifier(conversationId), identifier(conversationId), userId]))?.count ?? 0)
}
export async function markRead(project: Row, conversationId: unknown, userId: number, lastMessageId: unknown) {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const selected = await conversation(project, conversationId), last = identifier(lastMessageId)
    const message = await one('SELECT id FROM support_messages WHERE id = ? AND project_id = ? AND conversation_id = ?', [last, project.id, selected.id])
    if (!message) fail(422, 'invalid_message', 'Read cursor must name a message in this conversation.')
    const current = await one('SELECT * FROM support_conversation_reads WHERE conversation_id = ? AND user_id = ?', [selected.id, userId])
    const cursor = Math.max(Number(current?.last_message_id || 0), last)
    if (current) await query('UPDATE support_conversation_reads SET last_message_id = ?, updated_at = ? WHERE id = ?', [cursor, new Date().toISOString(), current.id])
    else await insert('support_conversation_reads', { workspace_id: project.workspace_id, project_id: project.id, conversation_id: selected.id, user_id: userId, last_message_id: cursor })
    return { read: true, lastMessageId: String(cursor), unreadCount: await unreadCount(project, selected.id, userId) }
  })
}
