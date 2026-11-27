import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`inbox presence and reply collisions use native ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/inbox-presence.ts', { env: { ...database.env, APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', SUPPORT_DEPLOYMENT_MODE: 'selfhost', MAIL_MAILER: 'capture', DB_QUERY_LOGGING_ENABLED: 'false' }, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(result, 'PASS inbox presence and collision protection')
    })
  }, 100_000)
}
