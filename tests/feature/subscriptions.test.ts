import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`hosted subscription lifecycle uses canonical provider state on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/subscriptions.ts', {
        env: { ...database.env, APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', MAIL_MAILER: 'capture', DB_QUERY_LOGGING_ENABLED: 'false', STRIPE_SECRET_KEY: 'sk_test_local_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_local_fixture' },
        envFile: false, preload: [], timeoutMs: 90000,
      })
      assertIsolatedOk(result, 'PASS support subscriptions')
    })
  }, 100000)
}
