import { test } from 'bun:test'
import { assertIsolatedOk, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

// Route seam: catches customer-visible SQL/auth/projection regressions; does not qualify realtime delivery.
for (const dialect of ['sqlite', 'postgres'] as const) {
  test(`customer public projection and bounded history on real ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/customer-projection.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/files', SUPPORT_DEPLOYMENT_MODE: 'selfhost', APP_ENV: 'test', APP_KEY: 'base64:' + Buffer.alloc(32, 8).toString('base64'), STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false', BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 120000 })
      assertIsolatedOk(result, 'PASS customer projection HTTP')
    })
  }, 130000)
}
