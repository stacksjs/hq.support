import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  for (const bus of ['memory', 'redis'] as const) {
    const redisUrl = bus === 'redis' ? process.env.SUPPORT_TEST_REDIS_URL : undefined
    test.skipIf((dialect === 'postgres' && !disposablePostgresUrl()) || (bus === 'redis' && !redisUrl))(`inbox presence and reply collisions use native ${dialect} with ${bus} hints`, async () => {
      await withDisposableDatabase(dialect, async database => {
        const result = await runIsolated('tests/fixtures/inbox-presence.ts', { env: { ...database.env, APP_ENV: 'test', APP_URL: 'https://operator.example', STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', SUPPORT_DEPLOYMENT_MODE: 'selfhost', MAIL_MAILER: 'capture', DB_QUERY_LOGGING_ENABLED: 'false', SUPPORT_REALTIME_REDIS_URL: redisUrl, SUPPORT_REALTIME_NAMESPACE: 'support-typing-test-' + crypto.randomUUID() }, envFile: false, preload: [], timeoutMs: 90_000 })
        assertIsolatedOk(result, 'PASS inbox presence and collision protection')
      })
    }, 100_000)
  }
}
