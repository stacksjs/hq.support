import { derived, state } from '@stacksjs/stx'
import { createSupportConsole } from './console'

interface Article { id: string, slug: string, title: string, body: string, status: string, visibility: string, locale: string, collection: string, revision: number, updated_at: string }
interface Revision { revision: number, created_at: string, snapshot: { title: string, status: string } }
export function createKnowledge() {
  const workspace = createSupportConsole()
  const articles = state<Article[]>([])
  const selected = state<Article | null>(null)
  const revisions = state<Revision[]>([])
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
  async function boot() { await workspace.boot(); await load() }
  async function select(article: Article | null) {
    selected.set(article)
    title.set(article?.title || '')
    slug.set(article?.slug || '')
    body.set(article?.body || '')
    status.set(article?.status || 'draft')
    visibility.set(article?.visibility || 'public')
    locale.set(article?.locale || 'en')
    collection.set(article?.collection || 'General')
    importMode.set('text')
    revisions.set([])
    editorOpen.set(true)
    baseline.set(snapshot())
    workspace.notice.set('')
    if (article) {
      try {
        const data = await workspace.request(workspace.projectPath(`/knowledge/${encodeURIComponent(article.id)}/revisions`))
        if (selected()?.id === article.id) revisions.set(data.revisions || [])
      }
      catch (failure) { workspace.error.set(failure instanceof Error ? failure.message : 'Revisions could not be loaded.') }
    }
  }
  async function changeProject() { editorOpen.set(false); selected.set(null); revisions.set([]); articles.set([]); baseline.set(''); await load() }
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
    workspace.notice.set('Article saved. Revision history is up to date.')
  }
  return { workspace, articles, selected, revisions, query, title, slug, body, status, visibility, locale, collection, editorOpen, importMode, dirty, publicLink, load, boot, select, discard, changeProject, save }
}
