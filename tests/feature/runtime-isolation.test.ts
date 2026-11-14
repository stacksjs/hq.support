import { expect, test } from 'bun:test'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing'

const targets = ['production', 'staging', 'development'] as const
const expected = {
  production: { namespace: 'hq-support', database: 'hq_support' },
  staging: { namespace: 'hq-support-staging', database: 'hq_support_staging' },
  development: { namespace: 'hq-support-development', database: 'hq_support_development' },
}

test('deployment variables reach the native runtime configuration in every environment', async () => {
  for (const target of targets) {
    for (const site of ['main', 'api']) {
      const result = await runIsolated('tests/fixtures/runtime-isolation.ts', {
        inheritEnv: false, envFile: false, preload: [], env: { SUPPORT_RUNTIME_TARGET: target, SUPPORT_RUNTIME_SITE: site },
      })
      assertIsolatedOk(result)
      const resolved = JSON.parse(result.stdout.trim())
      expect(resolved).toEqual({
        environment: target, database: { driver: 'postgres', name: expected[target].database, username: expected[target].database },
        cache: { driver: 'redis', prefix: `${expected[target].namespace}:cache` },
        queue: { driver: 'database', prefix: `${expected[target].namespace}:queue`, failedDriver: 'database', failedPrefix: `${expected[target].namespace}:failed`, batchPrefix: `${expected[target].namespace}:batches` },
        realtime: `${expected[target].namespace}:replay-v1`,
      })
    }
  }
})

test('unconfigured local runtime uses HQ development namespaces and the database queue', async () => {
  const result = await runIsolated('tests/fixtures/runtime-isolation.ts', {
    inheritEnv: false, envFile: false, preload: [], env: { APP_ENV: 'development' },
  })
  assertIsolatedOk(result)
  const resolved = JSON.parse(result.stdout.trim())
  expect(resolved.cache).toEqual({ driver: 'memory', prefix: 'hq-support-development:cache' })
  expect(resolved.queue).toEqual({ driver: 'database', prefix: 'hq-support-development:queue', failedDriver: 'database', failedPrefix: 'hq-support-development:failed', batchPrefix: 'hq-support-development:batches' })
})

for (const [variable, value] of [['CACHE_DRIVER', 'unsupported-cache'], ['QUEUE_DRIVER', 'sqs']] as const) {
  test(`native boot refuses unsupported ${variable}`, async () => {
    const result = await runIsolated('tests/fixtures/runtime-isolation.ts', {
      inheritEnv: false, envFile: false, preload: [], env: { APP_ENV: 'production', [variable]: value },
    })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain(value)
    expect(result.stderr).toContain('configuration issue(s) detected at boot')
  })
}

test('native cache and Redis queues persist across processes without crossing deployment namespaces', async () => {
  const redisUrl = process.env.SUPPORT_TEST_REDIS_URL
  if (!redisUrl) throw new Error('SUPPORT_TEST_REDIS_URL is required for the real Redis isolation proof')
  const proofId = crypto.randomUUID()
  async function access(target: typeof targets[number], mode: 'write' | 'read' | 'cleanup') {
    const result = await runIsolated('tests/fixtures/runtime-isolation.ts', {
      inheritEnv: false, envFile: false, preload: [], timeoutMs: 20_000,
      env: { SUPPORT_RUNTIME_TARGET: target, SUPPORT_RUNTIME_MODE: mode, SUPPORT_RUNTIME_PROOF: proofId, REDIS_URL: redisUrl, QUEUE_LOG_LEVEL: 'silent' },
    })
    assertIsolatedOk(result)
    return JSON.parse(result.stdout.trim())
  }
  try {
    for (const target of targets) {
      // A fresh process using the same logical cache key and queue name sees
      // none of the previous environments' writes on the same real server.
      expect(await access(target, 'read')).toEqual({ value: null, jobs: [] })
      expect(await access(target, 'write')).toEqual({ value: target, jobs: [target] })
    }
    for (const target of targets) expect(await access(target, 'read')).toEqual({ value: target, jobs: [target] })
  }
  finally {
    for (const target of targets) await access(target, 'cleanup')
  }
}, 100_000)
