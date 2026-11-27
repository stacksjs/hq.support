import { createHash } from 'node:crypto'
import { parseSqlDateTime } from '@stacksjs/database/runtime'
import { Storage } from '@stacksjs/storage'
import { storeJob } from '@stacksjs/queue/utils'
import type { Row } from './database'
import { db, insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, SupportError, text } from './errors'
import { contact, member, object, secret } from './service'
import { knowledgeText, localeOf } from './knowledge'
import type { KnowledgeAuthor } from './knowledge'
import { importIntercomArticle, importIntercomCollection } from './import-articles'
import type { ImportArchive, ImportAttachment } from './import-attachments'
import { checkImportedAttachments, importAttachmentLimit, parseImportAttachmentFiles, sourceAttachments, storeImportedAttachments } from './import-attachments'

export const importLimits = { bytes: 10_000_000, records: 5000, attachmentFiles: importAttachmentLimit, batch: 25, leaseMs: 60000, maximumConversationParts: 500, maximumPaginatedParts: 5000 } as const
export type IntercomBundle = { version: 1, provider: 'intercom', format: 'html' | 'plaintext', contacts: Row[], conversations: Row[], articles: Row[], collections: Row[], articleLocale?: string, attachmentFiles: ReturnType<typeof parseImportAttachmentFiles> }
export type ImportPrincipal = number | { kind: 'integration', keyDigest: string }
async function authorizeImport(project: Row, principal: ImportPrincipal) {
  if (typeof principal === 'number') await member(principal, Number(project.workspace_id), ['owner', 'admin'])
  else if (!await one("SELECT id FROM support_api_keys WHERE project_id = ? AND workspace_id = ? AND digest = ? AND scope = 'write' AND revoked_at = 0", [project.id, project.workspace_id, principal.keyDigest])) fail(401, 'unauthorized', 'A current project write key is required for migration.')
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
function external(value: unknown, label = 'source id') {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(422, 'unsafe_source_id', 'Export identifiers must preserve their full precision as strings.')
  const id = text(typeof value === 'number' ? String(value) : value, label, 200)
  if (!/^[a-zA-Z0-9_.:-]+$/.test(id)) fail(422, 'invalid_source_id', 'Export identifier contains unsupported characters.')
  return id
}
function timestamp(value: unknown, label: string) {
  const seconds = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 4102444800) fail(422, 'invalid_source_timestamp', `${label} must be a UTC Unix timestamp in seconds.`)
  return new Date(seconds * 1000).toISOString()
}
function conversationDates(source: Row) {
  const createdAt = timestamp(source.created_at, 'conversation.created_at')
  const updatedAt = source.updated_at === undefined ? undefined : timestamp(source.updated_at, 'conversation.updated_at')
  if (updatedAt !== undefined && updatedAt < createdAt) fail(422, 'invalid_source_timestamp', 'Conversation update time precedes its creation time.')
  return { createdAt, updatedAt }
}
export function parseIntercomBundle(bytes: Uint8Array): IntercomBundle {
  if (!bytes.byteLength || bytes.byteLength > importLimits.bytes) fail(413, 'import_size', 'Migration bundles must be 1 to 10000000 bytes.')
  let parsed: Row
  try { parsed = object(JSON.parse(new TextDecoder().decode(bytes))) }
  catch { fail(422, 'invalid_import_json', 'Upload a valid Intercom migration bundle JSON file.') }
  if (parsed.version !== 1 || parsed.provider !== 'intercom' || !Array.isArray(parsed.contacts) || !Array.isArray(parsed.conversations) || !['html', 'plaintext'].includes(String(parsed.format ?? 'html'))) fail(422, 'invalid_import_bundle', 'Use bundle version 1 with provider intercom, contacts and full conversations arrays.')
  if ((parsed.articles !== undefined && !Array.isArray(parsed.articles)) || (parsed.collections !== undefined && !Array.isArray(parsed.collections))) fail(422, 'invalid_import_bundle', 'Optional articles and collections must be arrays.')
  const records = parsed.contacts.length + parsed.conversations.length + (Array.isArray(parsed.articles) ? parsed.articles.length : 0) + (Array.isArray(parsed.collections) ? parsed.collections.length : 0)
  if (records < 1 || records > importLimits.records) fail(422, 'import_record_limit', 'A bundle must contain 1 to 5000 supplied contact, conversation, collection or article records.')
  const pending: { value: unknown, depth: number }[] = [{ value: parsed, depth: 0 }]
  let entries = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++entries > 100000 || item.depth > 32) fail(422, 'import_structure_limit', 'Source JSON exceeds the bounded nesting/object budget.')
    if (item.value && typeof item.value === 'object') for (const value of Object.values(item.value)) pending.push({ value, depth: item.depth + 1 })
  }
  return { version: 1, provider: 'intercom', format: (parsed.format ?? 'html') as 'html' | 'plaintext', contacts: parsed.contacts.map(object), conversations: parsed.conversations.map(object), articles: Array.isArray(parsed.articles) ? parsed.articles.map(object) : [], collections: Array.isArray(parsed.collections) ? parsed.collections.map(object) : [], attachmentFiles: parseImportAttachmentFiles(parsed.attachmentFiles), ...(parsed.articleLocale === undefined ? {} : { articleLocale: localeOf(parsed.articleLocale) }) }
}
function runView(row: Row) {
  return { id: String(row.id), provider: String(row.provider), sourceName: String(row.source_name), sourceHash: String(row.source_hash), sourceBytes: Number(row.source_bytes), totalRecords: Number(row.total_records), cursor: Number(row.cursor), processed: Number(row.processed), imported: Number(row.imported), skipped: Number(row.skipped), failed: Number(row.failed), status: String(row.status), lastError: String(row.last_error), createdAt: row.created_at, updatedAt: row.updated_at }
}
async function runFor(project: Row, id: unknown) {
  const row = await one('SELECT * FROM support_import_runs WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])
  if (!row) fail(404, 'not_found', 'Migration run not found.')
  return row
}
export async function uploadIntercomBundle(project: Row, principal: ImportPrincipal, file: File) {
  await authorizeImport(project, principal)
  if (!file.size || file.size > importLimits.bytes) fail(413, 'import_size', 'Migration bundles must be 1 to 10000000 bytes.')
  const bytes = new Uint8Array(await file.arrayBuffer()), bundle = parseIntercomBundle(bytes), hash = createHash('sha256').update(bytes).digest('hex'), lease = secret()
  const disk = process.env.SUPPORT_STORAGE_DISK || Storage.getDefaultDisk()
  if (disk === 'public') fail(503, 'private_storage_required', 'Migration archives require a private native storage disk.')
  const row = await workspaceTransaction(Number(project.workspace_id), async () => {
    await authorizeImport(project, principal)
    const existing = await one("SELECT * FROM support_import_runs WHERE project_id = ? AND provider = 'intercom' AND source_hash = ?", [project.id, hash])
    if (existing) {
      if (existing.status !== 'uploading') return existing
      if (Number(existing.lease_until) > Date.now()) fail(409, 'import_upload_in_progress', 'This identical migration bundle is already uploading.')
      await query('UPDATE support_import_runs SET lease_token = ?, lease_until = ? WHERE id = ?', [lease, Date.now() + importLimits.leaseMs, existing.id])
      return { ...existing, lease_token: lease }
    }
    const created = await insert('support_import_runs', { workspace_id: project.workspace_id, project_id: project.id, provider: 'intercom', source_hash: hash, source_key: `support-imports/${project.workspace_id}/${project.public_id}/${crypto.randomUUID()}.json`, source_disk: disk, source_name: file.name.replace(/[\r\n\\/\x00-\x1F]/g, '_').slice(0, 255), source_bytes: bytes.byteLength, total_records: importRecords(bundle).length, status: 'uploading', lease_token: lease, lease_until: Date.now() + importLimits.leaseMs })
    if (bundle.articles.length || bundle.collections.length || bundle.attachmentFiles.size) await rememberImportActor(project, created.id, principal)
    return created
  })
  if (row.status !== 'uploading') return { run: runView(row), duplicate: true }
  try {
    const stored = await Storage.disk(String(row.source_disk)).write(String(row.source_key), bytes)
    if (stored.size !== bytes.byteLength) throw new Error('Migration archive size mismatch')
    await workspaceTransaction(Number(project.workspace_id), async () => {
      await authorizeImport(project, principal)
      const current = await runFor(project, row.id)
      if (current.lease_token !== lease || current.status !== 'uploading') fail(409, 'import_lease_changed', 'Migration upload ownership changed. Retry the same bundle.')
      await query("UPDATE support_import_runs SET status = 'ready', lease_until = 0, updated_at = ? WHERE id = ?", [new Date().toISOString(), row.id])
      await storeJob('RunSupportImport', { queue: 'support-imports', payload: { runId: row.id }, maxTries: 5, timeout: 60 })
    })
    return { run: runView(await runFor(project, row.id)), duplicate: false }
  }
  catch (error) {
    await query('UPDATE support_import_runs SET lease_until = 0 WHERE id = ? AND lease_token = ?', [row.id, lease])
    throw error
  }
}
async function mapping(project: Row, type: string, id: string) {
  return await one("SELECT * FROM support_import_mappings WHERE project_id = ? AND workspace_id = ? AND provider = 'intercom' AND entity_type = ? AND external_id = ?", [project.id, project.workspace_id, type, id])
}
async function remember(project: Row, type: string, id: string, targetId: unknown, payload: Row, hashInput: Row = payload) {
  const previous = await mapping(project, type, id)
  if (previous) await query('UPDATE support_import_mappings SET source_hash = ?, source_payload = ?, updated_at = ? WHERE id = ?', [fingerprint(hashInput), JSON.stringify(payload), new Date().toISOString(), previous.id])
  else await insert('support_import_mappings', { workspace_id: project.workspace_id, project_id: project.id, provider: 'intercom', entity_type: type, external_id: id, target_id: targetId, source_hash: fingerprint(hashInput), source_payload: JSON.stringify(payload) })
}
function importRecords(bundle: IntercomBundle) {
  // Keep pre-existing contact/conversation positions stable for version-one resumptions.
  return [...bundle.contacts.map(payload => ({ type: 'contact', payload })), ...bundle.conversations.map(payload => ({ type: 'conversation', payload })), ...bundle.collections.map(payload => ({ type: 'collection', payload })), ...bundle.articles.map(payload => ({ type: 'article', payload }))]
}
async function importPrincipalAuthor(project: Row, principal: ImportPrincipal): Promise<KnowledgeAuthor> {
  await authorizeImport(project, principal)
  if (typeof principal === 'number') return principal
  const key = await one("SELECT id FROM support_api_keys WHERE project_id = ? AND workspace_id = ? AND digest = ? AND scope = 'write' AND revoked_at = 0", [project.id, project.workspace_id, principal.keyDigest])
  if (!key) fail(401, 'import_authorization_revoked', 'The migration integration key was revoked.')
  return { integrationKeyId: Number(key.id) }
}
async function rememberImportActor(project: Row, runId: unknown, principal: ImportPrincipal) {
  const author = await importPrincipalAuthor(project, principal)
  const payload = typeof author === 'number' ? { kind: 'user', userId: author } : { kind: 'integration', integrationKeyId: author.integrationKeyId }
  await remember(project, 'import_actor', String(runId), typeof author === 'number' ? author : author.integrationKeyId, payload)
}
async function importRunAuthor(project: Row, runId: unknown): Promise<KnowledgeAuthor> {
  const actor = await mapping(project, 'import_actor', String(runId))
  if (!actor) fail(409, 'import_actor_missing', 'Article migration requires the persisted initiating native user or integration key.')
  const payload = object(JSON.parse(String(actor.source_payload)))
  if (payload.kind === 'user') { const userId = identifier(payload.userId); await member(userId, Number(project.workspace_id), ['owner', 'admin']); return userId }
  if (payload.kind === 'integration') {
    const integrationKeyId = identifier(payload.integrationKeyId)
    if (!await one("SELECT id FROM support_api_keys WHERE id = ? AND project_id = ? AND workspace_id = ? AND scope = 'write' AND revoked_at = 0", [integrationKeyId, project.id, project.workspace_id])) fail(401, 'import_authorization_revoked', 'The initiating integration key was revoked. Reconcile this migration before continuing.')
    return { integrationKeyId }
  }
  fail(409, 'import_actor_invalid', 'The persisted migration principal requires operator review.')
}
async function importRecord(project: Row, item: { type: string, payload: Row }, bundle: IntercomBundle, author: () => Promise<KnowledgeAuthor>, archive?: ImportArchive) {
  if (item.type === 'contact') return await importContact(project, item.payload)
  if (item.type === 'conversation') {
    if (bundle.attachmentFiles.size) await author()
    return await importConversation(project, item.payload, bundle, archive)
  }
  const context = { fingerprint, external, timestamp, mapping, remember, author, defaultLocale: bundle.articleLocale }
  return item.type === 'collection' ? await importIntercomCollection(project, item.payload, context) : await importIntercomArticle(project, item.payload, context)
}
async function importContact(project: Row, source: Row) {
  const id = external(source.id), previous = await mapping(project, 'contact', id)
  if (previous) {
    const current = await one('SELECT * FROM support_contacts WHERE id = ? AND project_id = ?', [previous.target_id, project.id])
    if (!current) fail(409, 'import_target_missing', 'A previously mapped contact was removed. Review erasure/retention before importing again.')
    if (previous.source_hash === fingerprint(source)) return { id: current.id, skipped: true }
  }
  const externalId = source.external_id ? text(source.external_id, 'external_id', 255) : `intercom:${id}`
  const current = previous ? await one('SELECT * FROM support_contacts WHERE id = ? AND project_id = ?', [previous.target_id, project.id]) : await one('SELECT * FROM support_contacts WHERE external_id = ? AND project_id = ?', [externalId, project.id])
  const companies = object(source.companies).data, tags = object(source.tags).data ?? object(source.tags).tags
  const attrs = current ? object(JSON.parse(String(current.attributes))) : {}
  attrs.intercom = { id, customAttributes: object(source.custom_attributes), companies: Array.isArray(companies) ? companies : [], tags: Array.isArray(tags) ? tags : [] }
  const values = { externalId, name: String(current?.name || source.name || '').slice(0, 200), email: String(current?.email || source.email || '').trim().toLowerCase().slice(0, 254), company: String(current?.company || (Array.isArray(companies) ? object(companies[0]).name : '') || '').slice(0, 200), attributes: attrs }
  // Stable external identity only. Email never links to a contact or a native user.
  const row = current || await contact(project, values)
  if (current) await query('UPDATE support_contacts SET name = ?, email = ?, company = ?, attributes = ?, updated_at = ? WHERE id = ? AND project_id = ?', [values.name, values.email, values.company, JSON.stringify(attrs), new Date().toISOString(), current.id, project.id])
  await remember(project, 'contact', id, row.id, source)
  return { id: row.id, skipped: false }
}
async function messageBody(value: unknown, format: IntercomBundle['format']) {
  if (typeof value !== 'string' || !value.trim()) fail(422, 'source_body_missing', 'Source message body is missing/redacted. The supplied record is retained for review.')
  if (value.length > 20000) fail(422, 'source_body_too_large', 'Source message exceeds the native message bound and requires review.')
  return format === 'plaintext' ? value : await knowledgeText(value, 'html')
}
function authorType(author: Row) {
  if (['user', 'lead', 'contact'].includes(String(author.type))) return 'customer'
  if (author.type === 'admin') return 'agent'
  if (author.type === 'bot') return 'automation'
  fail(422, 'unsupported_source_author', 'Unknown source author type is retained for review rather than attributed to an invented agent.')
}
async function importMessage(project: Row, conversation: Row, sourceId: string, source: Row, bundle: IntercomBundle, created: unknown, visibility: 'public' | 'internal', staged: ImportAttachment[]) {
  if (source.redacted === true) fail(422, 'source_body_missing', 'Source message was redacted and requires review.')
  const at = timestamp(created, 'message.created_at')
  const files = sourceAttachments(source, sourceId, bundle.attachmentFiles, visibility)
  const hashInput = files.length ? { source, attachmentHashes: files.map(file => file.sha256) } : source
  const previous = await mapping(project, 'message', sourceId)
  if (previous) {
    if (previous.source_hash !== fingerprint(hashInput)) fail(409, 'source_message_changed', 'Previously imported message content changed in the source. Native history was preserved for review.')
    const message = await one('SELECT created_at FROM support_messages WHERE id = ? AND conversation_id = ? AND project_id = ?', [previous.target_id, conversation.id, project.id])
    if (!message) fail(409, 'import_target_missing', 'A previously mapped message was removed. Review erasure/retention before importing again.')
    if (parseSqlDateTime(message.created_at)?.getTime() !== Date.parse(at)) fail(409, 'source_message_timestamp_changed', 'The source message timestamp differs from the imported message. Native history was preserved for review.')
    await checkImportedAttachments(project, conversation, files)
    return false
  }
  const body = files.length && source.body === '' ? '' : await messageBody(source.body, bundle.format)
  const author = authorType(object(source.author))
  const message = await insert('support_messages', { workspace_id: project.workspace_id, project_id: project.id, conversation_id: conversation.id, contact_id: conversation.contact_id, body, visibility, author_type: author, author_id: 0, delivery_status: 'imported' })
  await query('UPDATE support_messages SET created_at = ?, updated_at = ? WHERE id = ?', [at, at, message.id])
  await remember(project, 'message', sourceId, message.id, source, hashInput)
  staged.push(...files)
  return true
}
function nextPage(value: unknown): number | null {
  if (value === null) return null
  if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value)
  const record = object(value)
  if (Number.isSafeInteger(record.page) && Number(record.page) > 0) return Number(record.page)
  const cursor = typeof value === 'string' ? URL.parse(value) : null
  if (cursor) {
    const partFilters = ['include_part_types', 'exclude_part_types', 'parts_created_after', 'parts_created_before']
    if (partFilters.some(name => cursor.searchParams.has(name)))
      fail(422, 'incomplete_source_history', 'A source page cursor filters conversation parts. Retrieve every unfiltered page.')
    const page = Number(cursor.searchParams.get('page'))
    if (Number.isSafeInteger(page) && page > 0) return page
  }
  fail(422, 'incomplete_source_history', 'Conversation page continuation must identify the next numbered page.')
}
function completeConversation(source: Row): Row {
  if (!Array.isArray(source.pages)) return source
  if (!source.pages.length || source.pages.length > 100) fail(422, 'incomplete_source_history', 'Supply an ordered page sequence beginning at page one.')
  let first: { response: Row, id: string, createdAt: string } | undefined
  let recordedUpdate: { normalized: string, original: unknown } | undefined
  let expected = 1, pageSize: number | undefined
  const parts: Row[] = [], seen = new Set<string>(), provenance: Row[] = []
  for (const wrapper of source.pages) {
    const page = object(wrapper), response = object(page.response), container = object(response.conversation_parts), paging = object(container.pages)
    if (page.page !== expected || !Array.isArray(container.conversation_parts) || !Object.hasOwn(paging, 'next')) fail(422, 'incomplete_source_history', 'Every supplied response page must have its sequential page number and next cursor.')
    const { createdAt, updatedAt } = conversationDates(response)
    const id = external(response.id)
    first ??= { response, id, createdAt }
    if (id !== first.id || container.conversation_parts.length > importLimits.maximumConversationParts) fail(422, 'incomplete_source_history', 'All pages must belong to the same conversation within the source page bound.')
    if (paging.page !== undefined && Number(paging.page) !== expected) fail(422, 'incomplete_source_history', 'Source page metadata does not match the requested sequence.')
    const partCount = container.conversation_parts.length, last = expected === source.pages.length
    if (container.total_count != null && Number(container.total_count) !== partCount)
      fail(422, 'incomplete_source_history', 'A page contains a different number of parts than its source response reports.')
    const emptyConversation = source.pages.length === 1 && partCount === 0
    if (paging.total_pages != null && Number(paging.total_pages) !== source.pages.length
      && !(emptyConversation && Number(paging.total_pages) === 0))
      fail(422, 'incomplete_source_history', 'The supplied page count disagrees with the source response.')
    if (paging.per_page != null) {
      const declaredSize = Number(paging.per_page)
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > importLimits.maximumConversationParts
        || (pageSize !== undefined && declaredSize !== pageSize) || partCount > declaredSize || (!last && partCount !== declaredSize))
        fail(422, 'incomplete_source_history', 'Conversation pages must use a consistent size and include all reported parts.')
      pageSize = declaredSize
    }
    if (first.createdAt !== createdAt || (recordedUpdate && updatedAt !== undefined && recordedUpdate.normalized !== updatedAt))
      fail(422, 'incomplete_source_history', 'The source conversation changed between page requests. Retrieve its pages again.')
    if (updatedAt !== undefined) recordedUpdate ??= { normalized: updatedAt, original: response.updated_at }
    const next = nextPage(paging.next)
    if ((last && next !== null) || (!last && next !== expected + 1)) fail(422, 'incomplete_source_history', 'The page chain must be contiguous and terminate with next:null.')
    for (const candidate of container.conversation_parts) { const part = object(candidate), key = external(part.id); if (seen.has(key)) fail(422, 'duplicate_source_part', 'A part occurs on more than one page. Review the export before migrating.'); seen.add(key); parts.push(part) }
    provenance.push({ page: expected, next, responseHash: fingerprint(response) }); expected++
  }
  if (parts.length > importLimits.maximumPaginatedParts) fail(422, 'source_parts_limit', 'A paginated conversation exceeds the 5000-part operational batch bound.')
  return { ...first!.response, ...(recordedUpdate ? { updated_at: recordedUpdate.original } : {}), conversation_parts: { conversation_parts: parts, total_count: parts.length, pages: { page: 1, next: null }, complete_page_sequence: true }, import_page_provenance: provenance }
}
async function importConversation(project: Row, source: Row, bundle: IntercomBundle, archive?: ImportArchive) {
  const paginated = Array.isArray(source.pages)
  source = completeConversation(source)
  const id = external(source.id), partsContainer = object(source.conversation_parts), parts = partsContainer.conversation_parts
  if (!Array.isArray(parts)) fail(422, 'full_conversation_required', 'List/search items omit message parts. Supply a full retrieve-conversation response.')
  const paging = object(partsContainer.pages), completePages = paginated || (Number(paging.page) === 1 && Object.hasOwn(paging, 'next') && paging.next === null)
  if ((!completePages && parts.length >= importLimits.maximumConversationParts) || (!paginated && parts.length > importLimits.maximumConversationParts) || Number(partsContainer.total_count ?? parts.length) > parts.length || (paging.next !== undefined && paging.next !== null)) fail(422, 'incomplete_source_history', 'Unpaged 500-part or unfinished response histories are retained for review. Supply every numbered source page through next:null.')
  const contacts = object(source.contacts).contacts ?? object(source.contacts).data
  if (!Array.isArray(contacts) || contacts.length !== 1) fail(422, 'group_conversation_review', 'This importer requires exactly one source contact. Group conversations are retained for review.')
  const { createdAt, updatedAt = createdAt } = conversationDates(source)
  const initial = object(source.source)
  const contactReference = object(contacts[0]), contactId = external(contactReference.id), existingContact = await mapping(project, 'contact', contactId)
  const who = existingContact ? (await one('SELECT * FROM support_contacts WHERE id = ? AND project_id = ?', [existingContact.target_id, project.id])) : undefined
  if (existingContact && !who) fail(409, 'import_target_missing', 'Mapped source contact was removed. Review before recreating it.')
  const targetContact = who || (await one('SELECT * FROM support_contacts WHERE id = ?', [(await importContact(project, contactReference)).id]))!
  const state = String(source.state)
  if (!['open', 'closed', 'snoozed'].includes(state)) fail(422, 'unsupported_source_state', 'Unknown source conversation state requires review.')
  const previous = await mapping(project, 'conversation', id)
  let row = previous ? await one('SELECT * FROM support_conversations WHERE id = ? AND project_id = ?', [previous.target_id, project.id]) : undefined
  if (previous && !row) fail(409, 'import_target_missing', 'Mapped source conversation was removed. Review before recreating it.')
  if (row && Number(row.contact_id) !== Number(targetContact.id)) fail(409, 'source_contact_changed', 'Source contact ownership changed. Existing native ownership was preserved.')
  const newConversation = !row
  const statisticsClosed = object(source.statistics).last_close_at
  const closedAt = source.closed_at == null ? undefined : timestamp(source.closed_at, 'closed_at')
  const lastClosedAt = statisticsClosed == null ? undefined : timestamp(statisticsClosed, 'statistics.last_close_at')
  if (closedAt !== undefined && lastClosedAt !== undefined && closedAt !== lastClosedAt) fail(422, 'invalid_source_timestamp', 'Export resolution timestamps disagree. Review the original source.')
  const closed = closedAt ?? lastClosedAt
  let resolvedAt = 0
  if (state === 'closed' && closed !== undefined) {
    if (closed < createdAt || closed > updatedAt) fail(422, 'invalid_source_timestamp', 'Resolution time must belong to the exported conversation history.')
    resolvedAt = Date.parse(closed)
  }
  if (!row) {
    row = await insert('support_conversations', { workspace_id: project.workspace_id, project_id: project.id, contact_id: targetContact.id, subject: text(source.title || initial.subject || `Imported conversation ${id}`, 'subject', 200), status: state, resolved_at: resolvedAt, unread_count: 0, channel: 'intercom-import' })
    await query('UPDATE support_conversations SET created_at = ?, updated_at = ? WHERE id = ?', [createdAt, updatedAt, row.id])
  }
  const staged: ImportAttachment[] = []
  const initialTime = initial.created_at === undefined ? source.created_at : initial.created_at
  let appended = await importMessage(project, row, `${id}:source:${initial.id == null ? 'root' : external(initial.id)}`, initial, bundle, initialTime, 'public', staged) ? 1 : 0
  for (const candidate of parts) {
    const part = object(candidate), partId = external(part.id), kind = String(part.part_type)
    if (kind === 'comment' || kind === 'note') appended += await importMessage(project, row, `${id}:part:${partId}`, part, bundle, part.created_at, kind === 'note' ? 'internal' : 'public', staged) ? 1 : 0
    else if ((part.body != null && part.body !== '') || (Array.isArray(part.attachments) && part.attachments.length)) fail(422, 'unsupported_source_part', 'Unknown message-bearing conversation part is retained for review rather than silently skipped.')
    else await remember(project, 'part_metadata', `${id}:${partId}`, 0, part)
  }
  await remember(project, 'conversation', id, row.id, source)
  await storeImportedAttachments(project, row, staged, archive)
  return { id: row.id, skipped: !newConversation && appended === 0 }
}
export async function processImportBatch(id: unknown, options: { batchSize?: number } = {}) {
  const runId = identifier(id), batchSize = Math.min(importLimits.batch, Math.max(1, options.batchSize ?? importLimits.batch))
  const initial = await one('SELECT * FROM support_import_runs WHERE id = ?', [runId])
  if (!initial) fail(404, 'not_found', 'Migration run not found.')
  const claimed: Row | null = await workspaceTransaction(Number(initial.workspace_id), async () => {
    const row = await one('SELECT * FROM support_import_runs WHERE id = ?', [runId])
    if (!row || !['ready', 'running'].includes(String(row.status)) || Number(row.lease_until) > Date.now()) return null
    const lease = secret()
    await query("UPDATE support_import_runs SET status = 'running', lease_token = ?, lease_until = ?, last_error = '' WHERE id = ?", [lease, Date.now() + importLimits.leaseMs, runId])
    return { ...row, lease_token: lease }
  })
  if (!claimed) return { advanced: 0 }
  try {
    const bytes = await Storage.disk(String(claimed.source_disk)).readToBuffer(String(claimed.source_key))
    if (bytes.byteLength !== Number(claimed.source_bytes) || createHash('sha256').update(bytes).digest('hex') !== claimed.source_hash) fail(409, 'source_archive_changed', 'Private migration source failed its stored byte/hash verification.')
    const bundle = parseIntercomBundle(new Uint8Array(bytes)), records = importRecords(bundle)
    let advanced = 0
    for (let count = 0; count < batchSize; count++) {
      const result = await workspaceTransaction(Number(claimed.workspace_id), async () => {
        const run = await one('SELECT * FROM support_import_runs WHERE id = ?', [runId])
        if (!run || run.status !== 'running' || run.lease_token !== claimed.lease_token) return false
        const cursor = Number(run.cursor), item = records[cursor]
        if (!item) return false
        const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [run.project_id, run.workspace_id]))!
        let outcome: { id?: unknown, skipped?: boolean, message?: string } = {}, review: SupportError | undefined
        try {
          outcome = await db.transaction(async () => await importRecord(project, item, bundle, () => importRunAuthor(project, runId), { disk: String(run.source_disk), key: String(run.source_key) }))
        }
        catch (error) { if (error instanceof SupportError) review = error; else throw error }
        const status = review ? 'needs_review' : outcome.skipped ? 'skipped' : 'imported', previous = await one('SELECT id, status, target_id FROM support_import_records WHERE import_run_id = ? AND position = ?', [run.id, cursor])
        const recordStatus = status === 'skipped' && previous?.status === 'imported' && Number(previous.target_id) === Number(outcome.id) ? 'imported' : status
        const firstPage = item.type === 'conversation' && Array.isArray(item.payload.pages) ? object(object(item.payload.pages[0]).response) : undefined
        const sourceId = item.payload.id ?? firstPage?.id
        const report = { entity_type: item.type, external_id: typeof sourceId === 'string' || typeof sourceId === 'number' ? String(sourceId).slice(0, 200) : '(missing)', status: recordStatus, target_id: outcome.id ?? 0, error_code: review?.code || '', message: review?.message || outcome.message || '', source_payload: JSON.stringify(item.payload) }
        if (previous) await query('UPDATE support_import_records SET status = ?, target_id = ?, error_code = ?, message = ?, source_payload = ?, updated_at = ? WHERE id = ?', [report.status, report.target_id, report.error_code, report.message, report.source_payload, new Date().toISOString(), previous.id])
        else await insert('support_import_records', { workspace_id: run.workspace_id, project_id: run.project_id, import_run_id: run.id, position: cursor, ...report })
        const totals = await query('SELECT status, COUNT(*) AS count FROM support_import_records WHERE import_run_id = ? GROUP BY status', [run.id])
        const countOf = (state: string) => Number(totals.find(row => row.status === state)?.count || 0), imported = countOf('imported'), skipped = countOf('skipped'), failed = countOf('needs_review'), complete = cursor + 1 >= records.length
        await query('UPDATE support_import_runs SET cursor = ?, processed = ?, imported = ?, skipped = ?, failed = ?, status = ?, lease_until = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [cursor + 1, imported + skipped + failed, imported, skipped, failed, complete ? failed ? 'needs_review' : 'completed' : 'running', complete ? 0 : Date.now() + importLimits.leaseMs, new Date().toISOString(), run.id, claimed.lease_token])
        return true
      })
      if (!result) break
      advanced++
    }
    await workspaceTransaction(Number(claimed.workspace_id), async () => {
      const current = await one('SELECT * FROM support_import_runs WHERE id = ?', [runId])
      if (current?.status === 'running' && current.lease_token === claimed.lease_token) {
        await query("UPDATE support_import_runs SET status = 'ready', lease_until = 0 WHERE id = ?", [runId])
        await storeJob('RunSupportImport', { queue: 'support-imports', payload: { runId }, maxTries: 5, timeout: 60 })
      }
    })
    return { advanced, run: runView((await one('SELECT * FROM support_import_runs WHERE id = ?', [runId]))!) }
  }
  catch (error) {
    await query('UPDATE support_import_runs SET status = ?, lease_until = 0, last_error = ? WHERE id = ? AND lease_token = ?', [error instanceof SupportError ? 'needs_review' : 'ready', error instanceof SupportError ? error.message : 'Import worker failed. Native worker may retry.', runId, claimed.lease_token])
    throw error
  }
}
export async function listImports(project: Row, principal: ImportPrincipal) {
  await authorizeImport(project, principal)
  return { runs: (await query('SELECT * FROM support_import_runs WHERE workspace_id = ? AND project_id = ? ORDER BY id DESC LIMIT 100', [project.workspace_id, project.id])).map(runView), limits: importLimits }
}
export async function importStatus(project: Row, principal: ImportPrincipal, id: unknown) {
  await authorizeImport(project, principal)
  const run = await runFor(project, id)
  const records = await query('SELECT position, entity_type, external_id, status, target_id, error_code, message FROM support_import_records WHERE import_run_id = ? ORDER BY position LIMIT 5000', [run.id])
  return { run: runView(run), records, sourceArchiveRetained: await Storage.disk(String(run.source_disk)).fileExists(String(run.source_key)) }
}
export async function controlImport(project: Row, principal: ImportPrincipal, id: unknown, operation: 'pause' | 'resume') {
  await authorizeImport(project, principal)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await authorizeImport(project, principal)
    const run = await runFor(project, id)
    if (operation === 'pause') {
      if (['uploading', 'completed'].includes(String(run.status))) fail(409, 'import_state', 'This migration run cannot be paused.')
      await query("UPDATE support_import_runs SET status = 'paused', lease_until = 0, updated_at = ? WHERE id = ?", [new Date().toISOString(), run.id])
    }
    else {
      if (run.status === 'running' && Number(run.lease_until) > Date.now()) fail(409, 'import_busy', 'A live worker owns this migration. Wait for its checkpoint.')
      if (run.status === 'uploading') fail(409, 'import_upload_pending', 'Finish uploading the same source archive first.')
      const failed = await one("SELECT MIN(position) AS position FROM support_import_records WHERE import_run_id = ? AND status = 'needs_review'", [run.id])
      const cursor = failed?.position == null ? Number(run.cursor) : Number(failed.position)
      if (cursor >= Number(run.total_records)) return { run: runView(run), resumed: false }
      await query("UPDATE support_import_runs SET status = 'ready', cursor = ?, lease_token = '', lease_until = 0, last_error = '', updated_at = ? WHERE id = ?", [cursor, new Date().toISOString(), run.id])
      await storeJob('RunSupportImport', { queue: 'support-imports', payload: { runId: run.id }, maxTries: 5, timeout: 60 })
    }
    return { run: runView(await runFor(project, run.id)), resumed: operation === 'resume' }
  })
}
export async function recoverImportRuns(limit = 10) {
  const rows = await query("SELECT id FROM support_import_runs WHERE status IN ('ready', 'running') AND lease_until <= ? ORDER BY id LIMIT ?", [Date.now(), Math.min(50, Math.max(1, limit))])
  let advanced = 0
  for (const row of rows) advanced += (await processImportBatch(row.id)).advanced
  return { advanced, runs: rows.length }
}

function safeIntegrationRun(row: Row) {
  const publicRow: Row = 'source_name' in row ? runView(row) : row
  return Object.fromEntries(['id', 'status', 'totalRecords', 'cursor', 'processed', 'imported', 'skipped', 'failed'].map(key => [key, publicRow[key]]))
}
export function integrationImportResult(value: Row): Row {
  return { ...(value.run ? { run: safeIntegrationRun(object(value.run)) } : {}), ...(value.duplicate === undefined ? {} : { duplicate: value.duplicate }), ...(value.resumed === undefined ? {} : { resumed: value.resumed }) }
}
export async function integrationImportStatus(project: Row, principal: ImportPrincipal, id: unknown) {
  await authorizeImport(project, principal)
  return { run: safeIntegrationRun(await runFor(project, id)) }
}
class PreviewRollback extends Error {
  constructor(readonly reports: { status: string, code: string, message: string }[]) { super('Migration preview rollback') }
}
export async function previewIntercomBundle(project: Row, principal: ImportPrincipal, file: File) {
  await authorizeImport(project, principal)
  if (!file.size || file.size > importLimits.bytes) fail(413, 'import_size', 'Migration bundles must be 1 to 10000000 bytes.')
  const bundle = parseIntercomBundle(new Uint8Array(await file.arrayBuffer())), records = importRecords(bundle)
  try {
    await workspaceTransaction(Number(project.workspace_id), async () => {
      await authorizeImport(project, principal)
      const reports: { status: string, code: string, message: string }[] = []
      for (const item of records) {
        try {
          const result = await db.transaction(async () => await importRecord(project, item, bundle, () => importPrincipalAuthor(project, principal)))
          reports.push({ status: result.skipped ? 'skipped' : 'compatible', code: '', message: '' })
        }
        catch (error) { if (error instanceof SupportError) reports.push({ status: 'needs_review', code: error.code, message: error.message }); else throw error }
      }
      // Without an archive destination, even the attachment metadata and quota rehearsal is SQL only.
      throw new PreviewRollback(reports)
    })
  }
  catch (error) {
    if (!(error instanceof PreviewRollback)) throw error
    const reasons = new Map<string, { code: string, count: number, message: string }>()
    for (const report of error.reports) if (report.code) { const reason = reasons.get(report.code) || { code: report.code, count: 0, message: report.message }; reason.count++; reasons.set(report.code, reason) }
    return { dryRun: true, totalRecords: records.length, compatibleRecords: error.reports.filter(item => item.status === 'compatible').length, skippedRecords: error.reports.filter(item => item.status === 'skipped').length, reviewRecords: error.reports.filter(item => item.status === 'needs_review').length, reasons: [...reasons.values()] }
  }
  throw new Error('Migration preview did not roll back')
}
