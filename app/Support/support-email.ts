import { createHmac, timingSafeEqual } from 'node:crypto'
import { AWSClient } from '@stacksjs/ts-cloud/aws'
import type { AWSRequestOptions } from '@stacksjs/ts-cloud/aws'
import { isSuppressed } from '@stacksjs/email/suppression'
import { buildMimeMessage } from '@stacksjs/email/mime'
import type { ChannelProvider } from './channel-providers'
import type { Row } from './database'
import { fail } from './errors'
import { object } from './service'
import { one } from './database'
import { registerChannelProvider } from './channel-providers'

export interface EmailDependencies { awsRequest?: (options: AWSRequestOptions) => Promise<unknown>, fetchCert?: (url: string) => Promise<string> }
export interface EmailPolicy { workspaceId: number, region: string, accountId: string, topicArn: string, bucket: string, prefix: string, fromAddresses: string[], inboundAddresses: string[], replyDomain: string, maxMicrosPerMessage: number, outbound?: { configurationSet: string, topicArn: string } }
export function sesBillingScope(policy: EmailPolicy) {
  if (!policy.outbound) return undefined
  return { version: 1, accountId: policy.accountId, region: policy.region, configurationSet: policy.outbound.configurationSet, topicArn: policy.outbound.topicArn }
}
export function matchesSesBillingScope(recorded: unknown, scope: ReturnType<typeof sesBillingScope>): boolean {
  if (!scope) return false
  const candidate = object(recorded)
  return Object.entries(scope).every(([key, value]) => candidate[key] === value)
}
export function emailAddress(input: unknown): string {
  const value = String(input || '').trim().toLowerCase()
  if (value.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(value) || value.includes('..') || value.split('@')[0]!.length > 64) fail(422, 'email_address_invalid', 'Use one canonical email address without display names.')
  return value
}
export function emailPolicy(channel: Row, config: Row): EmailPolicy {
  let all: Row
  try { all = object(JSON.parse(process.env.SUPPORT_EMAIL_POLICIES || '{}')) } catch { fail(503, 'email_unconfigured', 'Configure operator email policies.') }
  const value = object(all[String(channel.workspace_id)]), region = String(value.region || ''), accountId = String(value.accountId || ''), topicArn = String(value.topicArn || ''), bucket = String(value.bucket || ''), prefix = String(value.prefix || ''), replyDomain = String(value.replyDomain || '')
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region) || !/^\d{12}$/.test(accountId) || !topicArn.startsWith(`arn:aws:sns:${region}:${accountId}:`) || !/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(topicArn) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-zA-Z0-9/_-]{1,150}\/$/.test(prefix) || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}$/.test(replyDomain)) fail(503, 'email_unconfigured', 'Configure the exact operator SES/SNS/S3 account, region, private prefix and reply domain.')
  const configurationSet = String(value.configurationSet || ''), outboundTopicArn = String(value.outboundTopicArn || '')
  const outbound = configurationSet || outboundTopicArn ? { configurationSet, topicArn: outboundTopicArn } : undefined
  if (outbound && (!/^[A-Za-z0-9_-]{1,64}$/.test(configurationSet) || !outboundTopicArn.startsWith(`arn:aws:sns:${region}:${accountId}:`) || !/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(outboundTopicArn) || outboundTopicArn === topicArn)) fail(503, 'email_unconfigured', 'Configure an SES configuration set and a separate outbound SNS topic in the same AWS account and region.')
  const fromAddresses = Array.isArray(value.fromAddresses) ? value.fromAddresses.map(emailAddress) : [], inboundAddresses = Array.isArray(value.inboundAddresses) ? value.inboundAddresses.map(emailAddress) : []
  const maxMicrosPerMessage = Number(value.maxMicrosPerMessage)
  if (!fromAddresses.length || !inboundAddresses.length || !Number.isSafeInteger(maxMicrosPerMessage) || maxMicrosPerMessage <= 0 || maxMicrosPerMessage > 1000000000 || !String(value.rateVersion || '').trim() || (process.env.SUPPORT_EMAIL_REPLY_KEY || '').length < 32) fail(503, 'email_unconfigured', 'Configure scoped sender/recipient addresses, a versioned maximum USD reserve and reply signing key.')
  for (const [workspace, policy] of Object.entries(all)) {
    if (workspace === String(channel.workspace_id)) continue
    const row = object(policy)
    if ([...fromAddresses, ...inboundAddresses].some(address => [...(Array.isArray(row.fromAddresses) ? row.fromAddresses : []), ...(Array.isArray(row.inboundAddresses) ? row.inboundAddresses : [])].map(item => String(item).toLowerCase()).includes(address))) fail(503, 'email_policy_overlap', 'Operator email addresses must belong to one workspace.')
  }
  if (!fromAddresses.includes(emailAddress(config.fromAddress)) || !inboundAddresses.includes(emailAddress(config.inboundAddress))) fail(403, 'email_identity_not_owned', 'This workspace is not authorized for these exact email identities.')
  return { workspaceId: Number(channel.workspace_id), region, accountId, topicArn, bucket, prefix, fromAddresses, inboundAddresses, replyDomain, maxMicrosPerMessage, outbound }
}
export async function emailAws(options: AWSRequestOptions, dependencies: EmailDependencies = {}): Promise<Row> {
  if (dependencies.awsRequest) return await dependencies.awsRequest(options) as Row
  const accessKeyId = process.env.SUPPORT_EMAIL_AWS_ACCESS_KEY_ID, secretAccessKey = process.env.SUPPORT_EMAIL_AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) fail(503, 'email_unconfigured', 'Configure explicit server email AWS credentials.')
  return await new AWSClient({ accessKeyId, secretAccessKey, ...(process.env.SUPPORT_EMAIL_AWS_SESSION_TOKEN ? { sessionToken: process.env.SUPPORT_EMAIL_AWS_SESSION_TOKEN } : {}) }, { maxRetries: 0 }).request({ ...options, retries: 0, timeoutMs: 15000 })
}
export async function emailPrivateBucket(bucket: string, region: string, dependencies: EmailDependencies = {}): Promise<void> {
  const privacy = await emailAws({ service: 's3', region, bucket, method: 'GET', path: '/', queryParams: { publicAccessBlock: '' }, retries: 0, timeoutMs: 15000 }, dependencies)
  const block = object(privacy.PublicAccessBlockConfiguration ?? privacy)
  if (!['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].every(key => block[key] === true || block[key] === 'true')) fail(403, 'email_storage_not_private', 'Email bucket must enforce all S3 public-access blocks.')
}
function replyTag(channel: Row, thread: Row, expiry: string): string {
  const key = process.env.SUPPORT_EMAIL_REPLY_KEY || ''
  if (key.length < 32) fail(503, 'email_unconfigured', 'Configure the server email reply key.')
  return createHmac('sha256', key).update(JSON.stringify([String(channel.workspace_id), String(channel.project_id), String(channel.id), String(thread.id), emailAddress(thread.recipient), expiry])).digest('hex').slice(0, 32)
}
export function emailReplyAddress(channel: Row, config: Row, thread: Row, at = Date.now()): string {
  const policy = emailPolicy(channel, config), expiry = Math.floor((at + 30 * 86400000) / 1000).toString(36)
  return `r+${Number(thread.id).toString(36)}.${expiry}.${replyTag(channel, thread, expiry)}@${policy.replyDomain}`
}
export async function emailReplyThread(channel: Row, config: Row, address: string, sender: string): Promise<Row> {
  const policy = emailPolicy(channel, config), match = /^r\+([a-z0-9]+)\.([a-z0-9]+)\.([a-f0-9]{32})@(.+)$/.exec(address)
  if (!match || match[4] !== policy.replyDomain || parseInt(match[2]!, 36) * 1000 < Date.now() || parseInt(match[2]!, 36) * 1000 > Date.now() + 31 * 86400000) fail(403, 'email_reply_invalid', 'Reply capability is invalid or expired.')
  const thread = await one('SELECT * FROM support_channel_threads WHERE id = ? AND channel_id = ? AND project_id = ? AND workspace_id = ?', [parseInt(match[1]!, 36), channel.id, channel.project_id, channel.workspace_id])
  if (!thread || emailAddress(thread.recipient) !== sender || !timingSafeEqual(Buffer.from(match[3]!), Buffer.from(replyTag(channel, thread, match[2]!)))) fail(403, 'email_reply_invalid', 'Reply capability does not authorize this sender and thread.')
  return thread
}
export const emailDispatchTagName = 'hq-dispatch'
const deliveryIdPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
function emailDispatchTag(channel: Row, deliveryId: string, recipient: string): string {
  const signature = createHmac('sha256', process.env.SUPPORT_EMAIL_REPLY_KEY!)
    .update(JSON.stringify(['delivery', String(channel.workspace_id), String(channel.project_id), String(channel.id), deliveryId, recipient]))
    .digest('hex').slice(0, 32)
  return `${deliveryId}_${signature}`
}
export function emailDispatchId(channel: Row, tag: unknown, recipient: string): string {
  const match = typeof tag === 'string' && new RegExp(`^(${deliveryIdPattern})_[a-f0-9]{32}$`).exec(tag)
  if (!match || !timingSafeEqual(Buffer.from(match[0]), Buffer.from(emailDispatchTag(channel, match[1]!, recipient)))) fail(403, 'email_dispatch_mismatch', 'SES send evidence does not authorize this delivery.')
  return match[1]!
}
export function supportEmailProvider(dependencies: EmailDependencies = {}): ChannelProvider {
  return {
    async probe(channel, config) {
      const policy = emailPolicy(channel, config)
      await one('SELECT id FROM email_suppressions LIMIT 1')
      const account = await emailAws({ service: 'sts', region: policy.region, method: 'POST', path: '/', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ Action: 'GetCallerIdentity', Version: '2011-06-15' }).toString(), retries: 0, timeoutMs: 15000 }, dependencies)
      const identityAccount = object(object(account.GetCallerIdentityResponse).GetCallerIdentityResult).Account ?? object(account.GetCallerIdentityResult).Account
      if (String(identityAccount) !== policy.accountId) fail(403, 'email_account_mismatch', 'Server credentials do not belong to the configured email AWS account.')
      const identity = await emailAws({ service: 'ses', region: policy.region, method: 'GET', path: `/v2/email/identities/${encodeURIComponent(emailAddress(config.fromAddress).split('@')[1]!)}`, retries: 0, timeoutMs: 15000 }, dependencies)
      const dkim = object(identity.DkimAttributes)
      if (identity.VerificationStatus !== 'SUCCESS' || !(identity.SendingEnabled === true || identity.VerifiedForSendingStatus === true) || dkim.SigningEnabled !== true || dkim.Status !== 'SUCCESS') fail(403, 'email_identity_unverified', 'SES domain identity must be verified for sending with successful DKIM.')
      if (policy.outbound) {
        const { configurationSet, topicArn } = policy.outbound
        const result = await emailAws({ service: 'ses', region: policy.region, method: 'GET', path: `/v2/email/configuration-sets/${configurationSet}/event-destinations`, retries: 0, timeoutMs: 15000 }, dependencies)
        const destinations = Array.isArray(result.EventDestinations) ? result.EventDestinations.map(object) : []
        if (!destinations.some(destination => destination.Enabled === true && Array.isArray(destination.MatchingEventTypes) && destination.MatchingEventTypes.includes('SEND') && object(destination.SnsDestination).TopicArn === topicArn)) fail(403, 'email_send_destination_unverified', 'Enable SEND events for the exact outbound SNS topic in this SES configuration set.')
      }
      await emailPrivateBucket(policy.bucket, policy.region, dependencies)
      return { externalId: emailAddress(config.inboundAddress), receipt: `ses:${policy.accountId}:${policy.region}:${emailAddress(config.fromAddress)}` }
    },
    async validate(channel, config, thread, payload) {
      emailPolicy(channel, config); emailAddress(thread.recipient)
      await one('SELECT id FROM email_suppressions LIMIT 1')
      if (await isSuppressed(emailAddress(thread.recipient))) fail(403, 'email_recipient_suppressed', 'This recipient is suppressed from email delivery.')
      if (Array.isArray(payload.attachmentIds) && payload.attachmentIds.length) fail(422, 'email_outbound_media_pending', 'Email attachment sending is not qualified yet.')
    },
    estimate(config) {
      const evidence = String(object(config._verification).receipt || ''), match = /^ses:(\d{12}):([a-z0-9-]+):(.+)$/.exec(evidence)
      if (!match) fail(503, 'email_identity_unverified', 'Verify this exact SES sender before reserving delivery.')
      let all: Row
      try { all = object(JSON.parse(process.env.SUPPORT_EMAIL_POLICIES || '{}')) } catch { fail(503, 'email_unconfigured', 'Configure operator email pricing.') }
      const policy = Object.values(all).map(object).find(row => Array.isArray(row.fromAddresses) && row.fromAddresses.map(String).includes(String(config.fromAddress)))
      const rate = Number(policy?.maxMicrosPerMessage)
      if (!Number.isSafeInteger(rate) || rate <= 0 || !policy?.rateVersion) fail(503, 'email_unconfigured', 'Configure an exact versioned maximum provider reserve.')
      return rate
    },
    async send(channel, config, thread, payload) {
      const policy = emailPolicy(channel, config), recipient = emailAddress(thread.recipient)
      if (payload._sesBillingScope !== undefined && !matchesSesBillingScope(payload._sesBillingScope, sesBillingScope(policy)))
        return { outcome: 'rejected', error: 'SES billing scope changed before dispatch.' }
      await one('SELECT id FROM email_suppressions LIMIT 1')
      if (await isSuppressed(recipient)) return { outcome: 'rejected', error: 'Email recipient is suppressed.' }
      const conversation = await one('SELECT subject FROM support_conversations WHERE id = ? AND project_id = ?', [thread.conversation_id, channel.project_id])
      const subject = String(conversation?.subject || 'Support').replace(/[\r\n]/g, ' ').slice(0, 200)
      const raw = buildMimeMessage({ from: emailAddress(config.fromAddress), to: recipient, replyTo: emailReplyAddress(channel, config, thread), subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text: String(payload.body) })
      const body = new URLSearchParams({ Action: 'SendRawEmail', Version: '2010-12-01', Source: emailAddress(config.fromAddress), 'RawMessage.Data': Buffer.from(raw).toString('base64'), 'Destinations.member.1': recipient })
      if (policy.outbound) {
        body.set('ConfigurationSetName', policy.outbound.configurationSet)
        body.set('Tags.member.1.Name', emailDispatchTagName)
        body.set('Tags.member.1.Value', emailDispatchTag(channel, String(payload._deliveryPublicId), recipient))
      }
      try {
        const result = await emailAws({ service: 'ses', region: policy.region, method: 'POST', path: '/', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(), retries: 0, timeoutMs: 15000 }, dependencies)
        const id = object(object(result.SendRawEmailResponse).SendRawEmailResult).MessageId ?? object(result.SendRawEmailResult).MessageId
        return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id) ? { outcome: 'accepted', messageId: id } : { outcome: 'unknown', error: 'SES acknowledgement had no message identity. Do not resend.' }
      }
      catch (error) {
        const value = object(error), status = Number(value.statusCode || value.status || 0)
        const rejected = [400, 401, 403, 404, 429].includes(status)
        return { outcome: rejected ? 'rejected' : 'unknown', error: rejected ? 'SES rejected this message.' : 'SES acknowledgement unavailable. Do not resend.', ...(status ? { httpStatus: status } : {}) }
      }
    },
    async validateMediaSources(channel, config, record, media) { const { validateEmailMedia } = await import('./email-receipts'); await validateEmailMedia(channel, config, record, media) },
    async ingestMedia(project, channel, record, conversationId, payload) { const { ingestEmailMedia } = await import('./email-receipts'); return await ingestEmailMedia(project, channel, record, conversationId, payload) },
  }
}
let registered = false
export function registerSupportEmail(dependencies: EmailDependencies = {}) {
  if (registered && !Object.keys(dependencies).length) return
  registered = true
  registerChannelProvider('email', supportEmailProvider(dependencies))
}
