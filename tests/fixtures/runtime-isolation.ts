import { resolve } from 'node:path'

const target = process.env.SUPPORT_RUNTIME_TARGET
if (target) {
  // Match Buddy's selected blueprint, then start the app using its site env.
  const { tsCloud } = await import(resolve(import.meta.dir, '../../config/cloud.ts') + '?env=' + target)
  const site = process.env.SUPPORT_RUNTIME_SITE === 'api' ? 'api' : 'main'
  Object.assign(process.env, tsCloud.sites[site].env)
}
const { awaitConfig } = await import('@stacksjs/config')
const config = await awaitConfig()
const mode = process.env.SUPPORT_RUNTIME_MODE
if (mode) {
  const proofId = process.env.SUPPORT_RUNTIME_PROOF
  if (!proofId || !target) throw new Error('A unique proof id and deployment target are required')
  const key = `runtime-isolation-${proofId}`
  const { cache } = await import('@stacksjs/cache')
  const { getRedisQueue } = await import('@stacksjs/queue')
  const RedisQueue = await getRedisQueue()
  const queue = new RedisQueue(key, config.queue.connections.redis)
  try {
    if (mode === 'write') {
      await cache.set(key, target, 120)
      await queue.add({ environment: target })
    }
    if (mode === 'cleanup') {
      await cache.del(key)
      for (const job of await queue.getJobs('waiting')) await queue.removeJob(job.id)
    }
    console.info(JSON.stringify({
      value: await cache.get(key) ?? null,
      jobs: (await queue.getJobs('waiting')).map(job => job.data.environment),
    }))
  }
  finally {
    await queue.close()
    await cache.close()
  }
}
else {
  console.info(JSON.stringify({
    environment: config.app.env,
    database: { driver: config.database.default, name: config.database.connections.postgres.name, username: config.database.connections.postgres.username },
    cache: { driver: config.cache.driver, prefix: config.cache.prefix },
    queue: { driver: config.queue.default, prefix: config.queue.connections.redis.prefix, failedDriver: config.queue.failed.driver, failedPrefix: config.queue.failed.prefix, batchPrefix: config.queue.batching.prefix },
    realtime: process.env.SUPPORT_REALTIME_NAMESPACE,
  }))
}
export {}
