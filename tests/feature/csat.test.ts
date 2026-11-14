import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`customer satisfaction preserves tenant, revision and once-only response on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/csat.ts', { env: { ...database.env, APP_ENV: 'test', SUPPORT_DEPLOYMENT_MODE: 'selfhost', STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false', MAIL_MAILER: 'capture' }, envFile: false, preload: [], timeoutMs: 90000 })
      assertIsolatedOk(result, 'PASS CSAT HTTP')
    })
  }, 100000)
}
