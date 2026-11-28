import { createHash } from 'node:crypto'
import { Storage } from '@stacksjs/storage'
import type { Row } from './database'
import { insert, one, query, requireWorkspaceTransaction } from './database'
import { fail } from './errors'
import { intercomBundleLimits } from './intercom-bundle'
import type { Plan } from './limits'
import { limitsFor } from './limits'
import { entitled, object } from './service'

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const importAttachmentLimit = intercomBundleLimits.attachmentFiles
export const importAttachmentBytes = 10_000_000

interface SuppliedFile {
  bytes: Uint8Array
  sha256: string
}

export interface ImportAttachment extends SuppliedFile {
  key: string
  name: string
  mimeType: string
  visibility: 'public' | 'private'
}

export interface ImportArchive {
  disk: string
  key: string
}

export function importAttachmentVerification(archive?: ImportArchive) {
  return { archive, verified: new Set<string>(), attemptedFiles: 0, attemptedBytes: 0 }
}
export type ImportAttachmentVerification = ReturnType<typeof importAttachmentVerification>

export function parseImportAttachmentFiles(value: unknown): Map<string, SuppliedFile> {
  const files = new Map<string, SuppliedFile>()
  if (value === undefined) return files
  if (!Array.isArray(value) || value.length > importAttachmentLimit)
    fail(422, 'invalid_attachment_files', 'Supply at most 100 attachment files in the migration bundle.')
  for (const item of value) {
    const { url, sha256, data } = object(item)
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 4096 || files.has(url) || typeof data !== 'string' || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256))
      fail(422, 'invalid_attachment_file', 'Each attachment file requires a unique source URL, base64 data and a lowercase SHA-256 checksum.')
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.toString('base64') !== data || hash(bytes) !== sha256)
      fail(422, 'attachment_checksum_mismatch', 'Supplied attachment bytes do not match the base64 data and SHA-256 checksum.')
    files.set(url, { bytes, sha256 })
  }
  return files
}

export function sourceAttachments(source: Row, sourceId: string, files: Map<string, SuppliedFile>, visibility: 'public' | 'internal'): ImportAttachment[] {
  if (source.attachments == null) return []
  if (!Array.isArray(source.attachments) || source.attachments.length > 10)
    fail(422, 'source_attachment_limit', 'Review messages with more than ten attachments or invalid attachment metadata.')
  return source.attachments.map((value, index) => {
    const metadata = object(value)
    const file = typeof metadata.url === 'string' ? files.get(metadata.url) : undefined
    if (!file) fail(422, 'source_attachments_pending', 'Supply the attachment bytes for the source URL. HQ.support does not fetch attachment URLs.')
    if (metadata.filesize != null && metadata.filesize !== file.bytes.byteLength)
      fail(422, 'source_attachment_size_mismatch', 'The supplied bytes do not match the attachment size reported by Intercom.')
    const name = typeof metadata.name === 'string' ? metadata.name : ''
    const mimeType = typeof metadata.content_type === 'string' ? metadata.content_type : ''
    return {
      ...file,
      key: 'intercom:' + hash(JSON.stringify([sourceId, index])),
      name: name.replace(/[\r\n\\/\x00-\x1F]/g, '_').slice(0, 255) || 'attachment',
      mimeType: mimeType.slice(0, 200) || 'application/octet-stream',
      visibility: visibility === 'public' ? 'public' : 'private',
    }
  })
}

export async function checkImportedAttachments(project: Row, conversation: Row, files: ImportAttachment[], verification: ImportAttachmentVerification) {
  for (const file of files) {
    const row = await one("SELECT sha256, storage_disk, storage_key FROM support_attachments WHERE project_id = ? AND conversation_id = ? AND idempotency_key = ? AND status = 'stored'", [project.id, conversation.id, file.key])
    if (!row || row.sha256 !== file.sha256)
      fail(409, 'import_target_missing', 'A previously imported attachment is missing. Review native erasure or storage before importing again.')
    const key = String(row.storage_key)
    if (!verification.archive && key.startsWith('support-import-preview/')) continue
    const diskName = String(row.storage_disk)
    const identity = JSON.stringify([diskName, key, file.bytes.byteLength, file.sha256])
    if (verification.verified.has(identity)) continue
    if (verification.attemptedFiles >= importAttachmentLimit || verification.attemptedBytes + file.bytes.byteLength > importAttachmentBytes)
      fail(422, 'source_attachment_limit', 'Split the export into smaller bundles to verify existing attachment bytes.')
    verification.attemptedFiles++
    verification.attemptedBytes += file.bytes.byteLength
    const disk = Storage.disk(diskName)
    if (!await disk.fileExists(key))
      fail(409, 'import_target_missing', 'A previously imported attachment is missing from private storage.')
    if (await disk.fileSize(key) !== file.bytes.byteLength || await disk.checksum(key, { algorithm: 'sha256' }) !== file.sha256)
      fail(409, 'import_attachment_changed', 'A previously imported attachment differs from the verified source. Restore the original bytes before resuming.')
    verification.verified.add(identity)
  }
}

export async function storeImportedAttachments(project: Row, conversation: Row, files: ImportAttachment[], archive?: ImportArchive) {
  if (!files.length) return
  const workspaceId = Number(project.workspace_id)
  requireWorkspaceTransaction(workspaceId)
  const workspace = await entitled(workspaceId), limits = limitsFor(workspace.plan as Plan)
  const bytes = files.reduce((total, file) => total + file.bytes.byteLength, 0)
  const fileLimit = limits.fileBytes
  if (fileLimit !== null && files.some(file => file.bytes.byteLength > fileLimit))
    fail(413, 'file_limit', 'An imported attachment exceeds the per-file allowance.')
  if (limits.storageBytes !== null && Number(workspace.storage_bytes) + bytes > limits.storageBytes)
    fail(402, 'storage_limit', 'Attachment storage allowance reached.')
  const disk = archive?.disk ?? (process.env.SUPPORT_STORAGE_DISK || Storage.getDefaultDisk())
  if (disk === 'public') fail(503, 'private_storage_required', 'Imported attachments require private storage.')
  const prefix = archive?.key ?? `support-import-preview/${project.id}`
  const alreadyStored = await one('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM support_attachments WHERE project_id = ? AND storage_key LIKE ?', [project.id, `${prefix}.attachments/%`])
  if (Number(alreadyStored?.count) + files.length > importAttachmentLimit || Number(alreadyStored?.bytes) + bytes > importAttachmentBytes)
    fail(422, 'source_attachment_limit', 'Split the export into smaller bundles. Expanded attachment transfers cannot exceed 100 files or 10 MB per bundle.')
  await query('UPDATE support_workspaces SET storage_bytes = storage_bytes + ? WHERE id = ?', [bytes, workspaceId])
  const objects: { storageKey: string, bytes: Uint8Array }[] = []
  for (const file of files) {
    const storageKey = `${prefix}.attachments/${file.key.slice('intercom:'.length)}`
    await insert('support_attachments', {
      workspace_id: workspaceId, project_id: project.id, conversation_id: conversation.id, contact_id: 0,
      idempotency_key: file.key, storage_key: storageKey, storage_disk: disk, status: 'stored',
      file_name: file.name, mime_type: file.mimeType, bytes: file.bytes.byteLength, sha256: file.sha256,
      visibility: file.visibility,
    })
    objects.push({ storageKey, bytes: file.bytes })
  }
  // A retry after an uncertain storage write addresses the same objects under the retained archive.
  if (archive) {
    const storage = Storage.disk(disk)
    for (const entry of objects) {
      const stored = await storage.write(entry.storageKey, entry.bytes)
      if (stored.size !== entry.bytes.byteLength) throw new Error('Imported attachment size mismatch')
    }
  }
}
