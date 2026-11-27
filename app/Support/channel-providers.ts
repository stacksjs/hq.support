import type { Row } from './database'
import { fail, text } from './errors'
import { object } from './service'
import { channelOptedOut } from './channel-consent'

export interface ChannelDependencies { fetch?: typeof fetch, mediaFetch?: typeof fetch }
export interface ChannelSendOutcome { outcome: 'accepted' | 'rejected' | 'unknown', messageId?: string, error?: string, httpStatus?: number, priceMicros?: number, currency?: string }
export interface ChannelProvider {
  probe(channel: Row, config: Row, dependencies: ChannelDependencies): Promise<{ externalId: string, receipt: string, cursor?: string }>
  validate?(channel: Row, config: Row, thread: Row, payload: Row, dependencies: ChannelDependencies): Promise<void>
  validateMediaSources?(channel: Row, config: Row, record: Row, media: unknown): void | Promise<void>
  ingestMedia?(project: Row, channel: Row, record: Row, conversationId: unknown, payload: Row, dependencies: ChannelDependencies): Promise<unknown>
  estimate(config: Row, payload: Row): number
  send(channel: Row, config: Row, thread: Row, payload: Row, callbackUrl: string, dependencies: ChannelDependencies): Promise<ChannelSendOutcome>
  reconcile?(config: Row, messageId: string, dependencies: ChannelDependencies): Promise<{ status: string, priceMicros?: number, currency?: string, from?: string, to?: string, createdAt?: string }>
}
const extensions = new Map<string, ChannelProvider>()
/** A native provider implementation may register here at server boot; never accepts HTTP-supplied adapters. */
export function registerChannelProvider(provider: string, implementation: ChannelProvider) { extensions.set(provider, implementation) }
export function channelOrigin() {
  let url: URL
  try { url = new URL(process.env.APP_URL || 'https://hq.support') }
  catch { fail(503, 'channel_origin_unavailable', 'Configure the canonical application origin.') }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) fail(503, 'channel_origin_unavailable', 'Channels require the canonical HTTPS application origin.')
  return url.origin
}
export async function providerRead(url: string, authorization: string, dependencies: ChannelDependencies = {}): Promise<Row> {
  const response = await (dependencies.fetch || fetch)(url, { headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok) fail(503, 'provider_probe_failed', `Provider verification returned HTTP ${response.status}.`)
  const data = object(await response.json())
  if (data.ok === false || data.error) fail(403, 'provider_probe_refused', 'The provider refused this account or channel.')
  return data
}
function value(config: Row, field: string, maximum = 1000) { return text(config[field], field, maximum) }
async function twilio(config: Row, dependencies: ChannelDependencies) {
  const { TwilioDriver } = await import('@stacksjs/sms')
  return new TwilioDriver({ accountSid: value(config, 'accountSid', 100), authToken: value(config, 'authToken'), from: value(config, 'fromNumber', 100) }, undefined, { fetch: dependencies.fetch, maxRetries: 0 })
}
function smsCeiling(config: Row, payload: Row) {
  let policies: Row
  try { policies = object(JSON.parse(process.env.SUPPORT_MESSAGING_PRICING || '{}')) }
  catch { fail(503, 'messaging_pricing_unavailable', 'Managed messaging pricing must be configured on the server.') }
  const row = object(policies[String(config.accountSid)]), key = String(payload.provider) === 'whatsapp' ? 'whatsappMaxMicros' : Array.isArray(payload.attachmentIds) && payload.attachmentIds.length ? 'mmsMaxMicros' : 'smsMaxMicrosPerSegment'
  const unit = Number(row[key])
  if (!Number.isSafeInteger(unit) || unit <= 0 || unit > 1000000000) fail(503, 'messaging_pricing_unavailable', 'An exact conservative USD provider ceiling is required.')
  // UCS-2 worst-case segmentation; provider usage and final quoted price are authoritative.
  const segments = key === 'smsMaxMicrosPerSegment' ? (String(payload.body).length <= 70 ? 1 : Math.ceil(String(payload.body).length / 67)) : 1
  const total = unit * segments
  if (!Number.isSafeInteger(total)) fail(422, 'message_too_large', 'Message exceeds the configured provider ceiling.')
  return total
}
const twilioProvider: ChannelProvider = {
  async probe(channel, config, dependencies) {
    const native = await twilio(config, dependencies)
    if (channel.provider === 'whatsapp') {
      if (config.transport !== undefined && config.transport !== 'twilio') fail(422, 'unsupported_whatsapp_transport', 'Managed WhatsApp uses Twilio.')
      const sender = await native.getWhatsAppSender(value(config, 'senderSid', 100))
      if (sender.status !== 'ONLINE' || sender.senderId !== config.fromNumber) fail(403, 'whatsapp_sender_unavailable', 'The exact Twilio WhatsApp sender must be ONLINE.')
      if (sender.callbackUrl !== `${channelOrigin()}/api/channels/${channel.public_id}/incoming`) fail(409, 'provider_routing_required', 'Configure this connection’s incoming webhook in Twilio before verification.')
      return { externalId: sender.sid, receipt: `twilio-whatsapp:${sender.sid}` }
    }
    const { northAmericanNumber, phoneProvider } = await import('./phone-config')
    const from = northAmericanNumber(config.fromNumber)
    if (config.country !== from.country) fail(422, 'number_country_mismatch', 'Number and configured country differ.')
    const adapter = await phoneProvider(channel, config, dependencies)
    const owned = (await adapter.listNumbers(from.number)).find(row => row.phoneNumber === from.number && row.sid === config.phoneNumberSid)
    if (!owned) fail(403, 'number_not_owned', 'This provider account does not own the exact configured number.')
    if (owned.smsUrl !== `${channelOrigin()}/api/channels/${channel.public_id}/incoming` || owned.smsMethod !== 'POST' || owned.smsApplicationSid) fail(409, 'provider_routing_required', 'Configure this connection’s exact POST SMS webhook without an overriding Twilio application before verification.')
    return { externalId: owned.sid, receipt: `owned-sms:${owned.sid}` }
  },
  async validate(channel, config, thread, payload, dependencies) {
    if (await channelOptedOut(channel, String(thread.recipient))) fail(409, 'recipient_opted_out', 'This recipient has opted out.')
    if (channel.provider === 'sms') {
      const { northAmericanNumber } = await import('./phone-config')
      northAmericanNumber(thread.recipient)
      if (String(payload.body).length > 1600) fail(422, 'message_too_large', 'SMS text exceeds the provider limit.')
      if (payload.contentSid) fail(422, 'unsupported_template', 'Content templates are available on WhatsApp connections.')
    }
    if (channel.provider === 'whatsapp') {
      if (!/^whatsapp:\+[1-9]\d{6,14}$/.test(String(thread.recipient))) fail(422, 'invalid_recipient', 'WhatsApp requires an international channel address.')
      if (payload.contentSid) {
        const approval = await (await twilio(config, dependencies)).getContentApproval(text(payload.contentSid, 'contentSid', 100))
        if (approval.status !== 'approved') fail(409, 'template_not_approved', 'WhatsApp requires a currently approved template.')
      }
      else if (Number(thread.last_inbound_at) <= Date.now() - 86400000) fail(409, 'reply_window_closed', 'Use an approved template outside the WhatsApp customer service window.')
    }
  },
  estimate: smsCeiling,
  async send(channel, config, thread, payload, callbackUrl, dependencies) {
    const result = await (await twilio(config, dependencies)).send({ to: String(thread.recipient), body: String(payload.body), statusCallback: callbackUrl,
      ...(Array.isArray(payload.mediaUrls) ? { mediaUrls: payload.mediaUrls.map(String) } : {}),
      ...(payload.contentSid ? { options: { contentSid: payload.contentSid, contentVariables: object(payload.contentVariables) } } : {}) })
    return { outcome: result.outcome || (result.success && result.messageId ? 'accepted' : 'unknown'), messageId: result.messageId, error: result.error, httpStatus: result.httpStatus, priceMicros: result.priceMicros, currency: result.currency }
  },
  async reconcile(config, messageId, dependencies) { return await (await twilio(config, dependencies)).getReceipt(messageId) },
}
const slackProvider: ChannelProvider = {
  async probe(channel, config, dependencies) {
    value(config, 'signingSecret')
    const identity = await providerRead('https://slack.com/api/auth.test', `Bearer ${value(config, 'botToken')}`, dependencies)
    const info = await providerRead(`https://slack.com/api/conversations.info?channel=${encodeURIComponent(value(config, 'channelId', 100))}`, `Bearer ${config.botToken}`, dependencies)
    const room = object(info.channel)
    if (!identity.bot_id || identity.team_id !== config.teamId || room.id !== config.channelId || room.is_archived || !room.is_member) fail(403, 'slack_channel_unavailable', 'The configured bot must belong to this exact team and channel.')
    return { externalId: String(config.channelId), receipt: `slack:${identity.team_id}:${identity.bot_id}` }
  },
  estimate: () => 0,
  async send(channel, config, thread, payload, callbackUrl, dependencies) {
    const { slack } = await import('@stacksjs/chat')
    const driver = new slack.SlackDriver({ botToken: String(config.botToken), maxRetries: 0 }, { fetch: dependencies.fetch })
    const result = await driver.send({ to: String(config.channelId), content: String(payload.body), data: { threadTs: thread.remote_key } })
    return { outcome: result.data?.outcome ?? 'unknown', messageId: result.messageId, error: result.success ? undefined : result.message }
  },
}
const discordProvider: ChannelProvider = {
  async probe(channel, config, dependencies) {
    const identity = await providerRead('https://discord.com/api/v10/users/@me', `Bot ${value(config, 'botToken')}`, dependencies)
    const room = await providerRead(`https://discord.com/api/v10/channels/${value(config, 'channelId', 100)}`, `Bot ${config.botToken}`, dependencies)
    if (!identity.bot || room.id !== config.channelId || ![0, 1, 3, 5, 10, 11, 12].includes(Number(room.type))) fail(403, 'discord_channel_unavailable', 'Use a bot with access to this exact text channel.')
    return { externalId: String(config.channelId), receipt: `discord-bot:${identity.id}`, cursor: String(room.last_message_id || '0') }
  },
  async validate(channel, config, thread) {
    if (channel.external_id !== config.channelId || thread.remote_key !== `${config.channelId}:${thread.recipient}`) fail(409, 'discord_room_mismatch', 'This conversation belongs to a different Discord room.')
  },
  estimate: () => 0,
  async send(channel, config, thread, payload, callbackUrl, dependencies) {
    const { discord } = await import('@stacksjs/chat')
    const result = await new discord.DiscordDriver({ botToken: String(config.botToken), maxRetries: 0 }, { fetch: dependencies.fetch }).send({ to: String(config.channelId), content: String(payload.body), data: { allowedMentions: { parse: [] } } })
    return { outcome: result.data?.outcome ?? 'unknown', messageId: result.messageId, error: result.success ? undefined : result.message }
  },
}
const metaProvider: ChannelProvider = {
  async probe(channel, config, dependencies) {
    value(config, 'appSecret'); value(config, 'verifyToken')
    const { MetaMessagingClient } = await import('@stacksjs/chat')
    const identity = await new MetaMessagingClient({ provider: channel.provider === 'messenger' ? 'messenger' : 'instagram', accountId: value(config, 'accountId', 100), apiVersion: value(config, 'apiVersion', 30), accessToken: value(config, 'accessToken') }, dependencies).identity()
    return { externalId: identity.id, receipt: `meta-account:${identity.id}` }
  },
  async validate(channel, config, thread) { if (Number(thread.last_inbound_at) <= Date.now() - 86400000) fail(409, 'reply_window_closed', 'The standard Meta reply window has closed.') },
  estimate: () => 0,
  async send(channel, config, thread, payload, callbackUrl, dependencies) {
    const { MetaMessagingClient } = await import('@stacksjs/chat')
    return await new MetaMessagingClient({ provider: channel.provider === 'messenger' ? 'messenger' : 'instagram', accountId: String(config.accountId), apiVersion: String(config.apiVersion), accessToken: String(config.accessToken) }, dependencies).sendText(String(thread.recipient), String(payload.body))
  },
}
const nativeTextProviders: Record<string, ChannelProvider> = { sms: twilioProvider, whatsapp: twilioProvider, slack: slackProvider, discord: discordProvider, messenger: metaProvider, instagram: metaProvider }

export function textProvider(provider: string): ChannelProvider {
  const native = extensions.get(provider) || nativeTextProviders[provider]
  if (!native) fail(503, 'channel_unavailable', 'This channel has no configured native delivery adapter.')
  return native
}

export function channelReceiptProviders() {
  const providers = new Set([...Object.keys(nativeTextProviders), ...extensions.keys()])
  return [...providers].filter(provider => textProvider(provider).reconcile !== undefined)
}
