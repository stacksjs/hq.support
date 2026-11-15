import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

// Real routed/native auth seam; optional plain Chrome proves actual CORS visibility, without stx.
for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`customer authority errors honor current project Origin on ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/customer-auth-cors.ts', { env: { ...database.env, APP_ENV: 'test', APP_URL: 'https://operator.example', APP_KEY: 'base64:' + Buffer.alloc(32, 8).toString('base64'), SUPPORT_DEPLOYMENT_MODE: 'selfhost', STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false', SUPPORT_AUTH_CORS_BROWSER: dialect === 'sqlite' ? process.env.SUPPORT_AUTH_CORS_BROWSER : undefined, CHROME_PATH: process.env.CHROME_PATH, BUN_CHROME_PATH: process.env.BUN_CHROME_PATH }, envFile: false, preload: [], timeoutMs: 150000 })
      assertIsolatedOk(result, 'PASS customer authority CORS')
    })
  }, 160000)
}
