import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { one } from '../../app/Support/database'
import { query } from '../../app/Support/database'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let csrf = '', cookie = ''
async function request(path: string, method = 'GET', body?: unknown, token?: string, extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, data: await response.json(), headers: response.headers }
}
try {
  const challenge = await request('/csrf-token'); csrf = challenge.data.token; cookie = challenge.headers.get('set-cookie')!.split(';')[0]!
  await request('/register', 'POST', { name: 'Docs Owner', email: 'documentation@example.test', password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  const login = await request('/login', 'POST', { email: 'documentation@example.test', password: 'SecureSupport2026!' })
  const token = login.data.token ?? login.data.access_token ?? login.data.data?.token
  const workspace = (await request('/support/workspaces', 'POST', { name: 'Documentation team' }, token)).data.workspace
  const created = await request(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Docs application' }, token)
  const project = created.data.project
  const agent = `/support/projects/${project.public_id}`
  const keys = (await request(agent + '/keys', 'POST', {}, token)).data
  const installation = `/v1/projects/${project.public_id}/installation`
  const nativeInstallation = { origin: 'https://native-app.example', frameworkVersion: '0.75.576' }
  assert.equal((await request(installation, 'POST', nativeInstallation, keys.ingestKey)).status, 403)
  await query('UPDATE support_projects SET buddy_connected_at = ? WHERE id = ?', [Date.now(), project.id])
  assert.equal((await request(installation, 'POST', nativeInstallation, keys.readKey)).status, 401)
  assert.equal((await request(installation, 'POST', nativeInstallation, keys.ingestKey)).status, 200)
  assert.equal((await request(installation, 'POST', nativeInstallation, keys.ingestKey)).status, 200)
  const installed = await request(installation, 'GET', undefined, keys.ingestKey)
  assert.deepEqual(installed.data.allowedOrigins, ['https://native-app.example'])
  assert.equal(installed.data.anonymousEnabled, false)
  assert.equal((await request(installation, 'POST', { ...nativeInstallation, origin: 'https://user:secret@wrong.example' }, keys.ingestKey)).status, 422)
  const endpoint = `/v1/projects/${project.public_id}/knowledge/sync`
  const documents = [{ source: 'docs/getting-started.md', title: 'Getting started', body: 'Configure a support workspace and verify ownership.' }]
  assert.equal((await request(endpoint, 'POST', { documents }, keys.readKey)).status, 401)
  assert.equal((await request(endpoint, 'POST', { documents })).status, 401)
  const first = await request(endpoint, 'POST', { documents }, keys.ingestKey)
  assert.equal(first.status, 200, JSON.stringify(first.data))
  const article = first.data.documents[0]
  assert.equal(article.revision, 1)
  assert.equal(article.changed, true)
  const stored = (await one('SELECT * FROM support_articles WHERE id = ?', [article.id]))!
  assert.equal(stored.status, 'draft')
  assert.equal(stored.visibility, 'internal')
  const revision = (await one('SELECT author_id, integration_key_id FROM support_article_revisions WHERE article_id = ?', [article.id]))!
  assert.equal(Number(revision.author_id), 0, 'integration does not impersonate a human author')
  assert.ok(Number(revision.integration_key_id) > 0)
  const replay = await request(endpoint, 'POST', { documents }, keys.ingestKey)
  assert.equal(replay.data.documents[0].changed, false)
  const published = [{ ...documents[0], visibility: 'public', publish: true, body: 'Choose Settings to connect support.' }]
  assert.equal((await request(endpoint, 'POST', { documents: published }, keys.ingestKey)).data.documents[0].revision, 2)
  assert.equal((await request(`/help/projects/${project.public_id}/articles`, 'GET')).data.articles.length, 1)
  assert.equal((await request(endpoint, 'POST', { documents: [{ ...documents[0], source: '../secret.md' }] }, keys.ingestKey)).status, 422)
  assert.equal((await request(agent + '/knowledge/' + article.id, 'PATCH', { revision: 2, body: 'A human correction.' }, token)).status, 200)
  const conflict = await request(endpoint, 'POST', { documents: [{ ...documents[0], source: 'docs/second.md' }, { ...documents[0], body: 'A conflicting source update' }] }, keys.ingestKey)
  assert.equal(conflict.status, 409, JSON.stringify(conflict.data))
  assert.equal(Number((await one('SELECT COUNT(*) AS count FROM support_articles WHERE project_id = ?', [project.id]))!.count), 1, 'bundle conflict rolls back preceding article and mapping')
  await query("UPDATE support_api_keys SET revoked_at = ? WHERE project_id = ? AND scope = 'write'", [Date.now(), project.id])
  assert.equal((await request(endpoint, 'POST', { documents }, keys.ingestKey)).status, 401)
  console.info('PASS support documentation')
}
finally { server.stop(true) }
