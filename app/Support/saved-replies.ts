import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { idempotent, member } from './service'

const pageSize = 50
const searchName = (name: string) => name.normalize('NFKC').toLowerCase()

function replyView(row: Row) {
  return { id: String(row.id), name: String(row.name), body: String(row.body), revision: Number(row.revision) }
}

export async function listSavedReplies(project: Row, userId: number, search: URLSearchParams) {
  const name = search.get('q')?.trim() ?? ''
  if (name.length > 120) fail(422, 'invalid_input', 'Search must be at most 120 characters.')
  const cursor = search.get('cursor')
  const parameters: unknown[] = [project.workspace_id, project.id, userId]
  if (cursor !== null) parameters.push(identifier(cursor))
  if (name) parameters.push(`%${searchName(name).replace(/[~%_]/g, value => '~' + value)}%`)
  parameters.push(pageSize + 1)
  const rows = await query(`
    SELECT r.id, r.name, r.body, r.revision FROM support_saved_replies r
    WHERE r.workspace_id = ? AND r.project_id = ? AND r.archived = false
    AND EXISTS (
      SELECT 1 FROM support_memberships m
      WHERE m.workspace_id = r.workspace_id AND m.user_id = ? AND m.status = 'active'
    )
    ${cursor === null ? '' : 'AND r.id < ?'}
    ${name ? "AND r.search_name LIKE ? ESCAPE '~'" : ''}
    ORDER BY r.id DESC LIMIT ?
  `, parameters)
  const replies = rows.slice(0, pageSize).map(replyView)
  return { replies, nextCursor: rows.length > pageSize ? replies.at(-1)!.id : null }
}

type SavedReplyChange =
  | { type: 'create', input: Row }
  | { type: 'update', id: unknown, input: Row }
  | { type: 'archive', id: unknown }

function replyFields(input: Row) {
  const name = text(input.name, 'name', 120)
  return { name, search_name: searchName(name), body: text(input.body, 'body', 10000) }
}

export async function changeSavedReply(project: Row, userId: number, change: SavedReplyChange) {
  const workspaceId = Number(project.workspace_id)
  return await workspaceTransaction(workspaceId, async () => {
    await member(userId, workspaceId, ['owner', 'admin'])
    if (change.type === 'create') {
      const fields = replyFields(change.input)
      return await idempotent(project, `saved-reply.create:${userId}`, change.input.idempotencyKey, fields, async () => {
        const row = await insert('support_saved_replies', { workspace_id: workspaceId, project_id: project.id, ...fields })
        return { reply: replyView(row) }
      })
    }

    const key = [identifier(change.id), workspaceId, project.id]
    const current = await one('SELECT archived, revision FROM support_saved_replies WHERE id = ? AND workspace_id = ? AND project_id = ?', key)
    if (!current) fail(404, 'not_found', 'Saved reply not found.')
    if (change.type === 'archive') {
      if (!current.archived) await query('UPDATE support_saved_replies SET archived = true, updated_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ?', [new Date().toISOString(), ...key])
      return { archived: true }
    }
    const revision = identifier(change.input.revision)
    const { name, body, search_name: searchableName } = replyFields(change.input)
    return await idempotent(project, `saved-reply.update:${key[0]}:${userId}`, change.input.idempotencyKey, { name, body, revision }, async () => {
      if (current.archived) fail(404, 'not_found', 'Saved reply not found.')
      if (Number(current.revision) !== revision) fail(409, 'saved_reply_changed', 'This saved reply was updated. Load the latest version before saving.')
      const saved = await one('UPDATE support_saved_replies SET name = ?, search_name = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ? AND project_id = ? RETURNING id, name, body, revision', [name, searchableName, body, new Date().toISOString(), ...key])
      return { reply: replyView(saved!) }
    })
  })
}
