import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'
for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`durable paid phone operations, signed callbacks and media use real ${dialect}`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const result = await runIsolated('tests/fixtures/phone.ts', { env: { ...database.env, APP_ENV: 'test', APP_URL: 'https://support.example.test', APP_KEY: 'base64:' + Buffer.alloc(32, 7).toString('base64'), OPENAI_API_KEY: 'fixture-not-a-live-key', SUPPORT_VOICE_MEDIA_URL: 'wss://voice.example.test', STACKS_DEFAULT_ROUTES: 'auth', STACKS_RATE_LIMIT_SCALE: '100', DB_QUERY_LOGGING_ENABLED: 'false' }, envFile: false, preload: [], timeoutMs: 90000 })
      assertIsolatedOk(result, 'PASS phone HTTP and media')
    })
  }, 100000)
}
