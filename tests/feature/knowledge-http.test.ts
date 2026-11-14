import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`knowledge revisions, AI grounding, durable retries and exact limits use real ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async (database) => {
      const result = await runIsolated('tests/fixtures/knowledge-http.ts', { env: { ...database.env, APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(result, 'PASS knowledge HTTP')
    })
  }, 100_000)
}
