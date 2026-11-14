import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`agent conversation search scopes message text and stable filtered pages on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/conversation-search.ts', { env: { ...database.env, SUPPORT_DEPLOYMENT_MODE: 'selfhost', APP_ENV: 'test', MAIL_MAILER: 'capture', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100' }, envFile: false, preload: [], timeoutMs: 90000 })
      assertIsolatedOk(result, 'PASS conversation search HTTP')
    })
  }, 100000)
}
