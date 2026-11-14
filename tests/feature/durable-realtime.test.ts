import { test } from 'bun:test'
import { assertIsolatedOk, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`durable support replay persists atomically on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async (database) => {
      const result = await runIsolated('tests/fixtures/durable-realtime.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/private-files', APP_ENV: 'test', DB_QUERY_LOGGING_ENABLED: 'false' }, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(result, 'PASS durable support replay')
    })
  }, 100_000)
}
