import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { member } from './service'

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
async function recordRevision(project: Row, article: Row, authorId: number) {
  await insert('support_article_revisions', { workspace_id: project.workspace_id, project_id: project.id, article_id: article.id, revision: article.revision, author_id: authorId, snapshot: JSON.stringify(Object.fromEntries(snapshotFields.map(key => [key, key === 'revision' ? Number(article[key]) : article[key]]))) })
}
export async function createArticle(project: Row, data: Row, authorId: number) {
  await member(authorId, Number(project.workspace_id), ['owner', 'admin'])
  const fields = attributes(data), body = await knowledgeText(data.body, data.format)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    if (await one('SELECT id FROM support_articles WHERE project_id = ? AND locale = ? AND slug = ?', [project.id, fields.locale, fields.slug])) fail(409, 'slug_conflict', 'This article slug already exists for this locale.')
    const row = await insert('support_articles', { workspace_id: project.workspace_id, project_id: project.id, ...fields, body, revision: 1 })
    await recordRevision(project, row, authorId)
    return articleView(row)
  })
}
export async function updateArticle(project: Row, id: unknown, data: Row, authorId: number) {
  await member(authorId, Number(project.workspace_id), ['owner', 'admin'])
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
    return articleView(updated)
  })
}
const queryStopWords = new Set('a an the i me my we our you your it is are was be been do does did how what when where can could would should to of for in on at and or please help'.split(' '))
export function searchTerms(value: string) { return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(term => !queryStopWords.has(term)).slice(0, 12) }

/** Deterministic lexical AND retrieval over durable SQL rows; no in-memory vector index. */
export async function searchArticles(project: Row, search: string, scope: KnowledgeScope = {}) {
  const terms = searchTerms(search.slice(0, 500)), values: unknown[] = [project.id, project.workspace_id]
  let where = 'project_id = ? AND workspace_id = ?'
  if (!scope.internal) where += " AND status = 'published' AND visibility = 'public'"
  if (scope.internal && scope.publishedOnly) where += " AND status = 'published'"
  if (scope.locale) { where += ' AND locale = ?'; values.push(localeOf(scope.locale)) }
  if (scope.collection) { where += ' AND collection = ?'; values.push(text(scope.collection, 'collection', 120)) }
  for (const term of terms) { where += ' AND (LOWER(title) LIKE ? OR LOWER(body) LIKE ?)'; values.push(`%${term}%`, `%${term}%`) }
  const rows = await query(`SELECT * FROM support_articles WHERE ${where} ORDER BY id DESC LIMIT 100`, values)
  const score = (row: Row) => terms.reduce((sum, term) => sum + (String(row.title).toLowerCase().includes(term) ? 4 : 0) + (String(row.body).toLowerCase().includes(term) ? 1 : 0), 0)
  rows.sort((a, b) => score(b) - score(a) || Number(b.id) - Number(a.id))
  return { articles: rows.slice(0, 50).map(articleView), retrievalMode: 'lexical' as const }
}
export async function publishedArticle(project: Row, slug: string, locale: string) {
  const row = await one("SELECT * FROM support_articles WHERE project_id = ? AND workspace_id = ? AND slug = ? AND locale = ? AND status = 'published' AND visibility = 'public'", [project.id, project.workspace_id, text(slug, 'slug', 200), localeOf(locale)])
  if (!row) fail(404, 'not_found', 'Article not found.')
  return articleView(row)
}
export async function articleRevisions(project: Row, id: unknown) {
  if (!await one('SELECT id FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])) fail(404, 'not_found', 'Article not found.')
  const rows = await query('SELECT revision, author_id, snapshot, created_at FROM support_article_revisions WHERE article_id = ? AND project_id = ? AND workspace_id = ? ORDER BY revision DESC LIMIT 100', [identifier(id), project.id, project.workspace_id])
  return rows.map(row => ({ ...row, revision: Number(row.revision), snapshot: JSON.parse(String(row.snapshot)) }))
}
