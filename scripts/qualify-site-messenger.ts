import { withDisposableDatabase } from '@stacksjs/testing/disposable-database'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'

await withDisposableDatabase('sqlite', async (database) => {
  const result = await runIsolated('tests/fixtures/site-messenger.ts', {
    env: {
      ...database.env,
      APP_ENV: 'test',
      APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'),
      SUPPORT_DEPLOYMENT_MODE: 'selfhost',
      STACKS_DEFAULT_ROUTES: 'auth',
      MAIL_MAILER: 'log',
      CHROME_PATH: process.env.CHROME_PATH,
      BUN_OPTIONS: undefined,
    },
    envFile: false,
    preload: [],
    timeoutMs: 120000,
  })
  assertIsolatedOk(result, 'PASS homepage Messenger')
  console.info('PASS homepage Messenger with native Stacks HTTP, SQLite and Chromium')
})
