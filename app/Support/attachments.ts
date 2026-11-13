import { createHash } from 'node:crypto'
import { Storage } from '@stacksjs/storage'
import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import type { Plan } from './limits'
import { limitsFor } from './limits'
import { fail, identifier, text } from './errors'
import { conversation, entitled, secret } from './service'

function view(row: Row) {
  return { id: String(row.id), conversationId: String(row.conversation_id), fileName: String(row.file_name), mimeType: String(row.mime_type), bytes: Number(row.bytes), status: String(row.status) }
}

export async function attachment(project: Row, id: unknown, customer?: Row) {
  const row = await one('SELECT * FROM support_attachments WHERE id = ? AND project_id = ?', [identifier(id), project.id])
  if (!row || row.status === 'deleted') fail(404, 'not_found', 'Attachment not found.')
  await conversation(project, row.conversation_id, customer)
  return row
}

export async function upload(project: Row, conversationId: unknown, file: File, idempotencyKey: unknown, customer?: Row) {
  const workspaceId = Number(project.workspace_id), key = text(idempotencyKey, 'idempotencyKey', 200)
  const owner = await entitled(workspaceId), limits = limitsFor(owner.plan as Plan)
  if (file.size <= 0 || (limits.fileBytes !== null && file.size > limits.fileBytes)) fail(413, 'file_limit', 'Attachment exceeds the per-file allowance.')
  await conversation(project, conversationId, customer)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const hash = createHash('sha256').update(bytes).digest('hex'), lease = secret()
  const disk = process.env.SUPPORT_STORAGE_DISK || Storage.getDefaultDisk()
  if (disk === 'public') fail(503, 'private_storage_required', 'Configure a private attachment disk.')
  const row = await workspaceTransaction(workspaceId, async () => {
    const workspace = await entitled(workspaceId), quota = limitsFor(workspace.plan as Plan)
    const existing = await one('SELECT * FROM support_attachments WHERE project_id = ? AND idempotency_key = ?', [project.id, key])
    if (existing) {
      if (existing.sha256 !== hash || Number(existing.conversation_id) !== identifier(conversationId)) fail(409, 'idempotency_conflict', 'Attachment key was used with different content.')
      if (existing.status === 'stored') return existing
      if (!['reserved', 'failed'].includes(String(existing.status))) fail(409, 'attachment_state', 'Attachment is no longer writable.')
      if (Number(existing.lease_until) > Date.now()) fail(409, 'upload_in_progress', 'This attachment is already uploading. Retry shortly.')
    }
    const charge = !existing || existing.status === 'failed'
    if (charge && quota.storageBytes !== null && Number(workspace.storage_bytes) + bytes.byteLength > quota.storageBytes) fail(402, 'storage_limit', 'Attachment storage allowance reached.')
    if (charge) await query('UPDATE support_workspaces SET storage_bytes = storage_bytes + ? WHERE id = ?', [bytes.byteLength, workspaceId])
    if (existing) {
      await query("UPDATE support_attachments SET status = 'reserved', lease_token = ?, lease_until = ?, updated_at = ? WHERE id = ?", [lease, Date.now() + 120000, new Date().toISOString(), existing.id])
      return (await one('SELECT * FROM support_attachments WHERE id = ?', [existing.id]))!
    }
    return await insert('support_attachments', { workspace_id: workspaceId, project_id: project.id, conversation_id: identifier(conversationId), storage_key: `support/${workspace.public_id}/${project.public_id}/${crypto.randomUUID()}`, file_name: file.name.replace(/[\r\n\\/\x00-\x1F]/g, '_').slice(0, 255) || 'attachment', mime_type: file.type.slice(0, 200) || 'application/octet-stream', bytes: bytes.byteLength, status: 'reserved', idempotency_key: key, sha256: hash, storage_disk: disk, lease_token: lease, lease_until: Date.now() + 120000 })
  })
  if (row.status === 'stored') return { attachment: view(row) }
  try {
    const stored = await Storage.disk(String(row.storage_disk)).write(String(row.storage_key), bytes)
    if (stored.size !== bytes.byteLength) throw new Error('Attachment byte count mismatch')
    await workspaceTransaction(workspaceId, async () => {
      await query("UPDATE support_attachments SET status = 'stored', lease_until = 0, updated_at = ? WHERE id = ? AND lease_token = ? AND status = 'reserved'", [new Date().toISOString(), row.id, lease])
    })
    const completed = await one('SELECT * FROM support_attachments WHERE id = ? AND lease_token = ?', [row.id, lease])
    if (!completed || completed.status !== 'stored') fail(409, 'upload_lease_lost', 'Upload ownership changed. Retry with the same idempotency key.')
    return { attachment: view(completed) }
  }
  catch (error) {
    // Keep uncertain writes charged and recoverable until an explicit retry or cleanup.
    await query('UPDATE support_attachments SET lease_until = 0 WHERE id = ? AND lease_token = ?', [row.id, lease])
    throw error
  }
}

export async function download(project: Row, id: unknown, customer?: Row) {
  const row = await attachment(project, id, customer)
  if (row.status !== 'stored') fail(409, 'attachment_pending', 'Attachment upload is not complete.')
  const bytes = await Storage.disk(String(row.storage_disk)).readToBuffer(String(row.storage_key))
  if (bytes.byteLength !== Number(row.bytes)) fail(503, 'attachment_unavailable', 'Stored attachment size could not be verified.')
  return new Response(new Uint8Array(bytes).buffer, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(String(row.file_name))}`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, no-store' } })
}

export async function remove(project: Row, id: unknown) {
  const row = await attachment(project, id)
  await workspaceTransaction(Number(project.workspace_id), async () => {
    const current = await attachment(project, id)
    if (!['stored', 'deleting'].includes(String(current.status)) || Number(current.lease_until) > Date.now()) fail(409, 'upload_in_progress', 'Complete or recover the upload before removing it.')
    await query("UPDATE support_attachments SET status = 'deleting' WHERE id = ? AND project_id = ?", [row.id, project.id])
  })
  const disk = Storage.disk(String(row.storage_disk))
  if (await disk.fileExists(String(row.storage_key))) await disk.deleteFile(String(row.storage_key))
  if (await disk.fileExists(String(row.storage_key))) fail(503, 'storage_delete_failed', 'Attachment deletion could not be verified.')
  await workspaceTransaction(Number(project.workspace_id), async () => {
    const current = await one('SELECT * FROM support_attachments WHERE id = ?', [row.id])
    if (current?.status === 'deleting') {
      await query("UPDATE support_attachments SET status = 'deleted', updated_at = ? WHERE id = ?", [new Date().toISOString(), row.id])
      await query('UPDATE support_workspaces SET storage_bytes = storage_bytes - ? WHERE id = ?', [row.bytes, project.workspace_id])
    }
  })
  return { removed: true }
}
