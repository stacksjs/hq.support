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
    const channels = await query(
      `SELECT channel.id, channel.project_id, channel.workspace_id
       FROM support_channel_cursors AS cursor
       JOIN support_channels AS channel ON channel.id = cursor.channel_id
        AND channel.project_id = cursor.project_id AND channel.workspace_id = cursor.workspace_id
       WHERE channel.provider = 'discord' AND channel.status = 'ready' AND channel.verified_at > 0 AND cursor.lease_until <= ?
       ORDER BY cursor.updated_at, cursor.id LIMIT 100`,
      [Date.now()],
    )
    for (const channel of channels) {
      const project = await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [channel.project_id, channel.workspace_id])
      if (project) await pollDiscordChannel(project, channel.id).catch(() => undefined)
    }
    return result
  },
})
