import { Action } from '@stacksjs/actions/runtime'
import type { ChannelDependencies } from '../../Support/channel-providers'
import { agentProject, member, object } from '../../Support/service'
import { query } from '../../Support/database'
import { loadChannel, publicChannel, saveChannel } from '../../Support/channels'
import { channelDelivery, createChannelReply, deliveryView, pollDiscordChannel, reconcileChannelDelivery, verifyTextChannel } from '../../Support/managed-channels'
import { SupportError, fail } from '../../Support/errors'
import { textChannelWebhook } from '../../Support/channel-webhooks'

export type ChannelOperation = 'list' | 'save' | 'verify' | 'disable' | 'deliveries' | 'delivery' | 'reply' | 'reconcile' | 'poll' | 'incoming' | 'status' | 'challenge'
export function channelAction(operation: ChannelOperation, method: 'GET' | 'POST', dependencies: ChannelDependencies = {}) {
  return new Action({
    name: `Support text channel ${operation}`, method, apiResponse: false,
    async handle(request) {
      try {
        if (operation === 'incoming' || operation === 'status' || operation === 'challenge') return await textChannelWebhook(request, operation, dependencies)
        const account = await request.user()
        if (!account) fail(401, 'unauthorized', 'Sign in to continue.')
        const project = await agentProject(Number(account.id), request.getParam('project'))
        const data = object(request.all()), userId = Number(account.id)
        if (JSON.stringify(data).length > 32768) fail(413, 'channel_input_large', 'Channel input exceeds the credential bound.')
        let result: unknown
        if (operation === 'list') result = { channels: (await query('SELECT * FROM support_channels WHERE project_id = ? AND workspace_id = ? ORDER BY id', [project.id, project.workspace_id])).map(publicChannel) }
        else if (operation === 'save') result = { channel: publicChannel(await saveChannel(project, { ...data, ...(request.getParam('channel') ? { id: request.getParam('channel') } : {}) }, userId)) }
        else if (operation === 'verify') result = { channel: await verifyTextChannel(project, request.getParam('channel'), userId, dependencies) }
        else if (operation === 'disable') {
          await member(userId, Number(project.workspace_id), ['owner', 'admin'])
          const channel = await loadChannel(project, request.getParam('channel'))
          await query("UPDATE support_channels SET status = 'disabled', updated_at = ? WHERE id = ? AND project_id = ?", [new Date().toISOString(), channel.id, project.id])
          result = { channel: publicChannel(await loadChannel(project, channel.id)) }
        }
        else if (operation === 'reply') result = await createChannelReply(project, request.getParam('conversation'), data, userId, dependencies)
        else if (operation === 'poll') {
          await member(userId, Number(project.workspace_id), ['owner', 'admin'])
          result = await pollDiscordChannel(project, request.getParam('channel'), dependencies)
        }
        else if (operation === 'deliveries') result = { deliveries: (await query('SELECT * FROM support_channel_deliveries WHERE project_id = ? ORDER BY id DESC LIMIT 100', [project.id])).map(deliveryView) }
        else if (operation === 'delivery') result = { delivery: deliveryView(await channelDelivery(project, request.getParam('delivery'))) }
        else if (operation === 'reconcile') {
          await member(userId, Number(project.workspace_id), ['owner', 'admin'])
          result = await reconcileChannelDelivery(project, request.getParam('delivery'), dependencies)
        }
        return Response.json(result, { status: operation === 'save' || operation === 'reply' ? 201 : 200, headers: { 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        if (!(error instanceof SupportError) && process.env.APP_ENV === 'test') console.error(error)
        return Response.json({ error: { code: error instanceof SupportError ? error.code : 'channel_unavailable', message: error instanceof SupportError ? error.message : 'Channel operation is unavailable. Existing operations remain durable.' } }, { status: error instanceof SupportError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
      }
    },
  })
}
