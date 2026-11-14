import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { digest, enqueue, issueKeys, member, secret } from './service'

const roles = ['owner', 'admin']
function keyView(row: Row) {
  return { id: String(row.id), scope: String(row.scope), status: Number(row.revoked_at) ? 'revoked' : 'active', revokedAt: Number(row.revoked_at), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at) }
}
async function scopedKey(project: Row, id: unknown): Promise<Row> {
  const row = await one('SELECT id, scope, created_at, revoked_at FROM support_api_keys WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])
  if (!row) fail(404, 'key_not_found', 'Project key not found.')
  return row
}
export async function listProjectKeys(project: Row, userId: number, cursor?: unknown) {
  await member(userId, Number(project.workspace_id), roles)
  const before = cursor === undefined || cursor === null ? Number.MAX_SAFE_INTEGER : identifier(cursor)
  const rows = await query('SELECT id, scope, created_at, revoked_at FROM support_api_keys WHERE project_id = ? AND workspace_id = ? AND id < ? ORDER BY id DESC LIMIT 201', [project.id, project.workspace_id, before])
  const page = rows.slice(0, 200)
  return { keys: page.map(keyView), nextCursor: rows.length > 200 ? String(page[page.length - 1]!.id) : null, limit: 200 }
}
async function previousOperation(project: Row, operation: string, operationId: string, fingerprint: string) {
  const previous = await one('SELECT fingerprint, response FROM support_idempotency WHERE project_id = ? AND workspace_id = ? AND operation = ? AND key = ?', [project.id, project.workspace_id, operation, operationId])
  if (!previous) return undefined
  if (previous.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'This operation ID was used with different input.')
  return JSON.parse(String(previous.response)) as { keyIds: string[], replacedKeyId?: string }
}
async function recordOperation(project: Row, operation: string, operationId: string, fingerprint: string, metadata: { keyIds: string[], replacedKeyId?: string }) {
  // Raw keys never enter the generic replay response table, even encrypted.
  await insert('support_idempotency', { workspace_id: project.workspace_id, project_id: project.id, operation, key: operationId, fingerprint, response: JSON.stringify(metadata) })
}
export async function createProjectKeys(project: Row, userId: number, requestId?: unknown) {
  const operationId = requestId === undefined ? crypto.randomUUID() : text(requestId, 'idempotencyKey', 200), operation = `key.create:${userId}`, fingerprint = digest(`key.create:${project.id}:${userId}`)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), roles)
    const previous = await previousOperation(project, operation, operationId, fingerprint)
    if (previous) return { issuedKeys: await Promise.all(previous.keyIds.map(async id => keyView(await scopedKey(project, id)))), operationId, revealed: false, replayed: true, recovery: 'Rotate an active key with a new operation ID. The original secret cannot be recovered.' }
    const keys = await issueKeys(project)
    const rows = await query('SELECT id, scope, created_at, revoked_at FROM support_api_keys WHERE project_id = ? AND workspace_id = ? AND digest IN (?, ?) ORDER BY id', [project.id, project.workspace_id, digest(keys.ingestKey), digest(keys.readKey)])
    await recordOperation(project, operation, operationId, fingerprint, { keyIds: rows.map(row => String(row.id)) })
    await enqueue(project, 'api_keys.created', { actorId: userId, keyIds: rows.map(row => String(row.id)) })
    return { ...keys, issuedKeys: rows.map(keyView), operationId, revealed: true, replayed: false }
  })
}
export async function revokeProjectKey(project: Row, id: unknown, userId: number) {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), roles)
    const key = await scopedKey(project, id)
    if (!Number(key.revoked_at)) {
      await query('UPDATE support_api_keys SET revoked_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND workspace_id = ? AND revoked_at = 0', [Date.now(), new Date().toISOString(), key.id, project.id, project.workspace_id])
      await enqueue(project, 'api_key.revoked', { actorId: userId, keyId: String(key.id) })
    }
    return { key: keyView(await scopedKey(project, id)) }
  })
}
export async function rotateProjectKey(project: Row, id: unknown, userId: number, input: Row) {
  const operationId = text(input.idempotencyKey, 'idempotencyKey', 200), keyId = identifier(id), operation = `key.rotate:${userId}:${keyId}`, fingerprint = digest(`key.rotate:${project.id}:${keyId}:${userId}`)
  if (Object.keys(input).some(key => key !== 'idempotencyKey')) fail(422, 'rotation_input_invalid', 'Rotation retains the current scope. Supply only idempotencyKey.')
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), roles)
    const previous = await previousOperation(project, operation, operationId, fingerprint)
    if (previous) return { key: keyView(await scopedKey(project, previous.keyIds[0])), replacedKeyId: previous.replacedKeyId, operationId, revealed: false, replayed: true, recovery: 'Rotate this replacement key with a new operation ID if the first response was lost. Secrets are never replayed.' }
    const current = await scopedKey(project, keyId)
    if (Number(current.revoked_at)) fail(409, 'key_already_revoked', 'A revoked key cannot be rotated again. Rotate an active key or issue a new pair.')
    if (!['read', 'write'].includes(String(current.scope))) fail(409, 'key_scope_invalid', 'Only read and write project keys can be rotated.')
    const key = secret(), replacement = await insert('support_api_keys', { workspace_id: project.workspace_id, project_id: project.id, digest: digest(key), scope: current.scope })
    await query('UPDATE support_api_keys SET revoked_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND workspace_id = ? AND revoked_at = 0', [Date.now(), new Date().toISOString(), current.id, project.id, project.workspace_id])
    await recordOperation(project, operation, operationId, fingerprint, { keyIds: [String(replacement.id)], replacedKeyId: String(current.id) })
    await enqueue(project, 'api_key.rotated', { actorId: userId, keyId: String(current.id), replacementKeyId: String(replacement.id) })
    return { key: keyView(replacement), secret: key, replacedKeyId: String(current.id), operationId, revealed: true, replayed: false }
  })
}
export async function revokeContactSessions(project: Row, contactId: unknown, userId: number) {
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), roles)
    const person = await one('SELECT id FROM support_contacts WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(contactId), project.id, project.workspace_id])
    if (!person) fail(404, 'contact_not_found', 'Project customer not found.')
    const at = Date.now(), active = Number((await one('SELECT COUNT(*) AS total FROM support_customer_sessions WHERE project_id = ? AND workspace_id = ? AND contact_id = ? AND expires_at > ?', [project.id, project.workspace_id, person.id, at]))!.total)
    await query('UPDATE support_customer_sessions SET expires_at = ?, updated_at = ? WHERE project_id = ? AND workspace_id = ? AND contact_id = ? AND expires_at > ?', [at, new Date(at).toISOString(), project.id, project.workspace_id, person.id, at])
    if (active) await enqueue(project, 'customer_sessions.revoked', { actorId: userId, contactId: String(person.id), count: active })
    return { revoked: active }
  })
}
export async function revokeOwnCustomerSession(project: Row, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) fail(401, 'invalid_session', 'A customer session credential is required.')
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const session = await one('SELECT id, contact_id, expires_at FROM support_customer_sessions WHERE project_id = ? AND workspace_id = ? AND digest = ?', [project.id, project.workspace_id, digest(token)])
    if (!session) fail(401, 'invalid_session', 'Customer session is invalid.')
    const at = Date.now()
    if (Number(session.expires_at) > at) {
      await query('UPDATE support_customer_sessions SET expires_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND workspace_id = ?', [at, new Date(at).toISOString(), session.id, project.id, project.workspace_id])
      await enqueue(project, 'customer_session.revoked', { contactId: String(session.contact_id), sessionId: String(session.id), source: 'customer' })
    }
    return { revoked: true }
  })
}
