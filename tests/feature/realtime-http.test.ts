import { test } from 'bun:test'
import { assertIsolatedOk, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

// Routed seam catches wire/auth/current-authority/SQL atomicity; browser recovery belongs to its own ticket.
for (const dialect of ['sqlite', 'postgres'] as const) {
  for (const transport of ['local', 'redis'] as const) test(`authorized replay HTTP with ${transport} hints on real ${dialect}`, async () => {
    const redisUrl = transport === 'redis' ? process.env.SUPPORT_TEST_REDIS_URL : undefined
    if (transport === 'redis' && !redisUrl) throw new Error('SUPPORT_TEST_REDIS_URL is required for real routed Redis replay qualification')
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/realtime-http.ts', { env: { ...database.env, BUN_CONFIG_MAX_HTTP_REQUESTS: '2048', SUPPORT_REALTIME_REDIS_URL: redisUrl, SUPPORT_REALTIME_NAMESPACE: 'support-http-test-' + crypto.randomUUID(), SUPPORT_DEPLOYMENT_MODE: 'selfhost', APP_ENV: 'test', APP_URL: 'https://operator.example', APP_KEY: 'base64:' + Buffer.alloc(32, 8).toString('base64'), STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false', BUN_OPTIONS: undefined }, envFile: false, preload: [], timeoutMs: 240000 })
      assertIsolatedOk(result, 'PASS authorized replay HTTP')
    })
  }, 250000)
}
