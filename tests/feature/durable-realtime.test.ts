import { test } from 'bun:test'
import { assertIsolatedOk, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  for (const transport of ['local', 'redis'] as const) {
    test(`durable support replay with ${transport} hints persists atomically on ${dialect}`, async () => {
      const redisUrl = transport === 'redis' ? process.env.SUPPORT_TEST_REDIS_URL : undefined
      if (transport === 'redis' && !redisUrl) throw new Error('SUPPORT_TEST_REDIS_URL is required for the real Redis proof')
      await withDisposableDatabase(dialect, async (database) => {
        const result = await runIsolated('tests/fixtures/durable-realtime.ts', { env: { ...database.env, SUPPORT_TEST_STORAGE: database.directory + '/private-files', SUPPORT_REALTIME_REDIS_URL: redisUrl, SUPPORT_REALTIME_NAMESPACE: `support-replay-test-${crypto.randomUUID()}`, APP_ENV: 'test', QUEUE_DRIVER: 'database', DB_QUERY_LOGGING_ENABLED: 'false' }, envFile: false, preload: [], timeoutMs: 90_000 })
        assertIsolatedOk(result, 'PASS durable support replay')
      })
    }, 100_000)
  }
}
