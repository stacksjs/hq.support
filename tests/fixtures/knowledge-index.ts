import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { resolvedDatabaseConfig } from '@stacksjs/database/runtime'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { insert, one, query } from '../../app/Support/database'
import { usage } from '../../app/Support/service'
import { periodOf } from '../../app/Support/limits'
import { retrieveKnowledge } from '../../app/Support/knowledge-index'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
const postgres = resolvedDatabaseConfig().driver === 'postgres'
let embeddingCalls = 0
let checks = 0, mode = 'answer', release: (() => void) | undefined, started: (() => void) | undefined
const vectors = (value: string) => /shipping|package|delivery/i.test(value) ? [0, 1, 0] : /private|internal/i.test(value) ? [0, 0, 1] : [1, 0, 0]
const captured: string[] = []
const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
  assert.equal(request.headers.get('authorization'), 'Bearer knowledge-index-test-key')
  const body = await request.json() as any
  if (new URL(request.url).pathname === '/v1/embeddings') {
    embeddingCalls++
    captured.push(...body.input)
    if (mode === 'provider-failure') return Response.json({ error: 'fixture provider outage' }, { status: 503 })
    if (mode === 'block') { started?.(); await new Promise<void>(resolve => { release = resolve }) }
    return Response.json({ data: body.input.map((text: string, index: number) => ({ index, embedding: vectors(text) })).reverse(), ...(mode === 'usage-missing' ? {} : { usage: { total_tokens: 30 } }) })
  }
  const payload = JSON.parse(body.messages.find((message: any) => message.role === 'user').content)
  captured.push(JSON.stringify(payload))
  return Response.json({ model: 'knowledge-fixture', choices: [{ message: { content: JSON.stringify({ answer: 'Reset your password in account settings.', sourceIds: [payload.excerpts[0].id], handoff: false }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })
} })
config.ai.default = 'openai'
config.ai.drivers = { openai: { apiKey: 'knowledge-index-test-key', baseUrl: `http://127.0.0.1:${provider.port}/v1`, embeddingModel: 'fixture-embedding' } }
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
let server: Awaited<ReturnType<typeof route.serve>> | undefined
try {
  if (process.env.KNOWLEDGE_INDEX_PHASE === 'read') {
    const manifest = await Bun.file(process.env.KNOWLEDGE_INDEX_MANIFEST!).json()
    const project = (await one('SELECT * FROM support_projects WHERE public_id = ?', [manifest.project]))!
    const found = await retrieveKnowledge(project, postgres ? 'credentials' : 'password', 'en', { kind: 'public' })
    check(found.articles.some(article => String(article.id) === manifest.article && Number(article.revision) === 2), 'fresh process retrieves persisted current revision without reindexing')
    check(found.retrievalMode === (postgres ? 'pgvector' : 'lexical'), 'restarted process reports the actual durable retrieval mode')
    console.log(`PASS knowledge index restart ${checks} checks`)
  }
  else {
    await injectGlobalAutoImports()
    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    const base = `http://127.0.0.1:${server.port}/api`
    let csrfToken = '', csrfCookie = ''
    async function request(path: string, method = 'GET', data?: unknown, token?: string, origin?: string) {
      const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(csrfCookie ? { cookie: csrfCookie, 'x-csrf-token': csrfToken } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) })
      return { status: response.status, data: await response.json() as any }
    }
    const csrf = await fetch(base + '/csrf-token'); csrfToken = (await csrf.json() as any).token; csrfCookie = csrf.headers.get('set-cookie')!.split(';')[0]!
    await request('/register', 'POST', { name: 'Knowledge index owner', email: 'index@example.test', password: 'KnowledgeIndex2026!', password_confirmation: 'KnowledgeIndex2026!' })
    const login = await request('/login', 'POST', { email: 'index@example.test', password: 'KnowledgeIndex2026!' })
    const token = login.data.token ?? login.data.access_token ?? login.data.data?.token
    check(typeof token === 'string', 'native authenticated owner is available')
    const workspace = (await request('/support/workspaces', 'POST', { name: 'Durable knowledge' }, token)).data.workspace
    const project = (await request(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Durable project' }, token)).data.project
    const agent = `/support/projects/${project.public_id}`, publicHelp = `/help/projects/${project.public_id}/articles`
    const origin = 'https://durable.example'
    await request(agent, 'PATCH', { allowedOrigins: [origin], anonymousEnabled: false }, token)
    async function create(slug: string, body: string, extra: Record<string, unknown> = {}) {
      const result = await request(agent + '/knowledge', 'POST', { slug, title: slug.replaceAll('-', ' '), body, status: 'published', ...extra }, token)
      check(result.status === 201, `article persisted ${JSON.stringify(result.data)}`)
      return result.data.article
    }
    const article = await create('password-reset', 'Reset your password in account settings.')
    const internal = await create('private-investigation', 'INTERNAL_SECRET private account investigation policy.', { visibility: 'internal' })
    const otherLanguage = await create('password-french', 'French credential policy.', { locale: 'fr' })
    const draft = await create('password-draft', 'Unapproved credential policy.', { status: 'draft' })
    const initial = await request(`${agent}/knowledge/${article.id}/index`, 'GET', undefined, token)
    check(initial.status === 200 && initial.data.index.dimensions === 0 && initial.data.index.revision === 1, 'a durable lexical generation is atomically ready at publication')
    check((await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)).status === 200, 'native indexing activates a complete current generation')
    check((await request(`${agent}/knowledge/${internal.id}/index`, 'POST', {}, token)).status === 200, 'internal source is independently indexed')
    if (postgres) check((await request(`${agent}/knowledge/${draft.id}/index`, 'POST', {}, token)).status === 409, 'draft source cannot activate a vector generation')
    if (postgres) {
      const indexedTokens = await usage(Number(workspace.id), 'indexing_tokens')
      check(indexedTokens === 60 && await usage(Number(workspace.id), 'ai') === 0 && await usage(Number(workspace.id), 'copilot_tokens') === 0, 'background embeddings reconcile provider token usage on a separate meter')
      await query("UPDATE support_usage SET used = 100000 WHERE workspace_id = ? AND meter = 'indexing_tokens'", [workspace.id])
      const beforeCap = embeddingCalls
      const capped = await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)
      check(capped.status === 402 && capped.data.error.code === 'indexing_limit' && embeddingCalls === beforeCap, 'indexing budget refuses the provider call before network I/O')
      await query("UPDATE support_usage SET used = ? WHERE workspace_id = ? AND meter = 'indexing_tokens'", [indexedTokens, workspace.id])
      mode = 'provider-failure'
      check((await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)).status === 503 && await usage(Number(workspace.id), 'indexing_tokens') === indexedTokens, 'failed embedding requests release their full durable reservation')
      mode = 'usage-missing'
      check((await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)).status === 200, 'provider without usage can activate using conservative accounting')
      const conservative = await request(`${agent}/knowledge/${article.id}/index`, 'GET', undefined, token)
      check(conservative.data.index.token_accounting === 'conservative' && Number(conservative.data.index.actual_tokens) === Number(conservative.data.index.reserved_tokens) && Number(conservative.data.index.actual_tokens) > 0, 'missing provider usage retains the conservative input-byte reservation')
      mode = 'answer'
      const keys = (await request(agent + '/keys', 'POST', {}, token)).data
      const session = (await request(`/v1/projects/${project.public_id}/sessions`, 'POST', { externalId: 'index-cap-customer' }, keys.ingestKey)).data
      const thread = (await request(`/widget/projects/${project.public_id}/conversations`, 'POST', { subject: 'Credentials', body: 'Credentials help', idempotencyKey: 'cap-thread' }, session.token, origin)).data.conversation
      await insert('support_usage', { workspace_id: workspace.id, period: periodOf(), meter: 'ai', used: 10 })
      const beforeQueryEmbedding = embeddingCalls
      const aiCapped = await request(`/widget/projects/${project.public_id}/conversations/${thread.id}/ai`, 'POST', { question: 'credentials', idempotencyKey: 'cap-query' }, session.token, origin)
      check(aiCapped.status === 402 && embeddingCalls === beforeQueryEmbedding, 'exhausted customer AI allowance rejects before query embedding provider cost')
    }

    const longDocument = await create('bounded-long-document', 'Long private paragraph: ' + 'credential 🚀 '.repeat(1800), { visibility: 'internal', locale: 'de' })
    check((await request(`${agent}/knowledge/${longDocument.id}/index`, 'POST', {}, token)).status === 200, 'native document chunking handles a long paragraph without hidden truncation')
    const longChunks = await query('SELECT c.content FROM support_knowledge_chunks c JOIN support_knowledge_sources s ON s.id = c.source_id WHERE s.article_id = ? ORDER BY c.position', [Number(longDocument.id)])
    check(longChunks.length > 10 && longChunks.every(chunk => String(chunk.content).length <= 600 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(String(chunk.content))), 'chunkDocument size/overlap options bound each persisted chunk and preserve surrogate pairs')
    const capabilities = await request(agent + '/ai/capabilities', 'GET', undefined, token)
    check(capabilities.status === 200 && capabilities.data.retrieval.persistent && capabilities.data.retrieval.mode === (postgres ? 'pgvector' : 'lexical'), 'UI capability metadata names actual durable retrieval')
    if (postgres) {
      await query('UPDATE support_knowledge_chunks SET embedding = ? WHERE source_id IN (SELECT id FROM support_knowledge_sources WHERE article_id = ?)', ['invalid-private-vector', Number(internal.id)])
      const safe = await retrieveKnowledge(project, 'credentials', 'en', { kind: 'public' })
      check(safe.articles.length === 1 && String(safe.articles[0]!.id) === article.id && safe.retrievalMode === 'pgvector', 'semantic retrieval excludes private vectors before distance and matches a synonym')
      check(!JSON.stringify(safe).includes('INTERNAL_SECRET') && !JSON.stringify(safe).includes(otherLanguage.body), 'public result excludes internal and wrong-language content')
    }
    const before = await one('SELECT id FROM support_knowledge_sources WHERE article_id = ? AND project_id = ?', [Number(article.id), project.id])
    if (postgres) {
      const beforeRaceUsage = await usage(Number(workspace.id), 'indexing_tokens')
      mode = 'block'
      const blocked = new Promise<void>(resolve => { started = resolve })
      const old = request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)
      await blocked
      check((await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)).status === 409, 'concurrent same-revision indexing respects the durable lease')
      check((await request(publicHelp + '/password-reset')).status === 200, 'indexing network call holds no database transaction')
      const edited = await request(`${agent}/knowledge/${article.id}`, 'PATCH', { revision: 1, body: 'Reset your password in account settings. Current revision two.' }, token)
      check(edited.status === 200 && edited.data.article.revision === 2, 'new authoritative revision invalidates the old generation immediately')
      mode = 'answer'
      const newest = await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)
      check(newest.status === 200 && newest.data.revision === 2, 'new generation can activate while superseded worker is awaiting its provider')
      release!()
      const stale = await old
      check(stale.status === 409 && stale.data.error.code === 'index_superseded', 'late stale generation cannot overwrite the current revision')
      check(await usage(Number(workspace.id), 'indexing_tokens') === beforeRaceUsage + 30, 'superseded worker refunds its reservation without refunding the successor generation')
      const beforeExpiredUsage = await usage(Number(workspace.id), 'indexing_tokens')
      mode = 'block'
      const expires = new Promise<void>(resolve => { started = resolve })
      const expired = request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)
      await expires
      await query("UPDATE support_knowledge_indexes SET lease_until = ? WHERE source_id = ? AND reservation_state = 'held'", [Date.now() - 1, before!.id])
      await query('UPDATE support_knowledge_sources SET indexing_lease_until = ? WHERE id = ?', [Date.now() - 1, before!.id])
      mode = 'answer'
      check((await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)).status === 200, 'expired generation reservation is recovered before a successor is admitted')
      release!()
      check((await expired).status === 409 && await usage(Number(workspace.id), 'indexing_tokens') === beforeExpiredUsage + 30, 'expired worker cannot refund or overwrite successor accounting')

    }
    else {
      const edited = await request(`${agent}/knowledge/${article.id}`, 'PATCH', { revision: 1, body: 'Reset your password in account settings. Current revision two.' }, token)
      check(edited.status === 200, 'SQLite lexical revision changes atomically')
    }
    const active = await request(`${agent}/knowledge/${article.id}/index`, 'GET', undefined, token)
    check(active.data.source.revision === 2 && active.data.index.revision === 2, 'active source and index agree on the current revision')
    check(Number((await one('SELECT COUNT(*) AS n FROM support_knowledge_chunks WHERE source_id = ? AND revision <> 2', [before!.id]))?.n) === 0, 'old revision chunks are physically removed')
    const revoked = await request(`${agent}/knowledge/${article.id}/permissions`, 'PATCH', { permissionGranted: false }, token)
    check(revoked.status === 200 && (await request(publicHelp + '/password-reset')).status === 404, 'source permission revocation removes public delivery immediately')
    check((await retrieveKnowledge(project, 'password', 'en', { kind: 'public' })).articles.length === 0, 'revoked source is excluded before retrieval')
    check(Number((await one('SELECT COUNT(*) AS n FROM support_knowledge_chunks WHERE source_id = ?', [before!.id]))?.n) === 0, 'permission revocation deletes every indexed chunk')
    await request(`${agent}/knowledge/${article.id}/permissions`, 'PATCH', { permissionGranted: true }, token)
    check((await request(`${agent}/knowledge/${article.id}/index`, 'POST', {}, token)).status === 200, 'regranted source requires and accepts a new generation')
    const removed = await create('shipping-guide', 'Shipping package delivery instructions.')
    await request(`${agent}/knowledge/${removed.id}/index`, 'POST', {}, token)
    const deletion = await request(`${agent}/knowledge/${removed.id}`, 'DELETE', { revision: 1 }, token)
    check(deletion.status === 200 && deletion.data.removed, 'article removal archives authoritative content')
    check((await request(publicHelp + '/shipping-guide')).status === 404, 'removed article has no public delivery')
    check(Number((await one('SELECT COUNT(*) AS n FROM support_knowledge_chunks c JOIN support_knowledge_sources s ON s.id = c.source_id WHERE s.article_id = ?', [Number(removed.id)]))?.n) === 0, 'source deletion propagates to durable chunks')
    const deleted = await retrieveKnowledge(project, 'shipping', 'en', { kind: 'public' })
    check(deleted.articles.length === 0, 'deleted topic has no retrieved evidence')
    await Bun.write(process.env.KNOWLEDGE_INDEX_MANIFEST!, JSON.stringify({ project: project.public_id, article: article.id }))
    console.log(`PASS knowledge index write ${checks} checks`)
  }
}
finally { release?.(); await server?.stop(true); await provider.stop(true) }
