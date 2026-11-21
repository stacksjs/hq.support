import { test } from 'bun:test'
import { withDisposableDatabase } from '@stacksjs/testing/disposable-database'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing/isolated'

test('native operator model catalog shows failure metadata and excludes tenant models', async () => {
  await withDisposableDatabase('sqlite', async (database) => {
    const result = await runIsolated('tests/fixtures/operator-dashboard.ts', {
      env: {
        ...database.env,
        APP_ENV: 'test',
        APP_URL: 'http://127.0.0.1',
        SUPPORT_OPERATOR_DASHBOARD: '1',
        STACKS_DEFAULT_ROUTES: 'auth',
        BUN_OPTIONS: undefined,
      },
      envFile: false,
      preload: [],
      timeoutMs: 60000,
    })
    assertIsolatedOk(result, 'PASS native operator model catalog')
  })
}, 70000)
