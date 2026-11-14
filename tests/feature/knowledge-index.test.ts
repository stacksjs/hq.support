import { test } from 'bun:test'
import { assertIsolatedOk, disposablePostgresUrl, runIsolated, withDisposableDatabase } from '@stacksjs/testing'

for (const dialect of ['sqlite', 'postgres'] as const) {
  test.skipIf(dialect === 'postgres' && !disposablePostgresUrl())(`durable knowledge ${dialect} generations exclude stale/private sources and survive a process restart`, async () => {
    await withDisposableDatabase(dialect, async database => {
      const env = { ...database.env, KNOWLEDGE_INDEX_MANIFEST: database.directory + '/knowledge.json', APP_ENV: 'test', STACKS_DEFAULT_ROUTES: 'auth', DB_QUERY_LOGGING_ENABLED: 'false', STACKS_RATE_LIMIT_SCALE: '100', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' }
      const result = await runIsolated('tests/fixtures/knowledge-index.ts', { env, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(result, 'PASS knowledge index write')
      const restarted = await runIsolated('tests/fixtures/knowledge-index.ts', { env: { ...env, KNOWLEDGE_INDEX_PHASE: 'read' }, envFile: false, preload: [], timeoutMs: 90_000 })
      assertIsolatedOk(restarted, 'PASS knowledge index restart')
    })
  }, 180_000)
}
