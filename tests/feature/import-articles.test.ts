import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`Intercom article ${dialect} migration rehearses, resumes and preserves private revisions and provenance`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/import-articles.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/private-files', APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }, envFile: false, preload: [], timeoutMs: 120000 })
      assertIsolatedOk(result, 'PASS Intercom article import')
    })
  }, 130000)
}
