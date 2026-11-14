import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'
for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`native channel isolation, uncertain delivery and exact costs on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/channels-http.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/private-files', APP_ENV: 'test', MAIL_MAILER: 'log', APP_URL: 'https://support.example.test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100' }, envFile: false, preload: [], timeoutMs: 120000 })
      assertIsolatedOk(result, 'PASS managed channel HTTP')
    })
  }, 130000)
}
