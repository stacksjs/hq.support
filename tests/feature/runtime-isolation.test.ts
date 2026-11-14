import { expect, test } from 'bun:test'
import { assertIsolatedOk, runIsolated } from '@stacksjs/testing'
import { readRuntimeResult } from '../helpers/runtime-isolation-result'

const targets = ['production', 'staging', 'development'] as const
const expected = {
  production: { namespace: 'hq-support', database: 'hq_support' },
  staging: { namespace: 'hq-support-staging', database: 'hq_support_staging' },
  development: { namespace: 'hq-support-development', database: 'hq_support_development' },
}

test('fixture results tolerate native logs but require one bounded structured result', () => {
  expect(readRuntimeResult('native initialization log\nSUPPORT_RUNTIME_RESULT {"value":"production","jobs":["production"]}\nnative shutdown log\n'))
    .toEqual({ value: 'production', jobs: ['production'] })
  expect(() => readRuntimeResult('native initialization log\n')).toThrow('received 0')
  expect(() => readRuntimeResult('SUPPORT_RUNTIME_RESULT {}\nSUPPORT_RUNTIME_RESULT {}\n')).toThrow('received 2')
  expect(() => readRuntimeResult(`SUPPORT_RUNTIME_RESULT ${'x'.repeat(16_384)}`)).toThrow('size limit')
  expect(() => readRuntimeResult('SUPPORT_RUNTIME_RESULT invalid')).toThrow()
})

test('deployment variables reach the native runtime configuration in every environment', async () => {
  for (const target of targets) {
    for (const site of ['main', 'api']) {
      const result = await runIsolated('tests/fixtures/runtime-isolation.ts', {
        inheritEnv: false, envFile: false, preload: [], env: { SUPPORT_RUNTIME_TARGET: target, SUPPORT_RUNTIME_SITE: site },
      })
      assertIsolatedOk(result)
      const resolved = readRuntimeResult(result.stdout)
      expect(resolved).toEqual({
        environment: target, database: { driver: 'postgres', name: expected[target].database, username: expected[target].database },
        cache: { driver: 'redis', prefix: `${expected[target].namespace}:cache` },
        queue: { driver: 'database', prefix: `${expected[target].namespace}:queue`, failedDriver: 'database', failedPrefix: `${expected[target].namespace}:failed`, batchPrefix: `${expected[target].namespace}:batches` },
        realtime: `${expected[target].namespace}:replay-v1`,
      })
    }
  }
})

for (const setting of [undefined, ''] as const) {
  test(`local configuration defaults absent or empty drivers (${setting === undefined ? 'absent' : 'empty'})`, async () => {
    const result = await runIsolated('tests/fixtures/runtime-isolation.ts', {
      inheritEnv: false, envFile: false, preload: [], env: { APP_ENV: 'development', CACHE_DRIVER: setting, QUEUE_DRIVER: setting },
    })
    assertIsolatedOk(result)
    const resolved = readRuntimeResult(result.stdout)
    expect(resolved.cache).toEqual({ driver: 'memory', prefix: 'hq-support-development:cache' })
    expect(resolved.queue).toEqual({ driver: 'database', prefix: 'hq-support-development:queue', failedDriver: 'database', failedPrefix: 'hq-support-development:failed', batchPrefix: 'hq-support-development:batches' })
  })
}

test('unconfigured native development dispatch runs inline despite the database configuration projection', async () => {
  const result = await runIsolated('tests/fixtures/runtime-isolation.ts', {
    inheritEnv: false, envFile: false, preload: [],
    env: { APP_ENV: 'development', SUPPORT_RUNTIME_MODE: 'local-dispatch' },
  })
  assertIsolatedOk(result)
  expect(readRuntimeResult(result.stdout)).toEqual({ configured: 'database', ranInline: true })
})

for (const [variable, value] of [
  ['CACHE_DRIVER', 'unsupported-cache'], ['QUEUE_DRIVER', 'sqs'],
  ...['CACHE_DRIVER', 'QUEUE_DRIVER'].flatMap(variable => ['false', '0', 'null'].map(value => [variable, value] as const)),
] as const) {
  test(`native boot refuses unsupported ${variable}=${value}`, async () => {
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
    return readRuntimeResult(result.stdout)
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
