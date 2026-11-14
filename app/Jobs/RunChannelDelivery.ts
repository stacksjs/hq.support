import { Job } from '@stacksjs/queue'
import { applyChannelInbound, dispatchChannelDelivery, pollDiscordChannel, recoverChannelWork } from '../Support/managed-channels'
import { one, query } from '../Support/database'

export default new Job({
  name: 'RunChannelDelivery', description: 'Deliver qualified text channels and recover durable inbox and cost checkpoints.',
  queue: 'support-channels', tries: 3, timeout: 60, backoff: [1, 5, 30], rate: '* * * * *', enabled: true,
  async handle(payload?: { deliveryId?: number, inboundId?: number }) {
    if (payload?.deliveryId) return await dispatchChannelDelivery(payload.deliveryId)
    if (payload?.inboundId) return await applyChannelInbound(payload.inboundId)
    const result = await recoverChannelWork()
    const channels = await query("SELECT * FROM support_channels WHERE provider = 'discord' AND status = 'ready' ORDER BY id LIMIT 100")
    for (const channel of channels) {
      const project = await one('SELECT * FROM support_projects WHERE id = ?', [channel.project_id])
      if (project) await pollDiscordChannel(project, channel.id).catch(() => undefined)
    }
    return result
  },
})
