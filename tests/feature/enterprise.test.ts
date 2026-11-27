import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`enterprise signed entitlements, native OIDC sessions and scoped SCIM use real ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/enterprise.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/private-files', APP_ENV: 'test', APP_URL: 'https://support.example.test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100', SUPPORT_DEPLOYMENT_MODE: 'selfhost', SUPPORT_ENTERPRISE_LICENSE: undefined, SUPPORT_ENTERPRISE_OIDC_ENDPOINTS: undefined }, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(result, 'PASS enterprise HTTP')
    })
  }, 100_000)
}
