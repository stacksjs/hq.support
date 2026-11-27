import { expect, test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`native HTTP auth, tenant boundaries, exact allowances, idempotency and HQ connect use real ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async (database) => {
      const result = await runIsolated('tests/fixtures/support-http.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/private-files', APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100' }, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(result, 'PASS support HTTP')
      if (dialect === 'sqlite') {
        expect(result.stderr).toContain('[support] request failed SQLiteError operation=widget.create sqlite_errno=1811')
        expect(result.stderr).not.toContain('fixture-private-sqlite-error')
        expect(result.stdout).not.toContain('fixture-private-sqlite-error')
      }
    })
  }, 100_000)
}
