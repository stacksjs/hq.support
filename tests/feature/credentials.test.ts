import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'
for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`project key rotation and scoped customer logout use real ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/credentials.ts', { env: { ...database.env, APP_ENV: 'test', APP_URL: 'https://support.example.test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false', MAIL_MAILER: 'capture', SUPPORT_CREDENTIAL_BROWSER: dialect === 'sqlite' ? process.env.SUPPORT_CREDENTIAL_BROWSER : undefined, CHROME_PATH: process.env.CHROME_PATH }, envFile: false, preload: [], timeoutMs: 180000 })
      assertIsolatedOk(result, 'PASS credential HTTP')
      console.info(result.stdout.match(/PASS credential HTTP \(\d+ checks\)/)?.[0])
      if (dialect === 'sqlite' && process.env.SUPPORT_CREDENTIAL_BROWSER === '1') console.info(result.stdout.match(/PASS credential browser \(\d+ checks\)/)?.[0])
    })
  }, 190000)
}
