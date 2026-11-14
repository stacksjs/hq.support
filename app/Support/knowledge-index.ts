import { createDurableRetrievalStore } from '@stacksjs/ai/durable-retrieval'
import type { ConfiguredEmbeddingClient } from '@stacksjs/ai/embedding-client'
import { createConfiguredEmbeddingClient } from '@stacksjs/ai/embedding-client'
import { chunkDocument } from '@stacksjs/ai/documents'
import { config, overridesReady } from '@stacksjs/config'
import { resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier } from './errors'
import { digest, member } from './service'
import { periodOf } from './limits'
import { recoverIndexingReservations, releaseIndexing, reserveIndexing, settleIndexing } from './indexing-budget'

const tables = { sources: 'support_knowledge_sources', indexes: 'support_knowledge_indexes', chunks: 'support_knowledge_chunks' }
export type KnowledgePrincipal = { kind: 'public' } | { kind: 'customer', contactId: number } | { kind: 'agent', userId: number }
function dialect(): 'postgres' | 'sqlite' {
  const driver = resolvedDatabaseConfig().driver
  if (driver !== 'postgres' && driver !== 'sqlite') fail(503, 'retrieval_driver_unavailable', 'Knowledge retrieval requires PostgreSQL or SQLite.')
  return driver
}
function contentHash(article: Row) { return digest(JSON.stringify({ body: article.body, title: article.title, revision: Number(article.revision), locale: article.locale, visibility: article.visibility, status: article.status })) }
async function embeddingClient() {
  await overridesReady
  try { return createConfiguredEmbeddingClient(config.ai) }
  catch { fail(503, 'embedding_unavailable', 'Configure an OpenAI or Ollama embedding provider before indexing PostgreSQL knowledge.') }
}
export async function knowledgeIndexCapabilities(project?: Row) {
  const selected = dialect()
  const store = createDurableRetrievalStore({ dialect: selected, query, tables })
  const extensionAvailable = await store.available()
  let embeddingConfigured = selected === 'sqlite'
  if (selected === 'postgres') {
    try { await embeddingClient(); embeddingConfigured = true }
    catch { embeddingConfigured = false }
  }
  const counts = project ? await one("SELECT COUNT(*) AS total, SUM(CASE WHEN ki.dimensions > 0 THEN 1 ELSE 0 END) AS vectors FROM support_knowledge_sources s LEFT JOIN support_knowledge_indexes ki ON ki.id = s.active_index_id WHERE s.project_id = ? AND s.workspace_id = ? AND s.deleted_at = 0 AND s.permission_granted = ? AND s.publication = 'published'", [project.id, project.workspace_id, true]) : undefined
  const totalSources = Number(counts?.total ?? 0), vectorSources = Number(counts?.vectors ?? 0)
  return { totalSources, vectorSources, pendingVectorSources: selected === 'postgres' ? totalSources - vectorSources : 0, mode: selected === 'postgres' ? (extensionAvailable && embeddingConfigured && vectorSources > 0 ? 'pgvector' : 'fulltext') : 'lexical', persistent: true, extensionAvailable, embeddingConfigured, ready: true, vectorReady: selected === 'postgres' && extensionAvailable && embeddingConfigured, ranking: selected === 'postgres' ? (extensionAvailable && embeddingConfigured ? 'exact-cosine' : 'native-fulltext') : 'bounded-substring', approximateIndex: false, maxVectorDistance: 0.5, maximumAuthorizedSources: 10_000 }
}
async function clearIndexes(sourceId: unknown) {
  await query('DELETE FROM support_knowledge_chunks WHERE source_id = ?', [sourceId])
  await query("UPDATE support_knowledge_indexes SET status = 'retired', updated_at = ? WHERE source_id = ? AND status IN ('active', 'building')", [new Date().toISOString(), sourceId])
}
/** Called in the same workspace transaction as the authoritative article mutation. No provider I/O. */
export async function invalidateArticleIndex(project: Row, article: Row) {
  const existing = await one('SELECT * FROM support_knowledge_sources WHERE workspace_id = ? AND project_id = ? AND article_id = ?', [project.workspace_id, project.id, article.id])
  const fields = { current_revision: Number(article.revision), audience: article.visibility, language: article.locale, publication: article.status, active_index_id: 0, requested_token: '', indexing_lease_until: 0, last_error: '', deleted_at: 0 }
  let source: Row
  if (existing) {
    await clearIndexes(existing.id)
    const keys = Object.keys(fields)
    await query(`UPDATE support_knowledge_sources SET ${keys.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...Object.values(fields), new Date().toISOString(), existing.id])
    source = { ...existing, ...fields }
  }
  else source = await insert('support_knowledge_sources', { workspace_id: project.workspace_id, project_id: project.id, article_id: article.id, source_key: `article:${article.id}`, permission_granted: true, ...fields })
  // Native PostgreSQL full text and SQLite substring retrieval stay ready atomically with edits.
  // A provider-backed generation can replace this portable lexical generation after commit.
  if (article.status === 'published' && source.permission_granted) {
    const parts = chunkDocument({ id: String(article.id), content: `${article.title}\n\n${article.body}` }, { size: 600, overlap: 80 }).map(chunk => chunk.content)
    const index = await insert('support_knowledge_indexes', { workspace_id: project.workspace_id, project_id: project.id, source_id: source.id, revision: Number(article.revision), status: 'active', embedding_model: '', dimensions: 0, chunk_count: parts.length, content_hash: contentHash(article), owner_token: crypto.randomUUID() })
    for (const [position, content] of parts.entries()) await insert('support_knowledge_chunks', { workspace_id: project.workspace_id, project_id: project.id, source_id: source.id, index_id: index.id, revision: Number(article.revision), position, content, embedding: '', content_hash: digest(content) })
    await query('UPDATE support_knowledge_sources SET active_index_id = ? WHERE id = ?', [index.id, source.id])
  }
  return source
}

/** A full generation is prepared outside transactions, then activated with one revision/token CAS. */
export async function indexArticle(project: Row, id: unknown, options: { client?: ConfiguredEmbeddingClient, force?: boolean } = {}) {
  const articleId = identifier(id), selected = dialect()
  if (selected === 'sqlite') {
    return await workspaceTransaction(Number(project.workspace_id), async () => {
      const article = await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])
      if (!article) fail(404, 'not_found', 'Article not found.')
      await invalidateArticleIndex(project, article)
      return { indexed: article.status === 'published', mode: 'lexical', revision: Number(article.revision) }
    })
  }
  const store = createDurableRetrievalStore({ dialect: selected, query, tables })
  if (!await store.available()) fail(503, 'vector_unavailable', 'The model-declared PostgreSQL vector extension has not been migrated.')
  const client = options.client ?? await embeddingClient()
  await recoverIndexingReservations(Number(project.workspace_id))
  const prepared = await workspaceTransaction(Number(project.workspace_id), async () => {
    const article = await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])
    if (!article) fail(404, 'not_found', 'Article not found.')
    let source = await one('SELECT * FROM support_knowledge_sources WHERE article_id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])
    if (!source) source = await invalidateArticleIndex(project, article)
    if (article.status !== 'published' || Number(source.deleted_at) > 0 || !source.permission_granted) fail(409, 'source_unavailable', 'Only permitted published sources can be indexed.')
    if (source.requested_token && Number(source.indexing_lease_until) > Date.now() && !options.force) fail(409, 'index_busy', 'This source already has an active indexing attempt.')
    const owner = crypto.randomUUID(), hash = contentHash(article), period = periodOf()
    const parts = chunkDocument({ id: String(article.id), content: `${article.title}\n\n${article.body}` }, { size: 600, overlap: 80 }).map(chunk => chunk.content)
    if (!parts.length || parts.length > 300) fail(422, 'chunk_limit', 'A source must contain between one and 300 knowledge chunks.')
    const reserved = parts.reduce((total, part) => total + new TextEncoder().encode(part).length + 64, 0)
    await reserveIndexing(Number(project.workspace_id), reserved, period)
    const index = await insert('support_knowledge_indexes', { workspace_id: project.workspace_id, project_id: project.id, source_id: source.id, revision: Number(article.revision), status: 'building', period, reserved_tokens: reserved, reservation_state: 'held', lease_until: Date.now() + 90_000, embedding_model: client.model, dimensions: client.dimensions ?? 0, chunk_count: 0, content_hash: hash, owner_token: owner })
    await query('UPDATE support_knowledge_sources SET requested_token = ?, indexing_lease_until = ?, last_error = ? WHERE id = ?', [owner, Date.now() + 90_000, '', source.id])
    return { source, article, index, owner, hash, parts, reserved }
  })
  try {
    const parts = prepared.parts
    const vectors: number[][] = [], signal = AbortSignal.timeout(60_000)
    let reportedTokens = 0, usageReported = true
    for (let offset = 0; offset < parts.length; offset += 32) {
      const batch = await client.embedWithUsage(parts.slice(offset, offset + 32), { signal })
      vectors.push(...batch.vectors)
      if (batch.inputTokens === null || batch.inputTokens <= 0) usageReported = false
      else reportedTokens += batch.inputTokens
    }
    return await workspaceTransaction(Number(project.workspace_id), async () => {
      const source = await one('SELECT * FROM support_knowledge_sources WHERE id = ? AND project_id = ? AND workspace_id = ?', [prepared.source.id, project.id, project.workspace_id])
      const article = await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])
      if (!source || !article || source.requested_token !== prepared.owner || Number(source.indexing_lease_until) <= Date.now() || Number(source.current_revision) !== Number(prepared.article.revision) || source.publication !== 'published' || Number(source.deleted_at) > 0 || !source.permission_granted || contentHash(article) !== prepared.hash) fail(409, 'index_superseded', 'The source changed while indexing. A stale generation was not activated.')
      const held = await one("SELECT * FROM support_knowledge_indexes WHERE id = ? AND owner_token = ? AND reservation_state = 'held'", [prepared.index.id, prepared.owner])
      if (!held) fail(409, 'index_reservation_lost', 'The indexing reservation expired before activation.')
      await settleIndexing(held, usageReported ? reportedTokens : prepared.reserved, usageReported ? 'reported' : 'conservative')
      await clearIndexes(source.id)
      for (const [position, content] of parts.entries()) await insert('support_knowledge_chunks', { workspace_id: project.workspace_id, project_id: project.id, source_id: source.id, index_id: prepared.index.id, revision: Number(article.revision), position, content, embedding: JSON.stringify(vectors[position]), content_hash: digest(content) })
      await query("UPDATE support_knowledge_indexes SET status = 'active', dimensions = ?, chunk_count = ?, updated_at = ? WHERE id = ? AND owner_token = ?", [vectors[0]!.length, parts.length, new Date().toISOString(), prepared.index.id, prepared.owner])
      await query('UPDATE support_knowledge_sources SET active_index_id = ?, requested_token = ?, indexing_lease_until = 0, last_error = ? WHERE id = ? AND requested_token = ?', [prepared.index.id, '', '', source.id, prepared.owner])
      return { indexed: true, mode: 'pgvector', revision: Number(article.revision), chunks: parts.length, dimensions: vectors[0]!.length, model: client.model }
    })
  }
  catch (error) {
    await workspaceTransaction(Number(project.workspace_id), async () => {
      await releaseIndexing(prepared.index.id, Number(project.workspace_id), prepared.owner)
      await query("UPDATE support_knowledge_indexes SET status = 'failed', updated_at = ? WHERE id = ? AND owner_token = ? AND status <> 'active'", [new Date().toISOString(), prepared.index.id, prepared.owner])
      await query('UPDATE support_knowledge_sources SET requested_token = ?, indexing_lease_until = ?, last_error = ? WHERE id = ? AND requested_token = ?', ['', Date.now() + 60_000, 'Indexing failed or the source changed. Retry this revision.', prepared.source.id, prepared.owner])
    })
    throw error
  }
}
export async function retrieveKnowledge(project: Row, question: string, language: string, principal: KnowledgePrincipal) {
  const internal = principal.kind === 'agent'
  if (internal) await member(principal.userId, Number(project.workspace_id))
  if (principal.kind === 'customer' && !await one('SELECT id FROM support_contacts WHERE id = ? AND project_id = ? AND workspace_id = ?', [principal.contactId, project.id, project.workspace_id])) fail(403, 'forbidden', 'Knowledge access denied.')
  const rows = await query(`SELECT s.id AS source_id, ki.embedding_model, ki.dimensions, a.* FROM support_knowledge_sources s JOIN support_knowledge_indexes ki ON ki.id = s.active_index_id AND ki.source_id = s.id JOIN support_articles a ON a.id = s.article_id AND a.project_id = s.project_id AND a.workspace_id = s.workspace_id WHERE s.workspace_id = ? AND s.project_id = ? AND s.language = ? AND a.locale = ? AND s.publication = 'published' AND a.status = 'published' AND s.permission_granted = ? AND s.deleted_at = 0 AND s.current_revision = a.revision AND s.active_index_id > 0${internal ? '' : " AND s.audience = 'public' AND a.visibility = 'public'"} ORDER BY s.id LIMIT 10001`, [project.workspace_id, project.id, language, language, true])
  if (rows.length > 10000) fail(503, 'source_limit', 'This retrieval adapter supports up to 10,000 authorized sources per query.')
  const selected = dialect()
  let client: ConfiguredEmbeddingClient | undefined
  if (selected === 'postgres') { try { client = await embeddingClient() } catch { /* Native full text remains available without an embedding provider. */ } }
  const vectorReady = Boolean(client && rows.some(row => Number(row.dimensions) > 0 && row.embedding_model === client!.model))
  const mode: 'pgvector' | 'fulltext' | 'lexical' = selected === 'postgres' ? (vectorReady ? 'pgvector' : 'fulltext') : 'lexical'
  if (!rows.length) return { articles: [], retrievalMode: mode }
  const store = createDurableRetrievalStore({ dialect: selected, query, tables, mode: vectorReady ? 'pgvector' : 'lexical' })
  const vector = vectorReady ? (await client!.embed([question], { signal: AbortSignal.timeout(20_000) }))[0] : undefined
  const normalized = question.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(term => !new Set('a an the i me my we our you your it is are was be do does did how what when where can could to of for in on at and or please help'.split(' ')).has(term)).join(' ') ?? ''
  if (!normalized) return { articles: [], retrievalMode: mode }
  const hits = await store.search({ scope: { workspaceId: String(project.workspace_id), projectId: String(project.id), audience: internal ? 'internal' : 'public', language, allowedSourceIds: rows.map(row => String(row.source_id)) }, query: normalized, ...(vector ? { vector, embeddingModel: client!.model } : {}), limit: 8 })
  const articles = []
  const seen = new Set<string>()
  for (const hit of hits) {
    if (hit.distance !== null && hit.distance > 0.5) continue
    if (seen.has(hit.sourceId)) continue
    const row = rows.find(candidate => String(candidate.source_id) === hit.sourceId)
    if (row) { articles.push({ ...row, body: hit.content, indexRevision: hit.revision }); seen.add(hit.sourceId) }
    if (articles.length === 4) break
  }
  return { articles, retrievalMode: mode }
}
/** Permission revocation and source removal are synchronous with chunk deletion. Caller owns transaction. */
export async function removeKnowledgeSource(project: Row, articleId: number) {
  const source = await one('SELECT id FROM support_knowledge_sources WHERE article_id = ? AND project_id = ? AND workspace_id = ?', [articleId, project.id, project.workspace_id])
  if (!source) return
  await clearIndexes(source.id)
  await query("UPDATE support_knowledge_sources SET deleted_at = ?, active_index_id = 0, requested_token = '', indexing_lease_until = 0 WHERE id = ?", [Date.now(), source.id])
}
export async function knowledgeIndexTick(limit = 10) {
  await recoverIndexingReservations()
  const legacy = await query("SELECT a.id AS article_id, p.* FROM support_articles a JOIN support_projects p ON p.id = a.project_id AND p.workspace_id = a.workspace_id LEFT JOIN support_knowledge_sources s ON s.article_id = a.id AND s.project_id = a.project_id AND s.workspace_id = a.workspace_id WHERE a.status = 'published' AND s.id IS NULL ORDER BY a.id LIMIT ?", [Math.min(50, Math.max(1, limit))])
  for (const project of legacy) await workspaceTransaction(Number(project.workspace_id), async () => {
    const article = await one("SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ? AND status = 'published'", [project.article_id, project.id, project.workspace_id])
    if (article && !await one('SELECT id FROM support_knowledge_sources WHERE article_id = ? AND project_id = ?', [article.id, project.id])) await invalidateArticleIndex(project, article)
  })
  const candidates = await query("SELECT s.article_id, p.* FROM support_knowledge_sources s LEFT JOIN support_knowledge_indexes ki ON ki.id = s.active_index_id JOIN support_projects p ON p.id = s.project_id AND p.workspace_id = s.workspace_id WHERE s.publication = 'published' AND s.permission_granted = ? AND s.deleted_at = 0 AND (s.active_index_id = 0 OR ki.dimensions = 0) AND s.indexing_lease_until <= ? ORDER BY s.id LIMIT ?", [true, Date.now(), Math.min(50, Math.max(1, limit))])
  let indexed = 0, deferred = 0
  for (const project of candidates) {
    try { await indexArticle(project, project.article_id); indexed++ }
    catch { deferred++ }
  }
  return { indexed, deferred }
}
