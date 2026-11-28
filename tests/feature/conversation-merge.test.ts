import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`duplicate conversations retain their own history and send new replies to the primary on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/conversation-merge.ts', {
        env: { ...database.env, APP_ENV: 'test', SUPPORT_DEPLOYMENT_MODE: 'selfhost', STACKS_DEFAULT_ROUTES: 'auth', MAIL_MAILER: 'log', DB_QUERY_LOGGING_ENABLED: 'false' },
        envFile: false,
        preload: [],
        timeoutMs: 90000,
      })
      assertIsolatedOk(result, 'PASS conversation merge HTTP')
    })
  }, 100000)
}
