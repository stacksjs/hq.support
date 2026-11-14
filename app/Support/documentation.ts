import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { digest } from './service'
import { createArticle, updateArticle } from './knowledge'
import { fail, text } from './errors'

/** Only explicitly selected documents are synced; omitted sources are never removed. */
export async function syncDocumentation(project: Row, integrationKeyId: number, input: Row) {
  if (!Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > 20) fail(422, 'document_limit', 'Select between one and twenty documents per sync.')
  const ids = new Set<string>()
  const documents = input.documents.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(422, 'invalid_document', 'A document object is required.')
    const value = raw as Row
    const source = text(value.source, 'source', 300)
    if (source.startsWith('/') || source.includes('\\') || source.split('/').some(part => ['.', '..', ''].includes(part)) || !/\.md$/i.test(source)) fail(422, 'invalid_source', 'Use a relative Markdown document path.')
    if (ids.has(source)) fail(422, 'duplicate_source', 'Select each document once.')
    ids.add(source)
    if (value.visibility !== undefined && !['internal', 'public'].includes(String(value.visibility))) fail(422, 'invalid_visibility', 'Select internal or public visibility.')
    return { source, title: text(value.title, 'title', 200), body: text(value.body, 'body', 100000), locale: value.locale ?? 'en', visibility: value.visibility ?? 'internal', status: value.publish === true ? 'published' : 'draft' }
  })
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    if (!await one("SELECT id FROM support_api_keys WHERE id = ? AND project_id = ? AND workspace_id = ? AND scope = 'write' AND revoked_at = 0", [integrationKeyId, project.id, project.workspace_id])) fail(403, 'forbidden', 'Documentation integration access has been revoked.')
    const author = { integrationKeyId }
    const results = []
    for (const document of documents) {
      const hash = digest(JSON.stringify(document))
      const mapping = await one("SELECT * FROM support_import_mappings WHERE project_id = ? AND workspace_id = ? AND provider = 'stacks-docs' AND entity_type = 'article' AND external_id = ?", [project.id, project.workspace_id, document.source])
      const article = mapping ? await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [mapping.target_id, project.id, project.workspace_id]) : undefined
      if (mapping && !article) fail(409, 'source_conflict', 'A synced article has been removed. Review the source before resynchronizing.')
      if (mapping?.source_hash === hash) { results.push({ source: document.source, id: String(article!.id), revision: Number(article!.revision), changed: false }); continue }
      const previousRevision = mapping ? Number(JSON.parse(String(mapping.source_payload)).revision) : 0
      if (article && Number(article.revision) !== previousRevision) fail(409, 'revision_conflict', 'A synced article has manual edits. Review them before replacing the source.')
      const slug = `docs-${digest(document.source).slice(0, 24)}`
      const data = { ...document, slug, format: 'markdown', collection: 'Application documentation' }
      const updated = article ? await updateArticle(project, article.id, { ...data, revision: Number(article.revision) }, author) : await createArticle(project, data, author)
      const payload = JSON.stringify({ source: document.source, revision: updated.revision, integrationKeyId })
      if (mapping) await query('UPDATE support_import_mappings SET source_hash = ?, source_payload = ?, updated_at = ? WHERE id = ?', [hash, payload, new Date().toISOString(), mapping.id])
      else await insert('support_import_mappings', { workspace_id: project.workspace_id, project_id: project.id, provider: 'stacks-docs', entity_type: 'article', external_id: document.source, target_id: Number(updated.id), source_hash: hash, source_payload: payload })
      results.push({ source: document.source, id: updated.id, revision: updated.revision, changed: true })
    }
    return { documents: results }
  })
}
