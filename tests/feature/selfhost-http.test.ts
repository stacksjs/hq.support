import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'
for (const dialect of ['sqlite', 'postgres'] as const) {
  for (const mode of ['default', 'selfhost'] as const) {
    test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`${mode} operator mode enforces native core entitlements and independent paid-provider controls on ${dialect}`, async () => {
      await withDisposableDatabase(dialect, async database => {
        const result = await runIsolated('tests/fixtures/selfhost-http.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/private-files', SUPPORT_TEST_MODE: mode, SUPPORT_DEPLOYMENT_MODE: mode === 'selfhost' ? 'selfhost' : undefined, APP_ENV: 'test', MAIL_MAILER: 'log', APP_URL: 'https://support.example.test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), STRIPE_SECRET_KEY: 'sk_test_selfhost_fixture_not_a_live_key', STRIPE_WEBHOOK_SECRET: 'whsec_selfhost_fixture', SUPPORT_ENTERPRISE_LICENSE: '', SUPPORT_ENTERPRISE_LICENSE_PUBLIC_KEY: '', SUPPORT_INSTALLATION_ID: 'selfhost-fixture', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100', BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 120000 })
        assertIsolatedOk(result, 'PASS selfhost operator HTTP')
      })
    }, 130000)
  }
}
