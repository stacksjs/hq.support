import assert from 'node:assert/strict'
import { feature, overridesReady } from '@stacksjs/config'
import { runDatabaseMigration } from '@stacksjs/database'
import { defaultsPath } from '@stacksjs/path'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { query } from '../../app/Support/database'

await overridesReady
assert.equal(feature('dashboard'), true)
assert.equal((await runDatabaseMigration()).isOk, true)
await injectGlobalAutoImports()
await route.importRoutes()
await route.register(defaultsPath('routes/dashboard-api.ts'))
await query('INSERT INTO failed_jobs (connection, queue, payload, exception, attempts, failed_at) VALUES (?, ?, ?, ?, ?, ?)', [
  'database', 'support-email', 'unrenderable-test-payload', 'unrenderable-test-exception', 3, '2026-01-01T00:00:00.000Z',
])

const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
try {
  const get = (path: string) => fetch(new URL('/api/dashboard/models' + path, server.url))
  const catalogResponse = await get('')
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json() as { categoryGroups: { models: { name: string }[] }[] }
  assert.deepEqual(catalog.categoryGroups.flatMap(group => group.models.map(model => model.name)), ['FailedJob'])

  const listing = await get('/failed-job')
  assert.equal(listing.status, 200)
  const serialized = await listing.text()
  const result = JSON.parse(serialized) as { rows: { queue: string }[], listColumns: string[], writable: boolean, actions: unknown[] }
  assert.deepEqual(result.rows.map(row => row.queue), ['support-email'])
  assert.deepEqual(result.listColumns, ['queue', 'connection', 'attempts', 'failed_at'])
  assert.equal(result.writable, false)
  assert.deepEqual(result.actions, [])
  assert.doesNotMatch(serialized, /unrenderable-test|"(?:payload|exception)"(?:,|:)/)

  for (const slug of ['workspace', 'conversation', 'contact', 'api-key', 'queue-worker', 'customer-session']) {
    const response = await get('/' + slug)
    assert.equal(response.status, 404)
    await response.body?.cancel()
  }
  console.info('PASS native operator model catalog')
}
finally {
  await server.stop(true)
}
