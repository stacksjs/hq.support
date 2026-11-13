import { test } from 'bun:test'
import { assertIsolatedOk, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

test('native HTTP auth, tenant boundaries, exact allowances, idempotency and HQ connect use real SQLite', async () => {
  await withDisposableDatabase('sqlite', async (database) => {
    const result = await runIsolated('tests/fixtures/support-http.ts', { env: { ...database.env, APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100' }, envFile: false, preload: [], timeoutMs: 90_000 })
    assertIsolatedOk(result, 'PASS support HTTP SQLite')
  })
}, 100_000)
