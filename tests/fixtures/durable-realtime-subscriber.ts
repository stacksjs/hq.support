import assert from 'node:assert/strict'
import { createRedisInvalidationBus } from '@stacksjs/realtime'
import { notifyTestServiceReady } from '@stacksjs/testing/service'
import { supportRealtimeRedisUrl } from '../../app/Support/realtime-config'

const redisUrl = supportRealtimeRedisUrl()
assert(redisUrl)
const bus = createRedisInvalidationBus({ url: redisUrl, namespace: process.env.SUPPORT_REALTIME_NAMESPACE!, maxChannels: 4096, maxSubscriptions: 4096 })
const channels = JSON.parse(process.argv[2]!) as string[]
const notices: string[] = []
const unsubscribe = await bus.subscribe({ channels, onInvalidate: notice => { if (notice.reason === 'hint') notices.push(...notice.channels) } })
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(notices) })
assert(notifyTestServiceReady({ url: server.url.href }))
process.on('SIGTERM', async () => { unsubscribe(); await bus.close(); await server.stop(true); process.exit(0) })
