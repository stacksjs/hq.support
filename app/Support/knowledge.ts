import type { Row } from './database'
import { config } from '@stacksjs/config'
import { ensureDatabaseConfigLoaded, resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { member } from './service'
import { invalidateArticleIndex, removeKnowledgeSource } from './knowledge-index'

export type KnowledgeScope = { internal?: boolean, publishedOnly?: boolean, locale?: string, collection?: string }
const snapshotFields = ['slug', 'title', 'body', 'status', 'visibility', 'locale', 'collection', 'revision'] as const
export function articleView(row: Row) {
  return { id: String(row.id), slug: String(row.slug), title: String(row.title), body: String(row.body), status: String(row.status), visibility: String(row.visibility), locale: String(row.locale), collection: String(row.collection), revision: Number(row.revision), updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at) }
}
export function localeOf(value: unknown = 'en') {
  const locale = text(value, 'locale', 35)
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) fail(422, 'invalid_input', 'Use a valid locale such as en or en-US.')
  return locale
}

/** Imports become plain text. No remote fetching, HTML rendering, or active markup survives. */
export async function knowledgeText(value: unknown, format: unknown = 'text') {
  const source = text(value, 'body', 100_000)
  if (!['text', 'markdown', 'html'].includes(String(format))) fail(422, 'invalid_input', 'Import format must be text, markdown, or html.')
  let result = '', blocked = 0
  const rewriter = new HTMLRewriter()
    .on('script,style,noscript,iframe,object,template,svg,math', { element(element) { blocked++; element.onEndTag(() => { blocked-- }) } })
    .on('p,div,br,li,h1,h2,h3,h4,tr,pre,blockquote', { element() { if (!blocked) result += '\n' } })
    .onDocument({ text(chunk) { if (!blocked) result += chunk.text } })
  await rewriter.transform(new Response(source, { headers: { 'content-type': 'text/html' } })).text()
  result = result.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      return code > 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF) ? String.fromCodePoint(code) : ''
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[entity.toLowerCase()] ?? original
  })
  if (format === 'markdown') result = result.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^```[^\n]*\n?|^```\s*$/gm, '').replace(/\*\*([^*]+)\*\*/g, '$1')
  // Data remains plain text even if an entity decoded to a literal angle bracket.
  return text(result.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\n{3,}/g, '\n\n'), 'body', 100_000)
}
function attributes(data: Row, previous?: Row) {
  const slug = text(data.slug ?? previous?.slug, 'slug', 200)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail(422, 'invalid_input', 'Slug must contain lowercase words separated by hyphens.')
  const status = String(data.status ?? previous?.status ?? 'draft'), visibility = String(data.visibility ?? previous?.visibility ?? 'public')
  if (!['draft', 'published', 'archived'].includes(status) || !['public', 'internal'].includes(visibility)) fail(422, 'invalid_input', 'Unknown article status or visibility.')
  return { slug, title: text(data.title ?? previous?.title, 'title', 200), status, visibility, locale: localeOf(data.locale ?? previous?.locale ?? 'en'), collection: text(data.collection ?? previous?.collection ?? 'General', 'collection', 120) }
}
export type KnowledgeAuthor = number | { integrationKeyId: number }
async function authorizeAuthor(project: Row, author: KnowledgeAuthor) {
  if (typeof author === 'number') return await member(author, Number(project.workspace_id), ['owner', 'admin'])
  if (!await one("SELECT id FROM support_api_keys WHERE id = ? AND project_id = ? AND workspace_id = ? AND scope = 'write' AND revoked_at = 0", [author.integrationKeyId, project.id, project.workspace_id])) fail(403, 'forbidden', 'Knowledge integration access has been revoked.')
}
async function recordRevision(project: Row, article: Row, author: KnowledgeAuthor) {
  await insert('support_article_revisions', { workspace_id: project.workspace_id, project_id: project.id, article_id: article.id, revision: article.revision, author_id: typeof author === 'number' ? author : 0, integration_key_id: typeof author === 'number' ? 0 : author.integrationKeyId, snapshot: JSON.stringify(Object.fromEntries(snapshotFields.map(key => [key, key === 'revision' ? Number(article[key]) : article[key]]))) })
}
export async function createArticle(project: Row, data: Row, authorId: KnowledgeAuthor) {
  await authorizeAuthor(project, authorId)
  const fields = attributes(data), body = await knowledgeText(data.body, data.format)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    if (await one('SELECT id FROM support_articles WHERE project_id = ? AND locale = ? AND slug = ?', [project.id, fields.locale, fields.slug])) fail(409, 'slug_conflict', 'This article slug already exists for this locale.')
    const row = await insert('support_articles', { workspace_id: project.workspace_id, project_id: project.id, ...fields, body, revision: 1 })
    await recordRevision(project, row, authorId)
    await invalidateArticleIndex(project, row)
    return articleView(row)
  })
}
export async function updateArticle(project: Row, id: unknown, data: Row, authorId: KnowledgeAuthor) {
  await authorizeAuthor(project, authorId)
  const imported = data.body === undefined ? undefined : await knowledgeText(data.body, data.format)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const row = await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])
    if (!row) fail(404, 'not_found', 'Article not found.')
    if (!Number.isSafeInteger(data.revision) || data.revision !== Number(row.revision)) fail(409, 'revision_conflict', 'Reload this article before saving a newer revision.')
    const fields = attributes(data, row)
    const duplicate = await one('SELECT id FROM support_articles WHERE project_id = ? AND locale = ? AND slug = ? AND id <> ?', [project.id, fields.locale, fields.slug, row.id])
    if (duplicate) fail(409, 'slug_conflict', 'This article slug already exists for this locale.')
    // Preserve the pre-edit version of articles created before revision tracking was enabled.
    if (!await one('SELECT id FROM support_article_revisions WHERE article_id = ? AND revision = ?', [row.id, row.revision])) await recordRevision(project, row, authorId)
    await query('UPDATE support_articles SET slug = ?, title = ?, body = ?, status = ?, visibility = ?, locale = ?, collection = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND project_id = ? AND workspace_id = ?', [fields.slug, fields.title, imported ?? row.body, fields.status, fields.visibility, fields.locale, fields.collection, new Date().toISOString(), row.id, project.id, project.workspace_id])
    const updated = (await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ?', [row.id, project.id]))!
    await recordRevision(project, updated, authorId)
    await invalidateArticleIndex(project, updated)
    return articleView(updated)
  })
}
const queryStopWords = new Set('a an the i me my we our you your it is are was be been do does did how what when where can could would should to of for in on at and or please help'.split(' '))
export function searchTerms(value: string) { return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(term => !queryStopWords.has(term)).slice(0, 12) }

/** Public delivery always intersects authoritative article state and any existing source grant. */
function publicArticleFilters(project: Row, scope: KnowledgeScope) {
  const values: unknown[] = [project.id, project.workspace_id]
  let where = "a.project_id = ? AND a.workspace_id = ? AND a.status = 'published' AND a.visibility = 'public'"
  // A missing source is a legacy public article awaiting backfill. An existing source must agree
  // with its authoritative binding, audience, language, revision and publication, and grant access.
  where += " AND NOT EXISTS (SELECT 1 FROM support_knowledge_sources ks WHERE ks.article_id = a.id AND (ks.project_id <> a.project_id OR ks.workspace_id <> a.workspace_id OR ks.permission_granted <> TRUE OR ks.deleted_at <> 0 OR ks.audience <> 'public' OR ks.publication <> 'published' OR ks.language <> a.locale OR ks.current_revision <> a.revision))"
  if (scope.locale) { where += ' AND a.locale = ?'; values.push(localeOf(scope.locale)) }
  if (scope.collection) { where += ' AND a.collection = ?'; values.push(text(scope.collection, 'collection', 120)) }
  return { where, values }
}
export function publicArticleUrl(project: Row, article: Row) {
  const configured = String(config.app.url || 'https://hq.support')
  const base = new URL(/^https?:\/\//.test(configured) ? configured : `https://${configured}`)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail(503, 'public_url_unavailable', 'The public help-center URL is not configured correctly.')
  const url = new URL('/help/article', base)
  url.searchParams.set('project', String(project.public_id))
  url.searchParams.set('slug', String(article.slug))
  url.searchParams.set('locale', String(article.locale))
  return url.toString()
}
function publicArticleView(project: Row, row: Row) { return { ...articleView(row), url: publicArticleUrl(project, row) } }
async function publicArticleSearch(project: Row, search: string, scope: KnowledgeScope) {
  if (search.length > 500) fail(422, 'search_too_long', 'Help search accepts at most 500 characters.')
  const suppliedTerms = [...new Set(search.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(term => !queryStopWords.has(term))
  if (suppliedTerms.length > 12) fail(422, 'search_too_many_terms', 'Help search accepts at most twelve distinct terms.')
  const terms = searchTerms(search), supplied = Boolean(search.trim())
  await ensureDatabaseConfigLoaded()
  const driver = resolvedDatabaseConfig().driver
  if (driver !== 'postgres' && driver !== 'sqlite') fail(503, 'search_driver_unavailable', 'Public help search requires PostgreSQL or SQLite.')
  const mode = supplied ? driver === 'postgres' ? 'fulltext' : 'lexical' : 'listing'
  const metadata = { mode, providerRequests: false, budgetMeter: null, indexedGenerationRequired: false, legacyArticlesIncluded: true, corpus: 'current-published-articles', sourceGrants: 'required-when-source-exists', queryTermLimit: 12, resultLimit: 50 }
  if (supplied && !terms.length) return { articles: [], retrievalMode: mode, search: { ...metadata, hasMore: false } }
  const filters = publicArticleFilters(project, scope), values = [...filters.values]
  // Article search does not need vector/chunk generations or an embedding provider. Reading the
  // current authorized article rows also keeps legacy public articles available during backfill.
  const permitted = `WITH permitted AS ${driver === 'postgres' ? 'MATERIALIZED ' : ''}(SELECT a.* FROM support_articles a WHERE ${filters.where})`
  let statement: string
  if (!supplied) statement = `${permitted} SELECT p.* FROM permitted p ORDER BY p.id DESC LIMIT 51`
  else if (driver === 'postgres') {
    const vector = "(setweight(to_tsvector('simple', p.title), 'A') || setweight(to_tsvector('simple', p.body), 'B'))"
    statement = `${permitted} SELECT p.*, ts_rank_cd(${vector}, plainto_tsquery('simple', ?)) AS search_rank FROM permitted p WHERE ${vector} @@ plainto_tsquery('simple', ?) ORDER BY search_rank DESC, p.id DESC LIMIT 51`
    values.push(terms.join(' '), terms.join(' '))
  }
  else {
    const scores = terms.map(term => { values.push(`%${term}%`, `%${term}%`); return '(CASE WHEN LOWER(p.title) LIKE ? THEN 4 ELSE 0 END + CASE WHEN LOWER(p.body) LIKE ? THEN 1 ELSE 0 END)' })
    const matches = terms.map(term => { values.push(`%${term}%`, `%${term}%`); return '(LOWER(p.title) LIKE ? OR LOWER(p.body) LIKE ?)' })
    statement = `${permitted} SELECT p.*, (${scores.join(' + ')}) AS search_rank FROM permitted p WHERE ${matches.join(' AND ')} ORDER BY search_rank DESC, p.id DESC LIMIT 51`
  }
  const rows = await query(statement, values)
  return { articles: rows.slice(0, 50).map(row => publicArticleView(project, row)), retrievalMode: mode, search: { ...metadata, hasMore: rows.length > 50 } }
}

/** Agent editor search retains drafts; public help uses native PostgreSQL full text or SQLite fallback. */
export async function searchArticles(project: Row, search: string, scope: KnowledgeScope = {}) {
  if (!scope.internal) return await publicArticleSearch(project, search, scope)
  const terms = searchTerms(search.slice(0, 500)), values: unknown[] = [project.id, project.workspace_id]
  let where = 'project_id = ? AND workspace_id = ?'
  if (scope.publishedOnly) where += " AND status = 'published'"
  if (scope.locale) { where += ' AND locale = ?'; values.push(localeOf(scope.locale)) }
  if (scope.collection) { where += ' AND collection = ?'; values.push(text(scope.collection, 'collection', 120)) }
  for (const term of terms) { where += ' AND (LOWER(title) LIKE ? OR LOWER(body) LIKE ?)'; values.push(`%${term}%`, `%${term}%`) }
  const rows = await query(`SELECT * FROM support_articles WHERE ${where} ORDER BY id DESC LIMIT 100`, values)
  const score = (row: Row) => terms.reduce((sum, term) => sum + (String(row.title).toLowerCase().includes(term) ? 4 : 0) + (String(row.body).toLowerCase().includes(term) ? 1 : 0), 0)
  rows.sort((a, b) => score(b) - score(a) || Number(b.id) - Number(a.id))
  return { articles: rows.slice(0, 50).map(articleView), retrievalMode: 'lexical' as const }
}
export async function publishedArticle(project: Row, slug: string, locale: string) {
  const filters = publicArticleFilters(project, { locale })
  const row = await one(`SELECT a.* FROM support_articles a WHERE ${filters.where} AND a.slug = ?`, [...filters.values, text(slug, 'slug', 200)])
  if (!row) fail(404, 'not_found', 'Article not found.')
  return publicArticleView(project, row)
}
export async function agentArticle(project: Row, id: unknown) {
  const row = await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])
  if (!row) fail(404, 'not_found', 'Article not found.')
  return articleView(row)
}
export async function articleRevisions(project: Row, id: unknown) {
  if (!await one('SELECT id FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])) fail(404, 'not_found', 'Article not found.')
  const rows = await query('SELECT revision, author_id, integration_key_id, snapshot, created_at FROM support_article_revisions WHERE article_id = ? AND project_id = ? AND workspace_id = ? ORDER BY revision DESC LIMIT 100', [identifier(id), project.id, project.workspace_id])
  return rows.map(row => ({ ...row, revision: Number(row.revision), snapshot: JSON.parse(String(row.snapshot)) }))
}

/** Removal archives authoritative content and synchronously deletes every searchable chunk. */
export async function removeArticle(project: Row, id: unknown, revision: unknown, author: KnowledgeAuthor) {
  await authorizeAuthor(project, author)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const article = await updateArticle(project, id, { revision, status: 'archived' }, author)
    await removeKnowledgeSource(project, Number(article.id))
    return { removed: true, article }
  })
}
