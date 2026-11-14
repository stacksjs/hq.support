import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'
import { withDisposableDatabase } from '@stacksjs/testing/disposable-database'

// Browser + native HTTP + generated SQLite catches client races and destination/draft
// ownership. The backend's dedicated suite covers PostgreSQL admission concurrency.
await withDisposableDatabase('sqlite', async database => {
  const result = await runIsolated('tests/fixtures/reopening-browser.ts', { env: { ...database.env, APP_ENV: 'test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), SUPPORT_DEPLOYMENT_MODE: 'selfhost', STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false', MAIL_MAILER: 'log', CHROME_PATH: process.env.CHROME_PATH, BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 180000 })
  console.info(result.stdout.match(/PASS reopening browser functional \(\d+ checks\)/)?.[0] || 'Reopening browser proof did not reach its functional checkpoint.')
  assertIsolatedOk(result, 'PASS reopening browser qualification')
})
