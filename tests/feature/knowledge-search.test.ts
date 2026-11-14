import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`public article ${dialect} search filters source grants, ranks current articles and makes no provider requests`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/knowledge-search.ts', { env: { ...database.env, APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(result, 'PASS public knowledge search')
    })
  }, 100_000)
}
