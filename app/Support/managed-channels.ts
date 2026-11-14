import { bindChannelConversation, conversationChannelThread, deliveryChannelThread } from './channel-history'
import { storeJob } from '@stacksjs/queue/utils'
import type { ChannelDependencies, ChannelSendOutcome } from './channel-providers'
import type { Row } from './database'
import { channelConfig, loadChannel, markChannelReady, publicChannel, requireReadyChannel } from './channels'
import { channelOrigin, textProvider } from './channel-providers'
import { shareAttachments } from './attachments'
import { ingestProviderMedia, outboundMediaUrls, providerMediaSources, validateOutboundMedia } from './channel-media'
import { managedCostFromMicros, reserveWallet, settleProviderWallet, settleWallet } from './billing'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { contact, conversation, createConversation, digest, idempotent, member, object, reply, secret } from './service'
import { processInbound, receiveInbound } from './delivery'

export function deliveryView(row: Row) {
  return { id: String(row.public_id), channelId: String(row.channel_id), threadId: String(row.thread_id), ...(row.conversation_id ? { conversationId: String(row.conversation_id) } : {}), messageId: String(row.message_id), status: String(row.status), providerMessageId: String(row.provider_message_id), reservedCents: Number(row.reserved_cents), providerCostMicros: ['settled', 'delivered'].includes(String(row.status)) ? Number(row.provider_cost_micros) : null, currency: String(row.provider_currency), lastError: String(row.last_error) }
}
export async function verifyTextChannel(project: Row, id: unknown, userId: number, dependencies: ChannelDependencies = {}) {
  await member(userId, Number(project.workspace_id), ['owner', 'admin'])
  const row = await loadChannel(project, id), config = await channelConfig(row)
  const evidence = await textProvider(String(row.provider)).probe(row, config, dependencies)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), ['owner', 'admin'])
    const ready = await markChannelReady(project, row.id, { ...evidence, expectedConfiguration: String(row.configuration) })
    if (row.provider === 'discord' && !await one('SELECT id FROM support_channel_cursors WHERE channel_id = ?', [row.id])) await insert('support_channel_cursors', { workspace_id: project.workspace_id, project_id: project.id, channel_id: row.id, cursor: evidence.cursor || '0' })
    return publicChannel(ready)
  })
}
function cleanPayload(provider: string, input: Row): Row {
  const maximum = provider === 'discord' ? 2000 : ['messenger', 'instagram'].includes(provider) ? 1000 : ['slack', 'email'].includes(provider) ? 20000 : 1600
  const attachmentIds = Array.isArray(input.attachmentIds) ? input.attachmentIds.map(value => String(identifier(value))) : []
  if (input.attachmentIds !== undefined && (!Array.isArray(input.attachmentIds) || !attachmentIds.length || attachmentIds.length > 1)) fail(422, 'invalid_media_selection', 'Select one stored image attachment.')
  const body = attachmentIds.length && (input.body === '' || input.body === undefined) ? '' : text(input.body, 'body', maximum)
  if (input.mediaUrls || input.attachments) fail(422, 'private_attachment_required', 'Use scoped stored attachmentIds, not arbitrary provider fetch URLs.')
  if (input.contentSid && provider !== 'whatsapp') fail(422, 'unsupported_template', 'Content templates require a Twilio WhatsApp connection.')
  const variables = Object.fromEntries(Object.entries(object(input.contentVariables)).sort(([left], [right]) => left.localeCompare(right)))
  if (Object.entries(variables).some(([key, value]) => !/^\d+$/.test(key) || typeof value !== 'string' || value.length > 1600) || JSON.stringify(variables).length > 10000) fail(422, 'invalid_template_variables', 'Template substitutions must be numbered bounded strings.')
  return { body, provider, ...(attachmentIds.length ? { attachmentIds } : {}), ...(input.contentSid ? { contentSid: text(input.contentSid, 'contentSid', 100), contentVariables: variables } : {}) }
}
/** The normal inbox reply path calls this for a channel-backed conversation. */
export async function createChannelReply(project: Row, conversationId: unknown, input: Row, userId: number, dependencies: ChannelDependencies = {}) {
  await member(userId, Number(project.workspace_id))
  const thread = await conversationChannelThread(project, conversationId)
  if (!thread || input.visibility === 'internal') return await reply(project, conversationId, input, { userId })
  if (input.visibility && input.visibility !== 'public') fail(422, 'invalid_visibility', 'Channel replies must be public.')
  const channel = await requireReadyChannel(project, thread.channel_id), config = await channelConfig(channel), provider = textProvider(String(channel.provider))
  const key = text(input.idempotencyKey, 'idempotencyKey', 200), payload = cleanPayload(String(channel.provider), input)
  const fingerprint = digest(JSON.stringify({ channel: channel.id, thread: thread.id, payload })), configurationHash = digest(String(channel.configuration))
  const previous = await one('SELECT * FROM support_channel_deliveries WHERE project_id = ? AND operation_key = ?', [project.id, key])
  if (previous) {
    if (previous.request_hash !== fingerprint) fail(409, 'idempotency_conflict', 'Channel operation input changed.')
    const message = await one('SELECT * FROM support_messages WHERE id = ? AND project_id = ?', [previous.message_id, project.id])
    return { message: { id: String(message!.id), conversation_id: String(conversationId), body: message!.body, visibility: 'public', delivery_status: message!.delivery_status }, delivery: deliveryView(previous) }
  }
  await validateOutboundMedia(project, conversationId, String(channel.provider), payload)
  await provider.validate?.(channel, config, thread, payload, dependencies)
  const providerCeiling = provider.estimate(config, payload), maximumCents = managedCostFromMicros(providerCeiling)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id))
    const current = await requireReadyChannel(project, channel.id)
    if (digest(String(current.configuration)) !== configurationHash) fail(409, 'channel_changed', 'Connection changed while preparing the reply.')
    const existing = await one('SELECT * FROM support_channel_deliveries WHERE project_id = ? AND operation_key = ?', [project.id, key])
    if (existing) {
      if (existing.request_hash !== fingerprint) fail(409, 'idempotency_conflict', 'Channel operation input changed.')
      return { delivery: deliveryView(existing), message: { id: String(existing.message_id), conversation_id: String(conversationId), body: payload.body, visibility: 'public' } }
    }
    const publicId = crypto.randomUUID()
    const reservation = maximumCents ? await reserveWallet(Number(project.workspace_id), `channel:${publicId}`, maximumCents, String(channel.provider)) : undefined
    const result = await reply(project, conversationId, { body: payload.body, visibility: 'public', idempotencyKey: `channel:${publicId}` }, { userId, deferDelivery: true, mediaOnly: Boolean(Array.isArray(payload.attachmentIds) && payload.attachmentIds.length) })
    const row = await insert('support_channel_deliveries', { workspace_id: project.workspace_id, project_id: project.id, channel_id: channel.id, thread_id: thread.id, message_id: result.message.id, public_id: publicId, payload: JSON.stringify({ ...payload, _configuration: channel.configuration }), operation_key: key, request_hash: fingerprint, configuration_hash: configurationHash, wallet_reservation_id: reservation?.public_id || '', reserved_cents: maximumCents, status: 'pending', available_at: Date.now() })
    await query("UPDATE support_messages SET delivery_status = 'pending' WHERE id = ?", [result.message.id])
    await storeJob('RunChannelDelivery', { queue: 'support-channels', payload: { deliveryId: row.id }, maxTries: 3, timeout: 60 })
    return { ...result, message: { ...result.message, delivery_status: 'pending' }, delivery: deliveryView(row) }
  })
}
export async function channelDelivery(project: Row, id: unknown): Promise<Row> {
  const row = await one('SELECT * FROM support_channel_deliveries WHERE project_id = ? AND workspace_id = ? AND public_id = ?', [project.id, project.workspace_id, text(id, 'delivery ID', 100)])
  if (!row) fail(404, 'delivery_not_found', 'Channel delivery not found.')
  return row
}
async function writeOutcome(row: Row, outcome: ChannelSendOutcome) {
  return await workspaceTransaction(Number(row.workspace_id), async () => {
    const current = await one('SELECT * FROM support_channel_deliveries WHERE id = ?', [row.id])
    if (!current || current.lease_token !== row.lease_token || current.status !== 'dispatching') return
    const knownAcceptance = outcome.outcome === 'accepted' && outcome.messageId
    if (knownAcceptance) {
      const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [row.project_id, row.workspace_id]))!
      const thread = await deliveryChannelThread(project, current)
      const payload = object(JSON.parse(String(current.payload)))
      await shareAttachments(project, thread.conversation_id, payload.attachmentIds)
      await (await import('./ticket-sla')).recordTicketFirstResponse(project, thread.conversation_id)
    }
    const status = knownAcceptance ? (current.wallet_reservation_id ? 'cost_pending' : 'accepted') : outcome.outcome === 'rejected' ? 'rejected' : 'unknown'
    if (status === 'rejected' && current.wallet_reservation_id) await settleWallet(Number(row.workspace_id), String(current.wallet_reservation_id), 0, `rejected:${row.public_id}`)
    await query('UPDATE support_channel_deliveries SET status = ?, provider_message_id = ?, lease_until = 0, last_error = ?, receipt = ?, updated_at = ? WHERE id = ?', [status, knownAcceptance ? outcome.messageId : '', (outcome.error || '').slice(0, 1000), JSON.stringify({ outcome: outcome.outcome, httpStatus: outcome.httpStatus }), new Date().toISOString(), row.id])
    await query('UPDATE support_messages SET delivery_status = ? WHERE id = ?', [status, row.message_id])
  })
}
/** Commit dispatch ownership before HTTP. A crashed dispatch becomes unknown, never an automatic resend. */
export async function dispatchChannelDelivery(id: number, dependencies: ChannelDependencies = {}) {
  const original = await one('SELECT * FROM support_channel_deliveries WHERE id = ?', [id])
  if (!original) return { dispatched: false }
  const row: Row | null = await workspaceTransaction(Number(original.workspace_id), async () => {
    const current = await one('SELECT * FROM support_channel_deliveries WHERE id = ?', [id])
    if (!current) return null
    if (current.status === 'dispatching' && Number(current.lease_until) <= Date.now()) {
      await query("UPDATE support_channel_deliveries SET status = 'unknown', lease_until = 0, last_error = 'Worker stopped during provider dispatch; reconcile before any resend.' WHERE id = ?", [id])
      await query("UPDATE support_messages SET delivery_status = 'unknown' WHERE id = ?", [current.message_id])
      return null
    }
    if (current.status !== 'pending' || Number(current.available_at) > Date.now() || Number(current.lease_until) > Date.now()) return null
    const lease = secret()
    await query("UPDATE support_channel_deliveries SET status = 'dispatching', lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", [lease, Date.now() + 60000, new Date().toISOString(), id])
    return { ...current, lease_token: lease }
  })
  if (!row) return { dispatched: false }
  const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [row.project_id, row.workspace_id]))!
  let channel: Row, config: Row, thread: Row, payload: Row
  try {
    channel = await requireReadyChannel(project, row.channel_id)
    if (digest(String(channel.configuration)) !== row.configuration_hash) fail(409, 'channel_changed', 'Channel credentials changed before dispatch.')
    config = await channelConfig(channel)
    thread = await deliveryChannelThread(project, row)
    if (!thread) fail(404, 'channel_thread_not_found', 'Channel thread no longer exists.')
    payload = object(JSON.parse(String(row.payload)))
    await validateOutboundMedia(project, thread.conversation_id, String(channel.provider), payload)
    await textProvider(String(channel.provider)).validate?.(channel, config, thread, payload, dependencies)
  }
  catch {
    await writeOutcome(row, { outcome: 'rejected', error: 'Connection or recipient policy changed before dispatch. No provider send attempted.' })
    return { dispatched: false }
  }
  let outcome: ChannelSendOutcome
  try { outcome = await textProvider(String(channel.provider)).send(channel, config, thread, { ...payload, mediaUrls: await outboundMediaUrls(row, payload) }, `${channelOrigin()}/api/channels/${channel.public_id}/deliveries/${row.public_id}/status`, dependencies) }
  catch { outcome = { outcome: 'unknown', error: 'Provider acknowledgement unavailable. Reconcile before any resend.' } }
  await writeOutcome(row, outcome)
  if (outcome.outcome === 'accepted' && outcome.messageId) await reconcileChannelDelivery(project, row.public_id, dependencies).catch(() => undefined)
  return { dispatched: true, outcome: outcome.outcome }
}
/** Original credentials remain encrypted in the durable operation for callback/cost reconciliation after rotation. */
export async function deliveryCredentials(delivery: Row, channel: Row) {
  const payload = object(JSON.parse(String(delivery.payload)))
  return await channelConfig({ ...channel, configuration: payload._configuration || channel.configuration })
}
export async function reconcileChannelDelivery(project: Row, id: unknown, dependencies: ChannelDependencies = {}) {
  const row = await channelDelivery(project, id), channel = await loadChannel(project, row.channel_id), provider = textProvider(String(channel.provider))
  if (!row.provider_message_id) fail(409, 'delivery_unacknowledged', 'Await a signed provider callback identifying this exact operation. A send will not be repeated.')
  if (!provider.reconcile) return { delivery: deliveryView(row) }
  const credentials = await deliveryCredentials(row, channel)
  const receipt = await provider.reconcile(credentials, String(row.provider_message_id), dependencies)
  if (['sms', 'whatsapp'].includes(String(channel.provider))) {
    const thread = (await one('SELECT recipient FROM support_channel_threads WHERE id = ? AND project_id = ?', [row.thread_id, project.id]))!
    if (receipt.from !== credentials.fromNumber || receipt.to !== thread.recipient) fail(409, 'provider_receipt_mismatch', 'Provider receipt sender/recipient differs from this exact operation.')
  }
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const current = await channelDelivery(project, id)
    if (['queued', 'sending', 'sent', 'delivered', 'read'].includes(receipt.status)) {
      const thread = await deliveryChannelThread(project, current)
      const payload = object(JSON.parse(String(current.payload)))
      await shareAttachments(project, thread.conversation_id, payload.attachmentIds)
      await (await import('./ticket-sla')).recordTicketFirstResponse(project, thread.conversation_id)
    }
    let status = String(current.status)
    if (current.wallet_reservation_id && receipt.priceMicros !== undefined) {
      if (receipt.currency?.toUpperCase() !== 'USD') fail(409, 'unsupported_billing_currency', 'Managed channel settlement requires a verified USD provider price.')
      await settleProviderWallet(Number(project.workspace_id), String(current.wallet_reservation_id), receipt.priceMicros, String(current.provider_message_id))
      status = 'settled'
    }
    if (['delivered', 'read'].includes(receipt.status)) status = current.wallet_reservation_id && status !== 'settled' ? 'cost_pending' : 'delivered'
    if (['failed', 'undelivered'].includes(receipt.status) && (!current.wallet_reservation_id || status === 'settled')) status = 'failed'
    await query('UPDATE support_channel_deliveries SET status = ?, provider_cost_micros = ?, provider_currency = ?, receipt = ?, updated_at = ? WHERE id = ?', [status, receipt.priceMicros ?? current.provider_cost_micros, receipt.currency || current.provider_currency, JSON.stringify({ status: receipt.status, priceMicros: receipt.priceMicros, currency: receipt.currency }), new Date().toISOString(), current.id])
    await query('UPDATE support_messages SET delivery_status = ? WHERE id = ?', [status, current.message_id])
    return { delivery: deliveryView((await channelDelivery(project, id))) }
  })
}
/** Normalized events enter only after a native signature or authenticated provider poll. */
export async function retainChannelInbound(project: Row, channel: Row, eventId: string, normalized: Row, provenance: Row) {
  const stored = await receiveInbound(project, `channel:${channel.id}`, eventId, { channelId: channel.id, normalized, provenance, _configuration: channel.configuration })
  if (!stored.duplicate) await storeJob('RunChannelDelivery', { queue: 'support-channels', payload: { inboundId: Number(stored.id) }, maxTries: 3, timeout: 60 })
  return stored
}
export async function applyChannelInbound(id: unknown, dependencies: ChannelDependencies = {}) {
  return await processInbound(id, async record => {
    const payload = object(JSON.parse(String(record.payload))), normalized = object(payload.normalized)
    const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [record.project_id, record.workspace_id]))!
    const channel = await loadChannel(project, payload.channelId)
    if (normalized.mediaOverflow) fail(422, 'inbound_media_bound', 'Provider media count exceeds ingestion bounds; original source retained.')
    const mediaOnly = normalized.body === '' && Array.isArray(normalized.media) && normalized.media.length > 0
    const body = mediaOnly ? '' : text(normalized.body, 'provider message text', 20000), remote = text(normalized.remoteKey, 'provider thread', 200), sender = text(normalized.sender, 'provider sender', 200)
    if (!Number.isSafeInteger(Number(normalized.timestamp)) || Number(normalized.timestamp) < 0 || Number(normalized.timestamp) > Date.now() + 60000) fail(422, 'invalid_provider_timestamp', 'Provider timestamp is invalid.')
    const adapter = textProvider(String(channel.provider))
    if (Array.isArray(normalized.media) && normalized.media.length) {
      const credentials = await channelConfig({ ...channel, configuration: payload._configuration || channel.configuration })
      if (adapter.validateMediaSources) await adapter.validateMediaSources(channel, credentials, record, normalized.media)
      else providerMediaSources(channel, credentials, record, normalized.media)
    }
    // SQL admission is committed once before filesystem work. Its saved result
    // lets a restarted worker resume media without duplicating the first message.
    const applied = await idempotent(project, 'channel-inbound-application', String(record.id), normalized, async () => {
      const current = await one('SELECT * FROM support_inbound WHERE id = ?', [record.id])
      if (!current || current.status !== 'processing' || current.lease_token !== record.lease_token || Number(current.lease_until) <= Date.now()) fail(409, 'inbound_lease_changed', 'Inbound ownership changed.')
      let thread = await one('SELECT * FROM support_channel_threads WHERE channel_id = ? AND project_id = ? AND remote_key = ?', [channel.id, project.id, remote])
      let externalId = `channel:${channel.public_id}:${digest(sender)}`
      if (channel.provider === 'email' && normalized.contactExternalId !== undefined) {
        externalId = text(normalized.contactExternalId, 'email provider identity', 255)
        if (!externalId.startsWith(`email:${channel.public_id}:`)) fail(422, 'invalid_email_identity', 'Email source identity must belong to this exact channel.')
      }
      const who = await contact(project, { externalId, name: typeof normalized.name === 'string' ? normalized.name.slice(0, 100) : sender })
      const input = { body, idempotencyKey: `channel-inbound:${record.id}` }
      let messageId: unknown
      if (!thread) {
        const result = await createConversation(project, { externalId: who.external_id }, { ...input, subject: typeof normalized.subject === 'string' && normalized.subject.trim().length > 0 && normalized.subject.length <= 200 ? normalized.subject : `${channel.provider} support` }, who, undefined, { mediaOnly })
        await query('UPDATE support_conversations SET channel = ? WHERE id = ? AND project_id = ?', [channel.provider, result.conversation.id, project.id])
        thread = await insert('support_channel_threads', { workspace_id: project.workspace_id, project_id: project.id, channel_id: channel.id, remote_key: remote, recipient: sender, contact_id: who.id, conversation_id: result.conversation.id, last_inbound_at: Number(normalized.timestamp) })
        messageId = (await one('SELECT id FROM support_messages WHERE conversation_id = ? AND project_id = ? ORDER BY id ASC LIMIT 1', [thread.conversation_id, project.id]))!.id
      }
      else {
        if (String(thread.contact_id) !== String(who.id)) fail(409, 'channel_thread_identity', 'Provider thread has a different customer identity; source event retained for review.')
        await conversation(project, thread.conversation_id, who)
        await bindChannelConversation(project, thread, thread.conversation_id)
        const acceptedAt = record.created_at == null ? undefined : record.created_at instanceof Date ? record.created_at.getTime() : new Date(String(record.created_at)).getTime()
        const response = await reply(project, thread.conversation_id, input, { customer: who, mediaOnly, acceptedAt })
        messageId = response.message.id
        const destination = response.message.conversation_id
        await bindChannelConversation(project, thread, destination)
        await query('UPDATE support_channel_threads SET conversation_id = ?, last_inbound_at = ?, updated_at = ? WHERE id = ?', [destination, Math.max(Number(thread.last_inbound_at), Number(normalized.timestamp)), new Date().toISOString(), thread.id])
        thread = { ...thread, conversation_id: destination }
      }
      await bindChannelConversation(project, thread, thread.conversation_id)
      if (Array.isArray(normalized.media) && normalized.media.length) await query("UPDATE support_messages SET delivery_status = 'ingesting' WHERE id = ?", [messageId])
      return { conversationId: thread.conversation_id, messageId }
    })
    if (adapter.ingestMedia) await adapter.ingestMedia(project, channel, record, applied.conversationId, payload, dependencies)
    else await ingestProviderMedia(project, channel, record, applied.conversationId, payload, dependencies)
    await workspaceTransaction(Number(project.workspace_id), async () => {
      const current = await one('SELECT * FROM support_inbound WHERE id = ?', [record.id])
      if (!current || current.status !== 'processing' || current.lease_token !== record.lease_token || Number(current.lease_until) <= Date.now()) fail(409, 'inbound_lease_changed', 'Inbound ownership changed during media ingestion.')
      await query("UPDATE support_messages SET delivery_status = 'stored' WHERE id = ? AND delivery_status = 'ingesting'", [applied.messageId])
      await query("UPDATE support_inbound SET status = 'processed', last_error = '', updated_at = ? WHERE id = ? AND lease_token = ?", [new Date().toISOString(), record.id, record.lease_token])
    })
  })
}
export async function recoverChannelWork(dependencies: ChannelDependencies = {}) {
  const rows = await query("SELECT id FROM support_channel_deliveries WHERE status IN ('pending', 'dispatching', 'cost_pending') AND lease_until <= ? ORDER BY id LIMIT 100", [Date.now()])
  for (const row of rows) {
    const delivery = (await one('SELECT * FROM support_channel_deliveries WHERE id = ?', [row.id]))!
    if (delivery.status === 'cost_pending') {
      const project = (await one('SELECT * FROM support_projects WHERE id = ?', [delivery.project_id]))!
      await reconcileChannelDelivery(project, delivery.public_id, dependencies).catch(() => undefined)
    }
    else await dispatchChannelDelivery(Number(row.id), dependencies)
  }
  const incoming = await query("SELECT id FROM support_inbound WHERE provider LIKE 'channel:%' AND status <> 'processed' AND lease_until <= ? AND available_at <= ? ORDER BY id LIMIT 100", [Date.now(), Date.now()])
  for (const row of incoming) await applyChannelInbound(row.id, dependencies)
  return { deliveries: rows.length, inbound: incoming.length }
}

/** Native bot inbox pagination, with every page retained before advancing the durable cursor. */
export async function pollDiscordChannel(project: Row, channelId: unknown, dependencies: ChannelDependencies = {}) {
  const channel = await requireReadyChannel(project, channelId, 'discord'), config = await channelConfig(channel)
  const claimed: Row | null = await workspaceTransaction(Number(project.workspace_id), async () => {
    const cursor = await one('SELECT * FROM support_channel_cursors WHERE channel_id = ? AND project_id = ?', [channel.id, project.id])
    if (!cursor || Number(cursor.lease_until) > Date.now()) return null
    const token = secret()
    await query('UPDATE support_channel_cursors SET lease_token = ?, lease_until = ? WHERE id = ?', [token, Date.now() + 60000, cursor.id])
    return { ...cursor, lease_token: token }
  })
  if (!claimed) return { polled: false }
  const { inbox } = await import('@stacksjs/chat')
  const botId = /^discord-bot:(\d+)$/.exec(String(object(config._verification).receipt))?.[1]
  if (!botId) fail(409, 'discord_identity_unavailable', 'Verify the Discord bot identity again before polling.')
  const driver = new inbox.DiscordInboxDriver({ token: String(config.botToken), account: 'bot', userId: botId, fetch: dependencies.fetch })
  const messages = await driver.messages(String(config.channelId), { after: String(claimed.cursor), limit: 100 })
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const current = await one('SELECT * FROM support_channel_cursors WHERE id = ?', [claimed.id])
    const fresh = await requireReadyChannel(project, channel.id, 'discord')
    if (!current || current.lease_token !== claimed.lease_token || Number(current.lease_until) <= Date.now() || fresh.configuration !== channel.configuration) fail(409, 'poll_lease_changed', 'Discord poll ownership or credentials changed.')
    let newest = BigInt(String(claimed.cursor)), retained = 0
    for (const message of messages) {
      if (/^\d+$/.test(message.cursor) && BigInt(message.cursor) > newest) newest = BigInt(message.cursor)
      if (message.kind !== 'message' || !message.sender || message.fromMe) continue
      await retainChannelInbound(project, channel, message.id, { sender: message.sender.id, name: message.sender.name, remoteKey: `${config.channelId}:${message.sender.id}`, body: message.text || '', timestamp: message.sentAt, media: message.attachments }, { message })
      retained++
    }
    await query('UPDATE support_channel_cursors SET cursor = ?, lease_until = 0, updated_at = ? WHERE id = ? AND lease_token = ?', [String(newest), new Date().toISOString(), claimed.id, claimed.lease_token])
    return { polled: true, retained, cursor: String(newest) }
  })
}
