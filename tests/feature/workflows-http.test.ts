import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`versioned workflows branch, wait and recover through native jobs on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async (database) => {
      const result = await runIsolated('tests/fixtures/workflows-http.ts', { env: { ...database.env, APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100' }, envFile: false, preload: [], timeoutMs: 90000 })
      assertIsolatedOk(result, 'PASS workflows HTTP')
    })
  }, 100000)
}
