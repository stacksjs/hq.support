import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { Storage } from '@stacksjs/storage'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { one, query } from '../../app/Support/database'
import Job from '../../app/Jobs/RunSupportImport'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
let providerCalls = 0, checks = 0
const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { providerCalls++; return Response.json({ error: 'Article migration must never call a provider' }, { status: 503 }) } })
config.ai.default = 'openai'
config.ai.drivers = { openai: { apiKey: 'private-import-test-key', baseUrl: `http://127.0.0.1:${provider.port}/v1` } }
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let csrf = '', cookie = ''
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, token?: string) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, data: await response.json() as any, headers: response.headers }
}
const content = (title = 'Imported guide', body = '<p>Private knowledge text.</p>') => ({ type: 'article_content', title, body, author_id: 7001, state: 'published', created_at: 1500000000, updated_at: 1500000100 })
const article = (id: string, extra: Record<string, unknown> = {}): Record<string, any> => ({ ...content(), type: 'article', id, workspace_id: 'source-workspace', default_locale: 'en', parent_ids: [18], help_center_audience: 'restricted', ...extra })
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  await http('/register', 'POST', { name: 'Actual import operator', email: 'article-import@example.test', password: 'ArticleImport2026!', password_confirmation: 'ArticleImport2026!' })
  const token = (await http('/login', 'POST', { email: 'article-import@example.test', password: 'ArticleImport2026!' })).data.access_token
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Article imports' }, token)).data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Imported knowledge' }, token)).data.project
  const prefix = `/support/projects/${project.public_id}`, integration = `/v1/projects/${project.public_id}`
  const keys = (await http(prefix + '/keys', 'POST', {}, token)).data
  const outboxBeforeImport = JSON.stringify(await query('SELECT * FROM support_outbox ORDER BY id'))
  const keyRow = (await one("SELECT id FROM support_api_keys WHERE project_id = ? AND scope = 'write' AND revoked_at = 0", [project.id]))!
  const owner = (await one('SELECT id FROM users WHERE email = ?', ['article-import@example.test']))!
  async function upload(bundle: unknown, options: { integration?: boolean, dryRun?: boolean, credential?: string } = {}) {
    const form = new FormData(); form.set('file', new File([JSON.stringify(bundle)], 'intercom-articles.json', { type: 'application/json' }))
    if (options.dryRun !== undefined) form.set('dryRun', String(options.dryRun))
    const response = await fetch(base + (options.integration ? integration : prefix) + '/imports/intercom', { method: 'POST', headers: { accept: 'application/json', authorization: `Bearer ${options.credential ?? (options.integration ? keys.ingestKey : token)}` }, body: form })
    return { status: response.status, data: await response.json() as any }
  }
  async function run(id: unknown, fresh = false) {
    if (!fresh) { await Job.dispatchNow({ runId: Number(id) }); return }
    const result = await runIsolated('tests/fixtures/imports-resume.ts', { args: [String(id), 'worker'], env: { QUEUE_DRIVER: 'database' }, envFile: false, preload: [], timeoutMs: 50000 })
    assertIsolatedOk(result, 'PASS native import resume')
  }
  const english = content('Imported English', '<h1>Native imported text</h1><p>Safe body.</p><script>PRIVATE_SCRIPT()</script>')
  const original = article('article-one', { ...english, type: 'article', translated_content: { type: 'article_translated_content', en: english, fr: content('Guide français', '<p>Texte français privé.</p>') } })
  const source = { version: 1, provider: 'intercom', format: 'plaintext', contacts: [], conversations: [], collections: [{ type: 'collection', id: '18', workspace_id: 'source-workspace', name: 'Getting started', translated_content: { fr: { name: 'Premiers pas' } } }], articles: [original] }
  const before = { jobs: Number((await one('SELECT COUNT(*) AS n FROM jobs'))?.n), users: Number((await one('SELECT COUNT(*) AS n FROM users'))?.n) }
  const preview = await upload(source, { integration: true, dryRun: true })
  check(preview.status === 200 && preview.data.totalRecords === 2 && preview.data.compatibleRecords === 2 && preview.data.reviewRecords === 0, `dry-run rehearses native article and collection mapping ${JSON.stringify(preview.data)}`)
  check(Number((await one('SELECT COUNT(*) AS n FROM support_articles'))?.n) === 0 && Number((await one('SELECT COUNT(*) AS n FROM support_article_revisions'))?.n) === 0 && Number((await one('SELECT COUNT(*) AS n FROM support_import_mappings'))?.n) === 0 && Number((await one('SELECT COUNT(*) AS n FROM support_import_runs'))?.n) === 0, 'dry-run rolls back native content, revisions, source mappings and run records')
  check(Number((await one('SELECT COUNT(*) AS n FROM jobs'))?.n) === before.jobs && !await Storage.disk('local').directoryExists('support-imports'), 'article rehearsal creates neither private archive nor queue intent')
  const accepted = await upload(source, { integration: true })
  check(accepted.status === 202 && accepted.data.run.totalRecords === 2, 'integration accepts a private article bundle asynchronously')
  const id = accepted.data.run.id
  await Job.dispatchNow({ runId: Number(id), batchSize: 1 })
  check(Number((await one('SELECT cursor FROM support_import_runs WHERE id = ?', [Number(id)]))?.cursor) === 1 && Number((await one('SELECT COUNT(*) AS n FROM support_articles'))?.n) === 0, 'collection metadata has its own stable checkpoint before article writes')
  await http(`${prefix}/imports/${id}/pause`, 'POST', {}, token)
  await Job.dispatchNow({ runId: Number(id), batchSize: 1 })
  check(Number((await one('SELECT cursor FROM support_import_runs WHERE id = ?', [Number(id)]))?.cursor) === 1, 'paused article migration retains its saved cursor')
  await http(`${prefix}/imports/${id}/resume`, 'POST', {}, token)
  await run(id, true)
  const status = await http(`${prefix}/imports/${id}`, 'GET', undefined, token)
  check(status.data.run.status === 'completed' && status.data.run.imported === 2 && status.data.records[0].message.includes('metadata') && status.data.records[1].message.includes('private drafts'), 'native worker restart reconciles collection metadata and complete article locales')
  const imported = await query('SELECT * FROM support_articles WHERE project_id = ? ORDER BY locale', [project.id])
  check(imported.length === 2 && imported.every(row => row.visibility === 'internal' && row.status === 'draft'), 'source publication and audience never auto-publish or widen imported knowledge')
  check(imported[0]!.collection === 'Getting started' && imported[1]!.collection === 'Premiers pas' && !String(imported[0]!.body).includes('PRIVATE_SCRIPT') && !String(imported[0]!.body).includes('<'), 'native sanitizer and explicit localized collection names are used')
  const revisions = await query('SELECT * FROM support_article_revisions WHERE project_id = ?', [project.id])
  check(revisions.every(row => Number(row.author_id) === 0 && Number(row.integration_key_id) === Number(keyRow.id)), 'native revisions truthfully record the initiating integration rather than source author or workspace owner')
  const mapped = (await one("SELECT * FROM support_import_mappings WHERE project_id = ? AND entity_type = 'article' AND external_id = 'article-one:en'", [project.id]))!
  const payload = JSON.parse(String(mapped.source_payload))
  check(payload.provenance.authorId === '7001' && payload.provenance.createdAt === '2017-07-14T02:40:00.000Z' && payload.source.help_center_audience === 'restricted' && payload.source.author_id === 7001 && payload.native.revision === 1, 'external authorship, UTC source times, original audience and native baseline remain private provenance')
  check(new Date(String(imported[0]!.created_at)).getTime() > 1500000100 * 1000 && before.users === Number((await one('SELECT COUNT(*) AS n FROM users'))?.n), 'source times do not falsify native write audit times or create source author accounts')
  check((await http(`/help/projects/${project.public_id}/articles?q=imported`)).data.articles.length === 0, 'imported drafts are absent from anonymous help delivery')
  const repeated = await upload({ ...source, exportNote: 'repacked archive' }); await run(repeated.data.run.id)
  check((await http(`${prefix}/imports/${repeated.data.run.id}`, 'GET', undefined, token)).data.run.skipped === 2 && Number((await one('SELECT COUNT(*) AS n FROM support_articles'))?.n) === 2 && Number((await one('SELECT COUNT(*) AS n FROM support_article_revisions'))?.n) === 2, 'external mapping replay skips both collection metadata and every native article locale')
  const updated = structuredClone(source); updated.articles[0]!.body = '<p>Updated private source knowledge.</p>'; updated.articles[0]!.updated_at = 1500000200; delete (updated.articles[0]!.translated_content as any).en
  const changed = await upload(updated); await run(changed.data.run.id)
  const target = (await one('SELECT * FROM support_articles WHERE id = ?', [mapped.target_id]))!
  check(target.body === 'Updated private source knowledge.' && Number(target.revision) === 2 && await one('SELECT id FROM support_article_revisions WHERE article_id = ? AND revision = 1', [target.id]), 'changed source content creates native immutable revision history on its stable target')
  const authored = (await one('SELECT author_id, integration_key_id FROM support_article_revisions WHERE article_id = ? AND revision = 2', [target.id]))!
  check(Number(authored.author_id) === Number(owner.id) && Number(authored.author_id) !== 7001 && Number(authored.integration_key_id) === 0, 'an actual owner-triggered later run is attributed to that native operator only')
  await http(`${prefix}/knowledge/${target.id}`, 'PATCH', { revision: 2, body: 'Native manual editorial work.' }, token)
  const conflicting = structuredClone(updated); conflicting.articles[0]!.body = '<p>Overwrite attempt.</p>'; conflicting.articles[0]!.updated_at = 1500000300
  const conflict = await upload(conflicting); await run(conflict.data.run.id)
  check((await http(`${prefix}/imports/${conflict.data.run.id}`, 'GET', undefined, token)).data.records.some((row: any) => row.error_code === 'import_article_native_changed') && (await one('SELECT body FROM support_articles WHERE id = ?', [target.id]))?.body === 'Native manual editorial work.', 'source reconciliation preserves later native edits with an explicit review conflict')
  const partials = { ...source, collections: [], articles: [article('metadata-only', { body: null, parent_ids: [] }), article('partial-translation', { parent_ids: [], translated_content: { fr: { ...content(), body: null } } }), article('media', { body: '<p>Picture</p><img src="https://private.example/file">', parent_ids: [] }), article('staged', { parent_ids: [], has_unpublished_changes: true }), article('multi-parent', { parent_ids: [18, 19] }), article('markdown-media', { body: null, body_markdown: '![Private image](https://private.example/image)', parent_ids: [] }), article('truncated', { parent_ids: [], truncated: true }), article('missing-timestamp', { parent_ids: [], created_at: null })] }
  const partialPreview = await upload(partials, { integration: true, dryRun: true })
  check(partialPreview.status === 200 && partialPreview.data.reviewRecords === 8, 'metadata-only, partial translations, HTML/Markdown media, staged drafts, truncated content, missing timestamps and multiple parents are explicit dry-run review work')
  const partialRun = await upload(partials); await run(partialRun.data.run.id)
  const report = await http(`${prefix}/imports/${partialRun.data.run.id}`, 'GET', undefined, token)
  check(report.data.run.status === 'needs_review' && report.data.run.failed === 8 && report.data.records.every((row: any) => row.status === 'needs_review'), 'unsupported article exports are never reported as a complete migration')
  check(!await one("SELECT id FROM support_import_mappings WHERE entity_type = 'article' AND external_id LIKE 'partial-translation:%'"), 'one incomplete translation rolls back the entire article checkpoint')
  const single = { version: 1, provider: 'intercom', contacts: [], conversations: [], articleLocale: 'de', articles: [article('single-language', { default_locale: undefined, body: null, body_markdown: '# Anleitung\nPrivater Inhalt.', parent_ids: [] })] }
  const singleRun = await upload(single); await run(singleRun.data.run.id)
  check((await one("SELECT a.locale FROM support_articles a JOIN support_import_mappings m ON m.target_id = a.id WHERE m.entity_type = 'article' AND m.external_id = 'single-language:de'"))?.locale === 'de', 'single-language API responses use an explicit supplied bundle locale without guessing from URLs')
  check(JSON.stringify(await query('SELECT * FROM support_outbox ORDER BY id')) === outboxBeforeImport && Number((await one('SELECT COUNT(*) AS n FROM support_usage'))?.n) === 0 && Number((await one('SELECT COUNT(*) AS n FROM support_knowledge_indexes'))?.n) === 0 && providerCalls === 0, 'article migration sends no notifications, triggers no provider index, and consumes no support AI or conversation quota')
  const incompleteLocale = { ...single, articleLocale: undefined, articles: [article('locale-unknown', { default_locale: undefined, parent_ids: [] })] }
  check((await upload(incompleteLocale, { dryRun: true })).data.reasons[0].code === 'source_article_locale_missing', 'unknown source locale is reported for review rather than invented')
  const revokedSource = { ...single, articles: [article('revoked-principal', { parent_ids: [] })] }
  const revokedRun = await upload(revokedSource, { integration: true })
  await query('UPDATE support_api_keys SET revoked_at = ? WHERE id = ?', [Date.now(), keyRow.id])
  await run(revokedRun.data.run.id, true)
  const revokedStatus = await http(`${prefix}/imports/${revokedRun.data.run.id}`, 'GET', undefined, token)
  check(revokedStatus.data.run.status === 'needs_review' && revokedStatus.data.records[0].error_code === 'import_authorization_revoked' && !await one("SELECT id FROM support_import_mappings WHERE entity_type = 'article' AND external_id = 'revoked-principal:en'"), 'restarted workers recheck the original integration actor and cannot impersonate an owner after key revocation')
  console.log(`PASS Intercom article import ${checks} checks`)
}
finally { await server.stop(true); await provider.stop(true) }
