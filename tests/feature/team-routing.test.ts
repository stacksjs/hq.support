import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

// HTTP catches auth, tenant checks and concurrent SQL admission; no browser UI or provider delivery is claimed.
for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`team inbox routing persists exact capacity, round robin and assignment provenance on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/team-routing.ts', { env: { ...database.env, SUPPORT_TEST_ROUTING_STATE: database.directory + '/routing-state.json', SUPPORT_TEST_STORAGE: database.directory + '/private-files', SUPPORT_DEPLOYMENT_MODE: 'selfhost', APP_ENV: 'test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), MAIL_MAILER: 'log', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100', BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 120000 })
      assertIsolatedOk(result, 'PASS team routing HTTP')
    })
  }, 130000)
}
