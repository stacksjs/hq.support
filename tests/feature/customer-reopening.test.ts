import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`customer reply admission and historical delivery targets remain exact on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/customer-reopening.ts', { env: { ...database.env, SUPPORT_REOPEN_STATE: database.directory + '/reopen.json', SUPPORT_TEST_STORAGE: database.directory + '/files', SUPPORT_DEPLOYMENT_MODE: 'selfhost', APP_ENV: 'test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', MAIL_MAILER: 'log', DB_QUERY_LOGGING_ENABLED: 'false', BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 120000 })
      assertIsolatedOk(result, 'PASS customer reopening HTTP')
    })
  }, 130000)
}
