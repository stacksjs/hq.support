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
  Object.assign(firstPage.conversation_parts, { pages: { page: 1, next: { page: 2 } } }); Object.assign(lastPage.conversation_parts, { pages: { page: 2, next: null } })
  const paged = await upload({ version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [{ pages: [{ page: 1, response: firstPage }, { page: 2, response: lastPage }] }] })
  await resumeInNewProcess(paged.data.run.id, 'worker')
  check((await http(`${prefix}/imports/${paged.data.run.id}`, 'GET', undefined, token)).data.run.status === 'completed', 'complete official numbered response pages import more than 500 parts without truncation')
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
  const attachmentSource = conversation('attachments', 'c1'); attachmentSource.source.attachments = [{ url: 'https://attachments.example/private.pdf' }] as never[]
  const attachments = await upload({ version: 1, provider: 'intercom', contacts: [], conversations: [attachmentSource] })
  await resumeInNewProcess(attachments.data.run.id, 'worker')
  check((await http(`${prefix}/imports/${attachments.data.run.id}`, 'GET', undefined, token)).data.records[0].error_code === 'source_attachments_pending', 'untransferred source attachments are explicit review work, never fake stored files')
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
  console.log(`PASS Intercom migration HTTP ${checks} checks`)
}
finally { await server.stop(true) }
