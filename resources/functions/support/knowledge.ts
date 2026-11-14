import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

interface Article { id: string, slug: string, title: string, body: string, status: string, visibility: string, locale: string, collection: string, revision: number, updated_at: string }
interface Capabilities { provider: { configured: boolean, provider?: string }, retrieval: { mode: string, persistent: boolean, vectorReady: boolean, totalSources: number, vectorSources: number, pendingVectorSources: number }, copilot: { period: string, used: { requests: number, tokens: number }, limits: { requests: number | null, tokens: number | null }, remaining: { requests: number | null, tokens: number | null }, maxRequestTokens: number }, indexing: { used: number, limit: number | null, remaining: number | null }, customerAi: { period: string, used: number, limit: number | null, remaining: number | null, maxTurns: number, maxTokens: number } }
interface IndexStatus { source: { revision: number, permissionGranted: boolean, deleted: boolean, indexing: boolean, lastError: string } | null, index: { status: string, revision: number, chunk_count: number, dimensions: number, embedding_model: string } | null }
interface Revision { revision: number, created_at: string, snapshot: { title: string, status: string } }
export function createKnowledge() {
  const workspace = createSupportConsole()
  const articles = state<Article[]>([])
  const selected = state<Article | null>(null)
  const revisions = state<Revision[]>([])
  const capabilities = state<Capabilities | null>(null), capabilityError = state(''), capabilityLoading = state(false)
  const indexStatus = state<IndexStatus | null>(null), indexError = state('')
  let capabilityVersion = 0, selectionVersion = 0, disposed = false
  const query = state('')
  const title = state('')
  const slug = state('')
  const body = state('')
  const status = state('draft')
  const visibility = state('public')
  const locale = state('en')
  const collection = state('General')
  const editorOpen = state(false)
  const baseline = state('')
  const importMode = state('text')
  const snapshot = () => JSON.stringify({ title: title(), slug: slug(), body: body(), status: status(), visibility: visibility(), locale: locale(), collection: collection(), format: importMode() })
  const dirty = derived(() => editorOpen() && snapshot() !== baseline())
  const publicLink = derived(() => selected()?.status === 'published' && selected()?.visibility === 'public' ? `/help/article?project=${encodeURIComponent(workspace.project())}&slug=${encodeURIComponent(selected()!.slug)}&locale=${encodeURIComponent(selected()!.locale)}` : '')
  async function load() {
    if (!workspace.project() || dirty()) return
    const result = await workspace.run(() => workspace.request(workspace.projectPath(`/knowledge?q=${encodeURIComponent(query())}`)))
    if (result) articles.set(result.articles || [])
  }
  async function refreshCapabilities() {
    const project = workspace.project(), current = ++capabilityVersion
    if (!project) return
    capabilityLoading.set(true); capabilityError.set('')
    try { const result = await workspace.request(workspace.projectPath('/ai/capabilities')); if (!disposed && current === capabilityVersion && project === workspace.project()) capabilities.set(result) }
    catch (failure) { if (!disposed && current === capabilityVersion) { capabilities.set(null); capabilityError.set(failure instanceof Error ? failure.message : 'AI capabilities could not be loaded.') } }
    finally { if (!disposed && current === capabilityVersion) capabilityLoading.set(false) }
  }
  async function boot(link: { project?: string, article?: string } = {}) {
    await workspace.boot()
    if (!workspace.ready()) return
    if (link.project) {
      if (!workspace.projects().some(item => item.public_id === link.project)) { workspace.project.set(''); workspace.error.set('The linked project is unavailable to your account. Choose an accessible project.'); return }
      workspace.project.set(link.project)
    }
    await Promise.allSettled([load(), refreshCapabilities()])
    if (link.article && workspace.project()) {
      const linkedProject = workspace.project(), current = selectionVersion
      try {
        const result = await workspace.request(workspace.projectPath(`/knowledge/${encodeURIComponent(link.article)}`))
        if (!disposed && linkedProject === workspace.project() && current === selectionVersion && result.article) { articles.update(items => [result.article, ...items.filter(item => String(item.id) !== String(result.article.id))]); await select(result.article) }
      }
      catch (failure) { if (!disposed && linkedProject === workspace.project() && current === selectionVersion) workspace.error.set(failure instanceof Error ? failure.message : 'The linked article is unavailable.') }
    }
  }
  async function select(article: Article | null) {
    const current = ++selectionVersion, project = workspace.project()
    selected.set(article)
    title.set(article?.title || '')
    slug.set(article?.slug || '')
    body.set(article?.body || '')
    status.set(article?.status || 'draft')
    visibility.set(article?.visibility || 'public')
    locale.set(article?.locale || 'en')
    collection.set(article?.collection || 'General')
    importMode.set('text')
    revisions.set([]); indexStatus.set(null); indexError.set('')
    editorOpen.set(true)
    baseline.set(snapshot())
    workspace.notice.set('')
    if (article) {
      try {
        const results = await Promise.allSettled([workspace.request(workspace.projectPath(`/knowledge/${encodeURIComponent(article.id)}/revisions`)), workspace.request(workspace.projectPath(`/knowledge/${encodeURIComponent(article.id)}/index`))])
        if (disposed || current !== selectionVersion || project !== workspace.project()) return
        if (results[0].status === 'fulfilled') revisions.set(results[0].value.revisions || [])
        else workspace.error.set(results[0].reason instanceof Error ? results[0].reason.message : 'Revisions could not be loaded.')
        if (results[1].status === 'fulfilled') indexStatus.set(results[1].value)
        else indexError.set(results[1].reason instanceof Error ? results[1].reason.message : 'Index status could not be loaded.')
      }
      catch (failure) { workspace.error.set(failure instanceof Error ? failure.message : 'Revisions could not be loaded.') }
    }
  }
  async function changeProject() { selectionVersion++; capabilityVersion++; editorOpen.set(false); selected.set(null); revisions.set([]); indexStatus.set(null); indexError.set(''); capabilities.set(null); articles.set([]); baseline.set(''); await Promise.allSettled([load(), refreshCapabilities()]) }
  async function discard() { if (selected()) await select(selected()); else { editorOpen.set(false); baseline.set('') } }
  async function save() {
    if (workspace.pending() || !workspace.canManage()) return
    const original = selected()
    const values = JSON.parse(snapshot())
    const path = original ? `/knowledge/${encodeURIComponent(original.id)}` : importMode() !== 'text' ? '/knowledge/import' : '/knowledge'
    const result = await workspace.run(() => workspace.request(workspace.projectPath(path), { method: original ? 'PATCH' : 'POST', body: JSON.stringify({ ...values, ...(original ? { revision: original.revision } : {}) }) }), workspace.pending)
    if (!result?.article) return
    articles.update(items => [result.article, ...items.filter(row => row.id !== result.article.id)])
    await select(result.article)
    workspace.notice.set('Article saved. Revision history is up to date.'); await refreshCapabilities()
  }
  function count(value: number | null | undefined) { return value === null ? 'Unlimited' : value === undefined ? 'Unavailable' : value.toLocaleString() }
  function retrievalLabel() { return capabilities()?.retrieval.mode === 'pgvector' ? 'Postgres vector retrieval' : capabilities()?.retrieval.mode === 'fulltext' ? 'Postgres full-text retrieval' : capabilities()?.retrieval.mode === 'lexical' ? 'Lexical retrieval' : 'Unavailable' }
  function destroy() { disposed = true; capabilityVersion++; selectionVersion++; workspace.destroy() }
  return { capabilities, capabilityError, capabilityLoading, refreshCapabilities, indexStatus, indexError, count, retrievalLabel, destroy, workspace, articles, selected, revisions, query, title, slug, body, status, visibility, locale, collection, editorOpen, importMode, dirty, publicLink, load, boot, select, discard, changeProject, save }
}
