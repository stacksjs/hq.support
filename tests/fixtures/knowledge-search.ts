import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { insert, one, query } from '../../app/Support/database'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
config.app.url = 'https://help.example.test'
let providerCalls = 0, checks = 0, csrfCookie = '', csrfToken = ''
const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { providerCalls++; return Response.json({ error: 'Anonymous search must not call this provider' }, { status: 503 }) } })
config.ai.default = 'openai'
config.ai.drivers = { openai: { apiKey: 'private-search-test-key', baseUrl: `http://127.0.0.1:${provider.port}/v1` } }
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
const postgres = resolvedDatabaseConfig().driver === 'postgres'
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function request(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(csrfCookie ? { cookie: csrfCookie, 'x-csrf-token': csrfToken } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, data: await response.json() as any }
}
try {
  const csrf = await fetch(base + '/csrf-token'); csrfToken = (await csrf.json() as any).token; csrfCookie = csrf.headers.get('set-cookie')!.split(';')[0]!
  async function account(email: string) {
    const registered = await request('/register', 'POST', { name: 'Search owner', email, password: 'KnowledgeSearch2026!', password_confirmation: 'KnowledgeSearch2026!' })
    check(registered.status < 300, 'native account registers')
    const login = await request('/login', 'POST', { email, password: 'KnowledgeSearch2026!' })
    return login.data.token ?? login.data.access_token ?? login.data.data?.token
  }
  const token = await account('search@example.test'), outsider = await account('other-search@example.test')
  const workspace = (await request('/support/workspaces', 'POST', { name: 'Public search workspace' }, token)).data.workspace
  // Owned fixture state only: permit a second same-workspace project for the scope boundary check.
  await query("UPDATE support_workspaces SET plan = 'selfhost' WHERE id = ?", [workspace.id])
  const project = (await request(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Search app' }, token)).data.project
  const sibling = (await request(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Sibling app' }, token)).data.project
  const otherWorkspace = (await request('/support/workspaces', 'POST', { name: 'Other search workspace' }, outsider)).data.workspace
  const otherProject = (await request(`/support/workspaces/${otherWorkspace.id}/projects`, 'POST', { name: 'Other app' }, outsider)).data.project
  const agent = `/support/projects/${project.public_id}`, help = `/help/projects/${project.public_id}/articles`
  async function create(slug: string, title: string, body: string, extras: Record<string, unknown> = {}, reference = project.public_id, credential = token) {
    const result = await request(`/support/projects/${reference}/knowledge`, 'POST', { slug, title, body, status: 'published', ...extras }, credential)
    check(result.status === 201, `article ${slug} persists: ${JSON.stringify(result.data)}`)
    return result.data.article
  }
  const strong = await create('password-guide', 'Password reference', 'Password password password password guidance.')
  const internal = await create('private-needle', 'Needle confidential', 'PRIVATE_NEEDLE agent-only details.', { visibility: 'internal' })
  await create('draft-needle', 'Needle draft', 'DRAFT_NEEDLE unpublished details.', { status: 'draft' })
  await create('sibling-needle', 'Needle sibling', 'SIBLING_NEEDLE another project.', {}, sibling.public_id)
  await create('foreign-needle', 'Needle foreign', 'FOREIGN_NEEDLE another workspace.', {}, otherProject.public_id, outsider)
  const denied = await create('denied-needle', 'Needle revoked', 'DENIED_NEEDLE revoked source grant.')
  const deleted = await create('deleted-needle', 'Needle deleted', 'DELETED_NEEDLE removed source.')
  const audience = await create('audience-needle', 'Needle audience', 'AUDIENCE_NEEDLE inconsistent audience.')
  const publication = await create('publication-needle', 'Needle publication', 'PUBLICATION_NEEDLE withdrawn source.')
  const language = await create('language-needle', 'Needle language', 'LANGUAGE_NEEDLE inconsistent locale.')
  const revision = await create('revision-needle', 'Needle revision', 'REVISION_NEEDLE stale source revision.')
  const binding = await create('binding-needle', 'Needle binding', 'BINDING_NEEDLE source bound to another workspace.')
  await query('UPDATE support_knowledge_sources SET permission_granted = ? WHERE article_id = ?', [false, Number(denied.id)])
  await query('UPDATE support_knowledge_sources SET deleted_at = ? WHERE article_id = ?', [Date.now(), Number(deleted.id)])
  await query("UPDATE support_knowledge_sources SET audience = 'internal' WHERE article_id = ?", [Number(audience.id)])
  await query("UPDATE support_knowledge_sources SET publication = 'draft' WHERE article_id = ?", [Number(publication.id)])
  await query("UPDATE support_knowledge_sources SET language = 'fr' WHERE article_id = ?", [Number(language.id)])
  await query('UPDATE support_knowledge_sources SET current_revision = current_revision + 1 WHERE article_id = ?', [Number(revision.id)])
  await query('UPDATE support_knowledge_sources SET workspace_id = ? WHERE article_id = ?', [otherWorkspace.id, Number(binding.id)])
  const visible = await create('visible-needle', 'Needle public', 'PUBLIC_NEEDLE the current permitted article.')
  const french = await create('aide-francaise', 'Needle française', 'FRENCH_NEEDLE aide publique.', { locale: 'fr', collection: 'Français' })
  // Simulates a public article from before source/index backfill existed. No source row is invented.
  const legacy = await insert('support_articles', { workspace_id: workspace.id, project_id: project.id, slug: 'legacy-guide', title: 'Needle legacy', body: 'LEGACY_NEEDLE published before indexing.', status: 'published', visibility: 'public', locale: 'en', collection: 'Legacy', revision: 1 })
  check(!await one('SELECT id FROM support_knowledge_sources WHERE article_id = ?', [legacy.id]), 'legacy fixture genuinely has no index source')
  const pending = await create('pending-guide', 'Needle pending', 'PENDING_NEEDLE current article awaiting an index generation.')
  await query('UPDATE support_knowledge_sources SET active_index_id = 0 WHERE article_id = ?', [Number(pending.id)])
  const budgetsBefore = await query('SELECT workspace_id, period, meter, used FROM support_usage ORDER BY workspace_id, period, meter')
  const searched = await request(help + '?q=needle&locale=en')
  check(searched.status === 200 && searched.data.retrievalMode === (postgres ? 'fulltext' : 'lexical'), 'anonymous search reports the actual native fulltext or SQLite fallback mode')
  check(searched.data.search.providerRequests === false && searched.data.search.indexedGenerationRequired === false && searched.data.search.legacyArticlesIncluded === true, 'search explicitly declares its provider-free authoritative-article and legacy/backfill policy')
  assert.deepEqual(new Set(searched.data.articles.map((article: any) => article.id)), new Set([visible.id, String(legacy.id), pending.id]))
  checks++
  for (const article of [internal, denied, deleted, audience, publication, language, revision, binding]) check((await request(help + '/' + article.slug)).status === 404, `public delivery applies the same grant and publication checks for ${article.slug}`)
  check((await request(help + '/sibling-needle')).status === 404, 'a public project cannot resolve another project slug')
  check((await request(help + '?q=needle&locale=fr&collection=' + encodeURIComponent('Français'))).data.articles[0].id === french.id, 'locale and collection filters are applied before ranking')
  const legacyDetail = await request(help + '/legacy-guide')
  check(legacyDetail.status === 200 && legacyDetail.data.article.id === String(legacy.id), 'legacy public article remains deliverable without a generation')
  const canonical = new URL(legacyDetail.data.article.url)
  check(canonical.origin === 'https://help.example.test' && canonical.pathname === '/help/article' && canonical.searchParams.get('project') === project.public_id && canonical.searchParams.get('slug') === 'legacy-guide' && canonical.searchParams.get('locale') === 'en', 'public URLs bind canonical application origin, exact project, slug and locale')
  const accented = await request(help + '/aide-francaise?locale=fr')
  check(accented.status === 200 && new URL(accented.data.article.url).searchParams.get('locale') === 'fr', 'localized public article URLs retain their locale')
  check((await request(help + '?q=' + 'a'.repeat(501))).status === 422 && (await request(help + '?q=needle&locale=en_US')).status === 422, 'invalid public query length and locale fail explicitly')
  check((await request(help + '?q=' + encodeURIComponent('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu'))).status === 422, 'search rejects excessive query terms instead of silently dropping them')
  check((await request(help + '?q=' + encodeURIComponent('%_'))).data.articles.length === 0, 'query punctuation cannot turn into a wildcard listing')
  await create('passwordless', 'Passwordless access', 'Authenticate with a passkey.')
  for (let index = 0; index < 105; index++) await create(`guide-${index}`, `Guide ${index}`, 'One password instruction.')
  const ranked = await request(help + '?q=password')
  check(ranked.data.articles[0].id === strong.id, 'older high-ranked article is found beyond the former first-hundred-row cutoff')
  check(ranked.data.articles.length === 50 && ranked.data.search.hasMore && ranked.data.search.resultLimit === 50, 'bounded result windows disclose that more public matches exist')
  const tokenMatch = await request(help + '?q=passwordless')
  check(tokenMatch.data.articles.some((article: any) => article.slug === 'passwordless'), 'native fulltext and SQLite fallback both match an exact term')
  const partial = await request(help + '?q=passwor')
  check(postgres ? partial.data.articles.length === 0 : partial.data.articles.length > 0, 'PostgreSQL matches lexemes while SQLite explicitly uses substring fallback')
  const exact = await request(`${agent}/knowledge/${internal.id}`, 'GET', undefined, token)
  check(exact.status === 200 && exact.data.article.body.includes('PRIVATE_NEEDLE'), 'native-auth exact article read supports old internal citations beyond the search window')
  check((await request(`${agent}/knowledge/${internal.id}`)).status === 401, 'exact internal article delivery requires native authentication')
  check((await request(`${agent}/knowledge/${internal.id}`, 'GET', undefined, outsider)).status === 403, 'exact article read rejects another workspace member')
  check((await request(`/support/projects/${sibling.public_id}/knowledge/${internal.id}`, 'GET', undefined, token)).status === 404, 'exact article read binds the selected project even for a workspace owner')
  check((await request(`${agent}/knowledge/0`, 'GET', undefined, token)).status === 422, 'exact article read validates numeric identifiers')
  const budgetsAfter = await query('SELECT workspace_id, period, meter, used FROM support_usage ORDER BY workspace_id, period, meter')
  assert.deepEqual(budgetsAfter, budgetsBefore); checks++
  check(providerCalls === 0, 'anonymous help listing/search/detail never call chat or embedding providers')
  console.log(`PASS public knowledge search ${checks} checks`)
}
finally { await server.stop(true); await provider.stop(true) }
