import { assertIsolatedOk, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

// Uses installed native packages, a disposable SQLite DB, native auth, actual
// production Settings STX and Chromium. No source aliases or provider traffic.
await withDisposableDatabase('sqlite', async database => {
  const result = await runIsolated('tests/fixtures/credentials.ts', {
    env: { ...database.env, APP_ENV: 'test', APP_URL: 'https://support.example.test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false', MAIL_MAILER: 'capture', SUPPORT_CREDENTIAL_BROWSER: '1', CHROME_PATH: process.env.CHROME_PATH },
    envFile: false, preload: [], timeoutMs: 180000,
  })
  assertIsolatedOk(result, 'PASS credential browser')
  console.info(result.stdout.match(/PASS credential browser \(\d+ checks\)/)?.[0])
  console.info(result.stdout.match(/PASS credential HTTP \(\d+ checks\)/)?.[0])
})
