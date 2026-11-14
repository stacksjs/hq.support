import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'
for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`signed SES intake, private MIME and uncertain sends use real ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/email.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/email-files', APP_ENV: 'test', APP_URL: 'https://support.example.test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false' }, envFile: false, preload: [], timeoutMs: 90000 })
      assertIsolatedOk(result, 'PASS email HTTP and MIME')
    })
  }, 100000)
}
