import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { Storage } from '@stacksjs/storage'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { runIsolated, assertIsolatedOk } from '@stacksjs/testing/isolated'
import { one, query } from '../../app/Support/database'
import Job from '../../app/Jobs/RunSupportImport'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let csrf = '', cookie = '', checks = 0
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, token?: string) {
  const result = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: result.status, data: await result.json() as any, headers: result.headers }
}
async function resumeInNewProcess(id: unknown, mode?: string) {
  const result = await runIsolated('tests/fixtures/imports-resume.ts', { args: [String(id), ...(mode ? [mode] : [])], env: { QUEUE_DRIVER: 'database' }, envFile: false, preload: [], timeoutMs: 50000 })
  assertIsolatedOk(result, 'PASS native import resume')
}
const contact = (id: string, overrides: Record<string, unknown> = {}) => ({ type: 'contact', id, external_id: id === 'c1' ? 'native-customer-1' : null, name: `Legacy ${id}`, email: 'migration-owner@example.test', custom_attributes: { plan: 'legacy' }, ...overrides })
const conversation = (id: string, contactId: string, parts: unknown[] = []) => ({ type: 'conversation', id, created_at: 1500000000, updated_at: 1500000100, title: `Imported ${id}`, state: 'closed', source: { type: 'email', id: `source-${id}`, body: 'Original customer message', author: { type: 'user', id: contactId }, attachments: [] }, contacts: { type: 'contact.list', contacts: [{ type: 'contact', id: contactId }] }, conversation_parts: { type: 'conversation_part.list', conversation_parts: parts, total_count: parts.length } })
const part = (id: string, kind = 'comment', body = `Reply ${id}`) => ({ type: 'conversation_part', id, part_type: kind, body, author: { type: 'admin', id: 'old-admin' }, created_at: 1500000001, attachments: [] })
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  await http('/register', 'POST', { name: 'Migration Owner', email: 'migration-owner@example.test', password: 'ImportSecret2026!', password_confirmation: 'ImportSecret2026!' })
  const logged = await http('/login', 'POST', { email: 'migration-owner@example.test', password: 'ImportSecret2026!' }), token = logged.data.access_token
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Imports' }, token)).data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Migrated app' }, token)).data.project
  const prefix = `/support/projects/${project.public_id}`, keys = (await http(`${prefix}/keys`, 'POST', {}, token)).data
  const outboxBeforeImport = JSON.stringify(await query('SELECT * FROM support_outbox ORDER BY id'))
  // An existing native customer with the same external identity is linked. Matching email alone never links.
  const existing = (await http(`/v1/projects/${project.public_id}/sessions`, 'POST', { externalId: 'native-customer-1', name: 'Current native name', email: 'current@example.test', attributes: { native: true } }, keys.ingestKey)).data
  async function upload(bundle: unknown, options: { integration?: boolean, key?: string, dryRun?: boolean } = {}) {
    const bytes = new TextEncoder().encode(JSON.stringify(bundle)), form = new FormData()
    form.set('file', new File([bytes], 'intercom-bundle.json', { type: 'application/json' }))
    if (options.dryRun !== undefined) form.set('dryRun', String(options.dryRun))
    const result = await fetch(base + `${options.integration ? '/v1/projects/' + project.public_id : prefix}/imports/intercom`, { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${options.key || token}` }, body: form })
    return { status: result.status, data: await result.json() as any, bytes }
  }
  const source = { version: 1, provider: 'intercom', format: 'plaintext', contacts: [contact('c1'), contact('c2')], conversations: [conversation('one', 'c1', [part('reply-1'), part('note-1', 'note', 'Private historical note')]), conversation('two', 'c2', [part('reply-2')])] }
  const nativeProfileBeforePreview = await one('SELECT name, email, attributes, updated_at FROM support_contacts WHERE id = ?', [Number(existing.contact.id)])
  const jobsBeforePreview = Number((await one('SELECT COUNT(*) AS count FROM jobs'))?.count)
  const preview = await upload(source, { integration: true, key: keys.ingestKey, dryRun: true })
  check(preview.status === 200 && preview.data.dryRun && preview.data.totalRecords === 4 && preview.data.compatibleRecords === 4 && preview.data.reviewRecords === 0, `server preview rehearses actual native mapping compatibility ${JSON.stringify(preview.data)}`)
  check(Number((await one('SELECT COUNT(*) AS count FROM support_import_runs'))?.count) === 0 && Number((await one('SELECT COUNT(*) AS count FROM support_import_mappings'))?.count) === 0 && Number((await one('SELECT COUNT(*) AS count FROM support_conversations'))?.count) === 0 && Number((await one('SELECT COUNT(*) AS count FROM support_messages'))?.count) === 0, 'dry run rolls back every target/archive/mapping row on the actual database')
  check(Number((await one('SELECT COUNT(*) AS count FROM jobs'))?.count) === jobsBeforePreview && !await Storage.disk('local').directoryExists('support-imports'), 'dry run creates no queue intent or private archive file')
  check(JSON.stringify(await one('SELECT name, email, attributes, updated_at FROM support_contacts WHERE id = ?', [Number(existing.contact.id)])) === JSON.stringify(nativeProfileBeforePreview), 'dry run preserves existing native row values and timestamps exactly')
  check(JSON.stringify(await query('SELECT * FROM support_outbox ORDER BY id')) === outboxBeforeImport && Number((await one('SELECT COUNT(*) AS count FROM support_usage'))?.count) === 0 && Number((await one('SELECT COUNT(*) AS count FROM support_contacts'))?.count) === 1, 'preview sends nothing, charges nothing and preserves the existing native profile')
  check((await upload(source, { integration: true, key: keys.readKey, dryRun: true })).status === 401, 'read key can neither preview nor upload migration data')
  const uploaded = await upload(source)
  check(uploaded.status === 202 && uploaded.data.run.status === 'ready' && uploaded.data.run.totalRecords === 4, `private migration accepted asynchronously ${JSON.stringify(uploaded.data)}`)
  const runId = uploaded.data.run.id, raw = await one('SELECT * FROM support_import_runs WHERE id = ?', [Number(runId)])
  check(raw?.source_hash === createHash('sha256').update(uploaded.bytes).digest('hex') && !String(raw?.source_key).startsWith('public'), 'source archive has retained SHA provenance on private storage')
  check(Number((await one("SELECT COUNT(*) AS count FROM jobs WHERE queue = 'support-imports'"))?.count) >= 1, 'migration work is in the native durable queue')
  await Job.dispatchNow({ runId: Number(runId), batchSize: 1 })
  check(Number((await one('SELECT cursor FROM support_import_runs WHERE id = ?', [Number(runId)]))?.cursor) === 1, 'first native batch checkpoints one complete record')
  check((await http(`${prefix}/imports/${runId}/pause`, 'POST', {}, token)).status === 200, 'operator can pause a saved migration')
  await resumeInNewProcess(runId)
  check(Number((await one('SELECT cursor FROM support_import_runs WHERE id = ?', [Number(runId)]))?.cursor) === 1, 'restarted worker respects paused state')
  check((await http(`${prefix}/imports/${runId}/resume`, 'POST', {}, token)).status === 200, 'operator resumes without reupload')
  await resumeInNewProcess(runId, 'worker')
  const completed = await http(`${prefix}/imports/${runId}`, 'GET', undefined, token)
  const safeStatus = await http(`/v1/projects/${project.public_id}/imports/${runId}`, 'GET', undefined, keys.ingestKey)
  check(safeStatus.status === 200 && safeStatus.data.run.status === 'completed' && Object.keys(safeStatus.data.run).sort().join(',') === 'cursor,failed,id,imported,processed,skipped,status,totalRecords' && safeStatus.data.records === undefined, 'integration status exposes only scoped counts/status, without records/transcripts/source names')
  check((await http(`/v1/projects/${project.public_id}/imports/${runId}`, 'GET', undefined, keys.readKey)).status === 401, 'read key cannot inspect integration migration status')
  check(completed.data.run.status === 'completed' && completed.data.run.processed === 4 && completed.data.run.failed === 0, `native queue restart completes all supplied records ${JSON.stringify(completed.data.run)}`)
  check(Number((await one('SELECT COUNT(*) AS count FROM users'))?.count) === 1 && Number((await one('SELECT COUNT(*) AS count FROM support_contacts WHERE project_id = ?', [project.id]))?.count) === 2, 'source email never creates/links a native auth account or merges unrelated contacts')
  const linked = await one('SELECT * FROM support_contacts WHERE external_id = ? AND project_id = ?', ['native-customer-1', project.id])
  check(String(linked?.id) === existing.contact.id && linked?.name === 'Current native name' && JSON.parse(String(linked.attributes)).native === true, 'explicit external identity links while current native profile edits remain intact')
  check(Number((await one('SELECT COUNT(*) AS count FROM support_conversations WHERE project_id = ?', [project.id]))?.count) === 2 && Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ?', [project.id]))?.count) === 5, 'historical conversations and every supplied message persisted')
  check(JSON.stringify(await query('SELECT * FROM support_outbox ORDER BY id')) === outboxBeforeImport && Number((await one('SELECT COUNT(*) AS count FROM support_usage WHERE workspace_id = ?', [workspace.id]))?.count) === 0, 'history does not send notifications, trigger workflows or charge new support traffic quota')
  check((await http(`${prefix}/inbox`, 'GET', undefined, token)).data.conversations.every((row: any) => row.unread_count === 0), 'historical imports do not fabricate unread traffic')
  const conversationMap = await one("SELECT * FROM support_import_mappings WHERE project_id = ? AND entity_type = 'conversation' AND external_id = 'one'", [project.id])
  const detail = await http(`/widget/projects/${project.public_id}/conversations/${conversationMap!.target_id}`, 'GET', undefined, existing.token)
  // A messenger origin must be explicitly allowed, even for imported history.
  check(detail.status === 403, 'migration does not bypass messenger origin policy')
  const agentDetail = await http(`${prefix}/conversations/${conversationMap!.target_id}`, 'GET', undefined, token)
  check(agentDetail.data.messages.some((row: any) => row.visibility === 'internal' && row.body === 'Private historical note') && agentDetail.data.messages.every((row: any) => row.delivery_status === 'imported'), 'private notes and truthful historical delivery state survive migration')
  const duplicate = await upload(source)
  check(duplicate.status === 202 && duplicate.data.duplicate && duplicate.data.run.id === runId, 'identical archive retry returns the original run')
  const changedArchiveSameRecords = await upload({ ...source, exportNote: 'new archive, same records' })
  await resumeInNewProcess(changedArchiveSameRecords.data.run.id, 'worker')
  const repeated = await http(`${prefix}/imports/${changedArchiveSameRecords.data.run.id}`, 'GET', undefined, token)
  check(repeated.data.run.status === 'completed' && repeated.data.run.skipped === 4 && Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE project_id = ?', [project.id]))?.count) === 5, 'stable external ID mappings deduplicate across different archive files')
  const incomplete = conversation('truncated', 'c1', Array.from({ length: 500 }, (_, i) => part(`truncated-${i}`)))
  const incompatiblePreview = await upload({ version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [incomplete] }, { integration: true, key: keys.ingestKey, dryRun: true })
  check(incompatiblePreview.status === 200 && incompatiblePreview.data.reviewRecords === 1 && incompatiblePreview.data.reasons[0].code === 'incomplete_source_history', 'dry run reports actual incompatible history instead of blindly approving source counts')
  const refused = await upload({ version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [incomplete] })
  await resumeInNewProcess(refused.data.run.id, 'worker')
  const reviewed = await http(`${prefix}/imports/${refused.data.run.id}`, 'GET', undefined, token)
  check(reviewed.data.run.status === 'needs_review' && reviewed.data.records[0].error_code === 'incomplete_source_history' && reviewed.data.sourceArchiveRetained, 'ambiguous unpaged 500-part source is retained and never declared complete')
  check(!await one("SELECT id FROM support_import_mappings WHERE project_id = ? AND entity_type = 'conversation' AND external_id = 'truncated'", [project.id]), 'an incomplete source conversation leaves no phantom target or partial message mapping')
  const firstPage = conversation('paged', 'c1', Array.from({ length: 500 }, (_, i) => part(`paged-${i}`))), lastPage = conversation('paged', 'c1', [part('paged-last')])
  Object.assign(firstPage.conversation_parts, { pages: { page: 1, per_page: 500, total_pages: 2, next: 'https://api.intercom.io/conversations/paged?page=2&per_page=500' } })
  Object.assign(lastPage.conversation_parts, { pages: { page: 2, per_page: 500, total_pages: 2, next: null } })
  const paged = await upload({ version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [{ pages: [{ page: 1, response: firstPage }, { page: 2, response: lastPage }] }] })
  await resumeInNewProcess(paged.data.run.id, 'worker')
  const pagedStatus = (await http(`${prefix}/imports/${paged.data.run.id}`, 'GET', undefined, token)).data
  check(pagedStatus.run.status === 'completed' && pagedStatus.records[0].external_id === 'paged', 'complete numbered response pages import without truncation and retain the source conversation ID')
  const pagedMap = await one("SELECT * FROM support_import_mappings WHERE project_id = ? AND entity_type = 'conversation' AND external_id = 'paged'", [project.id])
  check(Number((await one('SELECT COUNT(*) AS count FROM support_messages WHERE conversation_id = ?', [pagedMap!.target_id]))?.count) === 502, 'all 501 paginated parts and original source message persist')
  const recent = await http(`${prefix}/conversations/${pagedMap!.target_id}`, 'GET', undefined, token)
  check(recent.data.messages.length === 500 && recent.data.messagesNextCursor, 'large conversation exposes a real older-message cursor')
  const older = await http(`${prefix}/conversations/${pagedMap!.target_id}?beforeMessage=${recent.data.messagesNextCursor}`, 'GET', undefined, token)
  check(older.data.messages.length === 2 && !older.data.messagesNextCursor, 'older source messages remain accessible instead of being silently dropped by an API bound')
  // Removing a continuation page cannot be bypassed with a source-controlled complete flag.
  const badPages = await upload({ version: 1, provider: 'intercom', contacts: [], conversations: [{ pages: [{ page: 1, response: firstPage }] }] })
  await resumeInNewProcess(badPages.data.run.id, 'worker')
  check((await http(`${prefix}/imports/${badPages.data.run.id}`, 'GET', undefined, token)).data.records[0].error_code === 'incomplete_source_history', 'unfinished page chain is held for review')
  const inconsistentPages = (id: string, issue: 'parts' | 'pages' | 'updated' | 'size' | 'filter') => {
    const first = conversation(id, 'c1', [part(`${id}-1`)])
    const last = conversation(id, 'c1', [part(`${id}-2`)])
    const next = issue === 'filter' ? `https://api.intercom.io/conversations/${id}?page=2&exclude_part_types=note` : { page: 2 }
    Object.assign(first.conversation_parts, { pages: { page: 1, per_page: 1, total_pages: 2, next } })
    Object.assign(last.conversation_parts, { pages: { page: 2, per_page: issue === 'size' ? 2 : 1, total_pages: issue === 'pages' ? 3 : 2, next: null } })
    if (issue === 'parts') last.conversation_parts.total_count = 2
    if (issue === 'updated') last.updated_at++
    return { pages: [{ page: 1, response: first }, { page: 2, response: last }] }
  }
  const inconsistentConversations = [
    ['pages-missing-part', 'parts'],
    ['pages-missing-page', 'pages'],
    ['pages-source-changed', 'updated'],
    ['pages-size-changed', 'size'],
    ['pages-filtered', 'filter'],
  ] as const
  const inconsistentIds = inconsistentConversations.map(([id]) => id)
  const inconsistentBundle = {
    version: 1, provider: 'intercom', contacts: [],
    conversations: inconsistentConversations.map(([id, issue]) => inconsistentPages(id, issue)),
  }
  const inconsistentPreview = await upload(inconsistentBundle, { integration: true, key: keys.ingestKey, dryRun: true })
  check(inconsistentPreview.status === 200 && inconsistentPreview.data.reviewRecords === inconsistentIds.length && inconsistentPreview.data.compatibleRecords === 0,
    `native preview rejects inconsistent source pagination: ${JSON.stringify(inconsistentPreview.data)}`)
  const inconsistent = await upload(inconsistentBundle)
  await resumeInNewProcess(inconsistent.data.run.id, 'worker')
  const inconsistentReport = (await http(`${prefix}/imports/${inconsistent.data.run.id}`, 'GET', undefined, token)).data
  check(inconsistentReport.run.status === 'needs_review' && inconsistentReport.run.failed === inconsistentIds.length
    && inconsistentReport.records.every((record: any, index: number) => record.external_id === inconsistentIds[index] && record.error_code === 'incomplete_source_history'),
    'inconsistent page evidence retains each original source ID for review')
  for (const id of inconsistentIds)
    check(!await one("SELECT id FROM support_import_mappings WHERE project_id = ? AND entity_type = 'conversation' AND external_id = ?", [project.id, id]),
      'inconsistent source pages cannot write partial conversation history')
  const emptyResponse = conversation('pages-no-parts', 'c1')
  Object.assign(emptyResponse.conversation_parts, { pages: { page: 1, per_page: 500, total_pages: 0, next: null } })
  const emptyPreview = await upload({ version: 1, provider: 'intercom', contacts: [], conversations: [{ pages: [{ page: 1, response: emptyResponse }] }] },
    { integration: true, key: keys.ingestKey, dryRun: true })
  check(emptyPreview.status === 200 && emptyPreview.data.compatibleRecords === 1, 'a source conversation with an initial message and zero parts is compatible')
  const attachmentSource = conversation('attachments', 'c1'); attachmentSource.source.attachments = [{ url: 'https://attachments.example/private.pdf' }] as never[]
  const attachments = await upload({ version: 1, provider: 'intercom', contacts: [], conversations: [attachmentSource] })
  await resumeInNewProcess(attachments.data.run.id, 'worker')
  check((await http(`${prefix}/imports/${attachments.data.run.id}`, 'GET', undefined, token)).data.records[0].error_code === 'source_attachments_pending', 'untransferred source attachments are explicit review work, never fake stored files')
  const documentedAttachment = (name: string, contents: string) => {
    const url = `https://attachments.example/${name}`
    return {
      metadata: { type: 'upload', name, url, content_type: 'text/plain', filesize: Buffer.byteLength(contents) },
      supplied: { url, data: Buffer.from(contents).toString('base64'), sha256: createHash('sha256').update(contents).digest('hex') },
    }
  }
  const publicFile = documentedAttachment('original.txt', 'Original attachment bytes')
  const privateFile = documentedAttachment('note.txt', 'Internal attachment bytes')
  const withFiles = conversation('supplied-files', 'c1', [{ ...part('file-note', 'note'), attachments: [privateFile.metadata] }])
  const fileBundle = { version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [{ ...withFiles, source: { ...withFiles.source, attachments: [publicFile.metadata] } }], attachmentFiles: [publicFile.supplied, privateFile.supplied] }
  const attachmentRowsBeforePreview = (await query('SELECT id FROM support_attachments ORDER BY id')).length
  const diskBeforePreview = await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspace.id])
  const filePreview = await upload(fileBundle, { integration: true, key: keys.ingestKey, dryRun: true })
  check(filePreview.status === 200 && filePreview.data.compatibleRecords === 1, 'documented attachments with verified offline bytes pass the real dry run')
  check((await query('SELECT id FROM support_attachments ORDER BY id')).length === attachmentRowsBeforePreview && Number((await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspace.id]))?.storage_bytes) === Number(diskBeforePreview?.storage_bytes), 'attachment dry run rolls back metadata and quota')
  const fileRun = await upload(fileBundle)
  check(fileRun.status === 202, 'private archive with supplied attachments is accepted')
  await resumeInNewProcess(fileRun.data.run.id, 'worker')
  const fileStatus = (await http(`${prefix}/imports/${fileRun.data.run.id}`, 'GET', undefined, token)).data
  check(fileStatus.run.status === 'completed', 'attachment transfer is part of the durable conversation checkpoint')
  const files = await query('SELECT id, file_name, visibility, sha256 FROM support_attachments WHERE conversation_id = ? ORDER BY id', [fileStatus.records[0].target_id])
  check(files.length === 2 && files[0]?.visibility === 'public' && files[1]?.visibility === 'private' && files[0]?.sha256 === publicFile.supplied.sha256 && files[1]?.sha256 === privateFile.supplied.sha256, 'the message visibility and SHA-256 values survive import')
  const widgetOrigin = 'https://customer.example'
  check((await http(prefix, 'PATCH', { allowedOrigins: [widgetOrigin] }, token)).status === 200, 'test project allows the exact Messenger origin')
  const widgetFile = (id: unknown) => fetch(base + `/widget/projects/${project.public_id}/attachments/${id}`, { headers: { authorization: 'Bearer ' + existing.token, origin: widgetOrigin } })
  const downloaded = await widgetFile(files[0]!.id)
  check(downloaded.status === 200 && createHash('sha256').update(Buffer.from(await downloaded.arrayBuffer())).digest('hex') === publicFile.supplied.sha256, `native customer download returns the exact public file bytes (HTTP ${downloaded.status})`)
  check((await widgetFile(files[1]!.id)).status === 404, 'the same customer cannot open an internal note attachment')
  const agentFile = await fetch(base + `${prefix}/attachments/${files[1]!.id}`, { headers: { authorization: 'Bearer ' + token } })
  check(agentFile.status === 200 && createHash('sha256').update(Buffer.from(await agentFile.arrayBuffer())).digest('hex') === privateFile.supplied.sha256, 'native agent download returns the exact internal file bytes')
  const replayedFiles = await upload({ ...fileBundle, attachmentFiles: [...fileBundle.attachmentFiles].reverse() })
  await resumeInNewProcess(replayedFiles.data.run.id, 'worker')
  const replayedFileStatus = (await http(`${prefix}/imports/${replayedFiles.data.run.id}`, 'GET', undefined, token)).data
  check(replayedFileStatus.run.skipped === 1 && (await query('SELECT id FROM support_attachments WHERE conversation_id = ?', [fileStatus.records[0].target_id])).length === 2, 'cross-archive replay does not duplicate conversation attachments')
  const badChecksum = await upload({ ...fileBundle, attachmentFiles: [{ ...publicFile.supplied, sha256: '0'.repeat(64) }] })
  check(badChecksum.status === 422 && badChecksum.data.error.code === 'attachment_checksum_mismatch', 'corrupted sidecar bytes are rejected before queueing')
  const incompleteFiles = await upload({ ...fileBundle, attachmentFiles: [publicFile.supplied] }, { integration: true, key: keys.ingestKey, dryRun: true })
  check(incompleteFiles.data.reasons.some((reason: any) => reason.code === 'source_attachments_pending'), 'missing sidecar bytes keep their conversation in review')
  const altered = structuredClone(source); altered.conversations[0]!.conversation_parts.conversation_parts[0]!.body = 'Edited legacy message'
  const conflict = await upload(altered); await resumeInNewProcess(conflict.data.run.id, 'worker')
  check((await http(`${prefix}/imports/${conflict.data.run.id}`, 'GET', undefined, token)).data.records.some((row: any) => row.error_code === 'source_message_changed') && (await one('SELECT body FROM support_messages WHERE body = ?', ['Reply reply-1']))?.body === 'Reply reply-1', 'changed source history creates a review conflict and preserves native messages')
  const integrity = await upload({ version: 1, provider: 'intercom', format: 'plaintext', contacts: [contact('integrity')], conversations: [] }, { integration: true, key: keys.ingestKey })
  const integrityRow = await one('SELECT * FROM support_import_runs WHERE id = ?', [Number(integrity.data.run.id)])
  await Storage.disk(String(integrityRow!.source_disk)).write(String(integrityRow!.source_key), 'modified archive')
  let detectedChange = false
  try { await Job.dispatchNow({ runId: Number(integrityRow!.id) }) }
  catch (error) { detectedChange = (error as { code?: string }).code === 'source_archive_changed' }
  check(detectedChange && (await http(`${prefix}/imports/${integrityRow!.id}`, 'GET', undefined, token)).data.run.status === 'needs_review', 'archive byte/hash mismatch blocks processing and preserves review state')
  await Storage.disk(String(integrityRow!.source_disk)).write(String(integrityRow!.source_key), integrity.bytes)
  await http(`/v1/projects/${project.public_id}/imports/${integrityRow!.id}/resume`, 'POST', {}, keys.ingestKey)
  await resumeInNewProcess(integrityRow!.id, 'worker')
  check((await http(`${prefix}/imports/${integrityRow!.id}`, 'GET', undefined, token)).data.run.status === 'completed', 'restored original source resumes from its durable checkpoint')
  await http('/register', 'POST', { name: 'Other migration owner', email: 'other-import@example.test', password: 'ImportSecret2026!', password_confirmation: 'ImportSecret2026!' })
  const other = await http('/login', 'POST', { email: 'other-import@example.test', password: 'ImportSecret2026!' })
  check((await http(`${prefix}/imports/${runId}`, 'GET', undefined, other.data.access_token)).status === 403, 'private archive status and migration reports reject another workspace account')
  const dated = { ...conversation('resolved-time', 'c1'), statistics: { last_close_at: 1500000050 } }
  const missingDate = conversation('unknown-resolution-time', 'c1')
  const invalidDate = { ...conversation('invalid-resolution-time', 'c1'), closed_at: 1499999999 }
  const historyDates = await upload({ version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [dated, missingDate, invalidDate] })
  await resumeInNewProcess(historyDates.data.run.id, 'worker')
  check(Number((await one('SELECT resolved_at FROM support_conversations WHERE project_id = ? AND subject = ?', [project.id, dated.title]))!.resolved_at) === 1500000050000, 'trusted export resolution time is preserved independently of source updated_at')
  check(Number((await one('SELECT resolved_at FROM support_conversations WHERE project_id = ? AND subject = ?', [project.id, missingDate.title]))!.resolved_at) === 0, 'missing historical resolution remains unknown for one quota-free grandfathered reopen')
  const dateStatus = await http(`${prefix}/imports/${historyDates.data.run.id}`, 'GET', undefined, token)
  check(dateStatus.data.records.some((record: any) => record.error_code === 'invalid_source_timestamp') && !await one('SELECT id FROM support_conversations WHERE project_id = ? AND subject = ?', [project.id, invalidDate.title]), 'contradictory source resolution time is retained for review without inventing a closure date')

  const nullOriginalTime = conversation('null-root-date', 'date-review-contact')
  const malformedTimes = [
    { ...conversation('null-created', 'date-review-contact'), created_at: null },
    { ...conversation('null-updated', 'date-review-contact'), updated_at: null },
    { ...conversation('reversed-activity-time', 'date-review-contact'), updated_at: 1499999999 },
    { ...conversation('coerced-resolution-time', 'date-review-contact'), closed_at: 1500000050, statistics: { last_close_at: [1500000050] } },
    { ...nullOriginalTime, source: { ...nullOriginalTime.source, created_at: null } },
    conversation('blank-comment-date', 'date-review-contact', [{ ...part('blank-date'), created_at: ' ' }]),
    conversation('null-note-date', 'date-review-contact', [{ ...part('null-date', 'note'), created_at: null }]),
    conversation('boolean-note-date', 'date-review-contact', [{ ...part('boolean-date', 'note'), created_at: false }]),
    conversation('array-comment-date', 'date-review-contact', [{ ...part('array-date'), created_at: [1500000001] }]),
  ]
  const validTimes = {
    ...conversation('valid-source-times', 'c1', [{ ...part('valid-string-date'), created_at: '1500000001' }]),
    updated_at: '1500000100',
  }
  const legacyTimes = { ...conversation('omitted-update-time', 'c1'), created_at: '1500000000', updated_at: undefined, statistics: { last_close_at: null } }
  const malformedLaterPage = inconsistentPages('page-invalid-date', 'updated')
  const lastPageWithBadDate = malformedLaterPage.pages[1]!
  const invalidPages = { pages: [malformedLaterPage.pages[0]!, { ...lastPageWithBadDate, response: { ...lastPageWithBadDate.response, updated_at: [1500000100] } }] }
  const invalidCreationHistory = inconsistentPages('page-invalid-created', 'updated')
  const [firstCreationPage, secondCreationPage] = invalidCreationHistory.pages
  const invalidCreationPages = { pages: [firstCreationPage!, { ...secondCreationPage!, response: { ...secondCreationPage!.response, created_at: false, updated_at: firstCreationPage!.response.updated_at } }] }
  function legacyPageSequence(id: string, updates: (number | string | undefined)[]) {
    return { pages: updates.map((updatedAt, index) => {
      const page = index + 1
      const source = conversation(id, 'c1', [part(`${id}-${page}`)])
      const paging = { page, per_page: 1, total_pages: updates.length, next: page < updates.length ? { page: page + 1 } : null }
      return { page, response: { ...source, updated_at: updatedAt, conversation_parts: { ...source.conversation_parts, pages: paging } } }
    }) }
  }
  const disputedPagesId = 'legacy-pages-disagree-on-update'
  const disputedPages = legacyPageSequence(disputedPagesId, [undefined, 1500000100, 1500000101])
  const trustedPagesId = 'legacy-pages-supply-update'
  const trustedPages = legacyPageSequence(trustedPagesId, [undefined, '1500000100', 1500000100])
  const malformedTimeIds = [...malformedTimes.map(entry => entry.id), 'page-invalid-date', 'page-invalid-created']
  const timeBundle = { version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [...malformedTimes, invalidPages, invalidCreationPages, disputedPages, validTimes, legacyTimes, trustedPages] }
  const timePreview = await upload(timeBundle, { integration: true, key: keys.ingestKey, dryRun: true })
  check(timePreview.status === 200 && timePreview.data.compatibleRecords === 3 && timePreview.data.reviewRecords === malformedTimeIds.length + 1
    && timePreview.data.reasons.some((reason: any) => reason.code === 'invalid_source_timestamp' && reason.count === malformedTimeIds.length)
    && timePreview.data.reasons.some((reason: any) => reason.code === 'incomplete_source_history' && reason.count === 1),
    `malformed timestamps require review in the native preview: ${JSON.stringify(timePreview.data)}`)
  const timeRun = await upload(timeBundle)
  check(timeRun.status === 202, 'native upload queues the date review fixture')
  await resumeInNewProcess(timeRun.data.run.id, 'worker')
  const timeReport = (await http(`${prefix}/imports/${timeRun.data.run.id}`, 'GET', undefined, token)).data
  check(timeReport.run.status === 'needs_review' && timeReport.run.failed === malformedTimeIds.length + 1 && timeReport.run.imported === 3
    && timeReport.records.slice(0, malformedTimeIds.length).every((record: any, index: number) => record.external_id === malformedTimeIds[index] && record.error_code === 'invalid_source_timestamp')
    && timeReport.records[malformedTimeIds.length].external_id === disputedPagesId
    && timeReport.records[malformedTimeIds.length].error_code === 'incomplete_source_history',
    'the restarted native worker retains every invalid source ID for review')
  check(!await one('SELECT id FROM support_contacts WHERE project_id = ? AND external_id = ?', [project.id, 'intercom:date-review-contact'])
    && !await one("SELECT id FROM support_import_mappings WHERE project_id = ? AND entity_type = 'message' AND external_id LIKE 'blank-comment-date:%'", [project.id]),
    'time validation rolls back the provisional contact and root message')
  const validRecord = timeReport.records.find((record: any) => record.external_id === validTimes.id)
  const validDetail = await http(`${prefix}/conversations/${validRecord.target_id}`, 'GET', undefined, token)
  check(validDetail.status === 200 && validDetail.data.messages.length === 2
    && validDetail.data.messages.every((row: any, index: number) => new Date(row.created_at).getTime() === (1500000000 + index) * 1000),
    'the original message inherits the conversation date and decimal-string reply dates retain exact UTC seconds')
  const legacyRecord = timeReport.records.find((record: any) => record.external_id === legacyTimes.id)
  const legacyDetail = await http(`${prefix}/conversations/${legacyRecord.target_id}`, 'GET', undefined, token)
  check(legacyDetail.status === 200 && new Date(legacyDetail.data.conversation.updated_at).getTime() === 1500000000000
    && Number(legacyDetail.data.conversation.resolved_at) === 0,
    'an absent legacy update inherits creation time and an unknown resolution stays unknown')
  const trustedRecord = timeReport.records.find((record: any) => record.external_id === trustedPagesId)
  const trustedDetail = await http(`${prefix}/conversations/${trustedRecord.target_id}`, 'GET', undefined, token)
  check(trustedDetail.status === 200 && new Date(trustedDetail.data.conversation.updated_at).getTime() === 1500000100000,
    'the import preserves an agreed update time supplied after the first page')

  const correctedBundle = { ...timeBundle, conversations: [{ ...validTimes, created_at: 1500000001 }] }
  const correctedRun = await upload(correctedBundle)
  await resumeInNewProcess(correctedRun.data.run.id, 'worker')
  const correctedReport = (await http(`${prefix}/imports/${correctedRun.data.run.id}`, 'GET', undefined, token)).data
  const unchangedDetail = await http(`${prefix}/conversations/${validRecord.target_id}`, 'GET', undefined, token)
  check(correctedReport.run.status === 'needs_review' && correctedReport.records.some((record: any) => record.external_id === validTimes.id && record.error_code === 'source_message_timestamp_changed')
    && new Date(unchangedDetail.data.messages[0].created_at).getTime() === 1500000000000,
    'replaying an altered inherited timestamp retains the imported message and sends the source ID to review')
  await query('UPDATE support_messages SET created_at = ? WHERE id = ? AND project_id = ?', ['2017-07-14 02:40:00', unchangedDetail.data.messages[0].id, project.id])
  const sameTimeRun = await upload({ ...timeBundle, conversations: [{ ...validTimes, title: 'Same historical timestamp in a new archive' }] })
  await resumeInNewProcess(sameTimeRun.data.run.id, 'worker')
  const sameTimeReport = (await http(`${prefix}/imports/${sameTimeRun.data.run.id}`, 'GET', undefined, token)).data
  check(sameTimeReport.run.status === 'completed' && sameTimeReport.run.skipped === 1,
    'an identical source timestamp matches the stored UTC date even when SQL omits its zone')

  console.log(`PASS Intercom migration HTTP ${checks} checks`)
}
finally { await server.stop(true) }
