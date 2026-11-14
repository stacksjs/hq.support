import type { Row } from './database'
import { one } from './database'
import { fail, SupportError, text } from './errors'
import type { KnowledgeAuthor } from './knowledge'
import { createArticle, knowledgeText, localeOf, updateArticle } from './knowledge'
import { object } from './service'

export type ArticleImportOutcome = { id?: unknown, skipped?: boolean, message?: string }
export interface ArticleImportContext {
  fingerprint: (value: unknown) => string
  external: (value: unknown, label?: string) => string
  timestamp: (value: unknown, label: string) => string
  mapping: (project: Row, type: string, id: string) => Promise<Row | undefined>
  remember: (project: Row, type: string, id: string, target: unknown, payload: Row, hashInput?: Row) => Promise<void>
  author: () => Promise<KnowledgeAuthor>
  defaultLocale?: string
}
export async function importIntercomCollection(project: Row, source: Row, context: ArticleImportContext): Promise<ArticleImportOutcome> {
  await context.author()
  const id = context.external(source.id)
  if (source.type !== 'collection') fail(422, 'source_collection_type', 'Supply a collection response; section hierarchies require separate review.')
  text(source.name, 'collection.name', 120)
  const previous = await context.mapping(project, 'collection', id)
  if (previous?.source_hash === context.fingerprint(source)) return { id: 0, skipped: true, message: 'Collection metadata already retained. No collection tree was invented.' }
  await context.remember(project, 'collection', id, 0, source)
  return { id: 0, message: 'Collection metadata retained for article labels. Native nested collection trees are not migrated.' }
}
async function articleCollection(project: Row, source: Row, locale: string, context: ArticleImportContext) {
  if (source.parent_ids !== undefined && !Array.isArray(source.parent_ids)) fail(422, 'source_article_parent_invalid', 'Article parent_ids must be an explicit array.')
  const parents = (Array.isArray(source.parent_ids) ? source.parent_ids : []).map(id => context.external(id, 'parent id'))
  if (source.parent_id !== undefined && source.parent_id !== null) {
    const legacy = context.external(source.parent_id, 'parent id')
    if (parents.length && !parents.includes(legacy)) fail(422, 'source_article_parent_conflict', 'The article parent fields disagree. Review its collection placement.')
    if (!parents.includes(legacy)) parents.push(legacy)
  }
  const unique = [...new Set(parents)]
  if (unique.length > 1) fail(422, 'source_article_multiple_parents', 'This native article has one collection label. Multiple source parents require review.')
  if (!unique.length) return { label: 'Imported Intercom', source: null }
  if (source.parent_type != null && source.parent_type !== 'collection') fail(422, 'source_article_parent_type', 'Source section or unknown parent relationships require review.')
  const mapping = await context.mapping(project, 'collection', unique[0]!)
  if (!mapping) fail(422, 'source_article_collection_missing', 'Supply the referenced collection metadata before importing this article.')
  const collection = object(JSON.parse(String(mapping.source_payload)))
  if (source.workspace_id && collection.workspace_id && String(source.workspace_id) !== String(collection.workspace_id)) fail(422, 'source_article_collection_scope', 'The source article and collection belong to different Intercom workspaces.')
  const translation = object(object(collection.translated_content)[locale])
  return { label: text(translation.name ?? collection.name, 'collection.name', 120), source: collection }
}
function nativeSnapshot(article: Row) {
  return Object.fromEntries(['slug', 'title', 'body', 'status', 'visibility', 'locale', 'collection', 'revision'].map(key => [key, key === 'revision' ? Number(article[key]) : article[key]]))
}
function sourceContent(source: Row) {
  if (typeof source.body === 'string' && source.body.trim()) return { body: source.body, format: 'html' }
  if (typeof source.body_markdown === 'string' && source.body_markdown.trim()) return { body: source.body_markdown, format: 'markdown' }
  fail(422, 'source_article_body_missing', 'Article content is missing, redacted or metadata-only. Supply a full article retrieve response.')
}
async function contentVariant(source: Row, locale: string, context: ArticleImportContext) {
  if (source.partial === true || source.truncated === true || source.redacted === true) fail(422, 'source_article_incomplete', 'The source explicitly marks this article content as partial, truncated or redacted. Supply complete content before migration.')
  const selected = sourceContent(source)
  if (selected.body.length > 100000) fail(422, 'source_article_body_too_large', 'The article exceeds the native 100000-character body bound and requires review.')
  if ((Array.isArray(source.attachments) && source.attachments.length) || /<(?:img|video|audio|iframe|object|embed)\b/i.test(selected.body) || (selected.format === 'markdown' && /!\[[^\]]*\]/.test(selected.body))) fail(422, 'source_article_media_pending', 'Article media needs a qualified transfer; this text-only migration retains the full source for review.')
  if (!['published', 'draft'].includes(String(source.state))) fail(422, 'source_article_state', 'An explicit published or draft source state is required.')
  const authorId = context.external(source.author_id, 'article author id')
  for (const key of ['created_at', 'updated_at']) if (!['string', 'number'].includes(typeof source[key]) || !String(source[key]).trim()) fail(422, 'source_article_timestamp_missing', `An explicit source ${key} timestamp is required.`)
  const createdAt = context.timestamp(source.created_at, 'article.created_at'), updatedAt = context.timestamp(source.updated_at, 'article.updated_at')
  if (updatedAt < createdAt) fail(422, 'source_article_timestamp_order', 'Article source timestamps are inconsistent.')
  const title = text(source.title, 'article.title', 200)
  // Verify meaningful native text before writing any variant. Native create/update perform the same
  // sanitizer on the original input; decoded text is never reparsed as if it were authored markup.
  try { await knowledgeText(selected.body, selected.format) }
  catch (error) { if (error instanceof SupportError && error.code === 'invalid_input') fail(422, 'source_article_text_empty', 'The supplied article contains no usable native text after sanitization.'); throw error }
  return { title, ...selected, locale, authorId, createdAt, updatedAt }
}
/** Caller supplies a transaction, so every locale of one source article is an atomic checkpoint. */
export async function importIntercomArticle(project: Row, source: Row, context: ArticleImportContext): Promise<ArticleImportOutcome> {
  const id = context.external(source.id)
  if (source.type !== 'article') fail(422, 'source_article_type', 'Only full article responses are supported; unknown content types require review.')
  if (source.has_unpublished_changes === true) fail(422, 'source_article_staged_draft', 'This source has a separate staged draft. Reconcile its live and staged content before migration.')
  const localeValue = source.default_locale ?? context.defaultLocale
  if (!localeValue) fail(422, 'source_article_locale_missing', 'Supply default_locale for multilingual articles or bundle articleLocale for a single-language help center.')
  if (source.translated_content != null && (typeof source.translated_content !== 'object' || Array.isArray(source.translated_content))) fail(422, 'source_article_translation_type', 'Translated content must contain explicit locale objects.')
  const locale = localeOf(localeValue), translations = object(source.translated_content)
  const keys = Object.keys(translations).filter(key => key !== 'type')
  if (keys.length > 64) fail(422, 'source_article_locale_limit', 'More than 64 supplied article locales require a separate reviewed batch.')
  if (translations.type !== undefined && translations.type !== 'article_translated_content') fail(422, 'source_article_translation_type', 'Unknown translated article container requires review.')
  const variants = [{ locale, source, content: await contentVariant(source, locale, context) }]
  for (const key of keys) {
    const translatedLocale = localeOf(key), translated = object(translations[key])
    const content = await contentVariant(translated, translatedLocale, context)
    if (translatedLocale === locale) {
      if (context.fingerprint(content) !== context.fingerprint(variants[0]!.content)) fail(422, 'source_article_default_locale_conflict', 'Default article fields and their translated-content entry disagree.')
      continue
    }
    variants.push({ locale: translatedLocale, source: translated, content })
  }
  const author = await context.author()
  let defaultTarget: unknown, changed = false
  for (const variant of variants) {
    const placement = await articleCollection(project, source, variant.locale, context), externalId = `${id}:${variant.locale}`
    const hashInput = { source, locale: variant.locale, collection: placement.source }
    const previous = await context.mapping(project, 'article', externalId)
    const current = previous ? await one('SELECT * FROM support_articles WHERE id = ? AND project_id = ? AND workspace_id = ?', [previous.target_id, project.id, project.workspace_id]) : undefined
    if (previous && !current) fail(409, 'import_target_missing', 'A mapped article was removed. Review erasure or retention before recreating it.')
    if (previous?.source_hash === context.fingerprint(hashInput)) { defaultTarget ??= current!.id; continue }
    if (previous && current) {
      const saved = object(JSON.parse(String(previous.source_payload))), native = object(saved.native), provenance = object(saved.provenance)
      if (Number(native.revision) !== Number(current.revision) || native.contentHash !== context.fingerprint(nativeSnapshot(current))) fail(409, 'import_article_native_changed', 'The mapped article has native edits. They were preserved for operator review.')
      if (typeof provenance.updatedAt === 'string' && variant.content.updatedAt < provenance.updatedAt) fail(409, 'source_article_version_older', 'An older source article cannot replace a newer imported revision.')
    }
    const data = { slug: `intercom-${context.fingerprint(id).slice(0, 24)}`, title: variant.content.title, body: variant.content.body, format: variant.content.format, locale: variant.locale, collection: placement.label, visibility: 'internal', status: 'draft' }
    const imported = current ? await updateArticle(project, current.id, { ...data, revision: Number(current.revision) }, author) : await createArticle(project, data, author)
    await context.remember(project, 'article', externalId, imported.id, { source: variant.locale === locale ? source : variant.source, sourceArticle: { id, workspaceId: source.workspace_id ?? null, defaultLocale: locale, originalHash: context.fingerprint(source) }, selectedLocale: variant.locale, collection: placement.source, provenance: { provider: 'intercom', articleId: id, authorId: variant.content.authorId, createdAt: variant.content.createdAt, updatedAt: variant.content.updatedAt, localeSource: source.default_locale ? 'article.default_locale' : 'bundle.articleLocale', originalAudience: source.help_center_audience ?? null, publicationRestored: false }, native: { revision: imported.revision, contentHash: context.fingerprint(nativeSnapshot(imported)) } }, hashInput)
    defaultTarget ??= imported.id; changed = true
  }
  return { id: defaultTarget, skipped: !changed, message: `${variants.length} source locale(s) reconciled as private drafts. Source authorship and timestamps remain provenance, not native actor identity.` }
}
