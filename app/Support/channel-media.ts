import { deliveryChannelThread } from './channel-history'
import type { Row } from './database'
import { createHash } from 'node:crypto'
import { limitsFor } from './limits'
import type { Plan } from './limits'
import type { ChannelDependencies } from './channel-providers'
import { Storage, createSignedStorageToken, verifySignedStorageToken } from '@stacksjs/storage'
import { fetchPublicUrl } from '@stacksjs/security'
import { attachment, upload } from './attachments'
import { channelConfig } from './channels'
import { channelOrigin } from './channel-providers'
import { one } from './database'
import { entitled, object } from './service'
import { fail, identifier } from './errors'

export interface MediaSource { url: string, name: string, mimeType?: string, authorization?: string }
function imageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | undefined {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
}
async function storedBytes(row: Row) {
  const bytes = await Storage.disk(String(row.storage_disk)).readToBuffer(String(row.storage_key))
  if (bytes.length !== Number(row.bytes)) fail(503, 'attachment_integrity', 'Stored attachment integrity could not be verified.')
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== row.sha256) fail(503, 'attachment_integrity', 'Stored attachment checksum changed.')
  return bytes
}
function usesSignedMediaUrl(provider: string) { return provider === 'sms' || provider === 'whatsapp' }

/** Read one scoped image and verify its stored bytes before provider delivery. */
export async function readOutboundMedia(project: Row, conversationId: unknown, provider: string, payload: Row) {
  const ids = Array.isArray(payload.attachmentIds) ? payload.attachmentIds : []
  if (!ids.length) return []
  if ((!usesSignedMediaUrl(provider) && provider !== 'discord') || ids.length !== 1 || payload.contentSid) fail(422, 'unsupported_channel_media', 'Send one JPEG or PNG image through SMS, WhatsApp or Discord. Templates use their approved content flow.')
  const row = await attachment(project, ids[0])
  if (row.status !== 'stored' || String(row.conversation_id) !== String(identifier(conversationId))) fail(404, 'attachment_not_found', 'Stored attachment does not belong to this conversation.')
  if (Number(row.bytes) + Buffer.byteLength(String(payload.body || '')) >= 5000000) fail(413, 'provider_media_limit', 'Combined media and text must be smaller than 5 MB.')
  const bytes = await storedBytes(row), mime = imageMime(bytes)
  if (!mime || !['image/jpeg', 'image/png'].includes(String(row.mime_type)) || mime !== row.mime_type) fail(422, 'unsupported_channel_media', 'The stored bytes must match JPEG or PNG MIME type.')
  return [{ filename: mime === 'image/png' ? 'attachment.png' : 'attachment.jpg', contentType: mime, content: bytes }]
}
export async function outboundMediaUrls(delivery: Row, payload: Row) {
  if (!usesSignedMediaUrl(String(payload.provider))) return []
  const ids = Array.isArray(payload.attachmentIds) ? payload.attachmentIds : []
  if (!ids.length) return []
  return ids.map(value => {
    const id = identifier(value), path = `channel-media/${delivery.public_id}/${id}`
    const token = createSignedStorageToken(path, { expiresIn: 900, issuer: 'hq-support-provider-media' })
    return `${channelOrigin()}/api/channels/media/${delivery.public_id}/${id}?token=${encodeURIComponent(token)}`
  })
}
/** This signed capability exposes a single approved image to the delivery provider, for 15 minutes. */
export async function providerMediaResponse(deliveryId: string, attachmentId: unknown, token: string, head = false) {
  const id = identifier(attachmentId), path = `channel-media/${deliveryId}/${id}`
  const verified = verifySignedStorageToken(token, path)
  if (!verified.valid || verified.claims?.iss !== 'hq-support-provider-media') fail(403, 'media_signature_invalid', 'The provider media capability is invalid or expired.')
  const delivery = await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [deliveryId])
  if (!delivery || !['dispatching', 'unknown', 'cost_pending', 'accepted', 'settled', 'delivered'].includes(String(delivery.status))) fail(404, 'provider_media_unavailable', 'This provider media operation is unavailable.')
  const payload = object(JSON.parse(String(delivery.payload)))
  const provider = String(payload.provider)
  if (!usesSignedMediaUrl(provider) || !Array.isArray(payload.attachmentIds) || !payload.attachmentIds.map(String).includes(String(id))) fail(404, 'provider_media_unavailable', 'This media does not belong to an authorized provider fetch.')
  const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [delivery.project_id, delivery.workspace_id]))!
  const thread = await deliveryChannelThread(project, delivery)
  if (!thread) fail(404, 'provider_media_unavailable', 'The media conversation is unavailable.')
  const image = (await readOutboundMedia(project, thread.conversation_id, provider, payload))[0]!
  return new Response(head ? null : new Uint8Array(image.content).buffer, { headers: { 'Content-Type': image.contentType, 'Content-Length': String(image.content.length), 'Content-Disposition': `inline; filename="${image.filename}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' } })
}
/** Native pinned HTTPS performs DNS/redirect validation; this allowlist also protects provider credentials. */
export function providerMediaSources(channel: Row, config: Row, record: Row, media: unknown): MediaSource[] {
  if (!Array.isArray(media) || media.length > 10) fail(422, 'inbound_media_bound', 'Source media count exceeds the private ingestion bound; original payload retained.')
  return media.map((value, index) => {
    const item = object(value), nested = object(item.payload)
    const candidate = item.url || item.url_private_download || item.url_private || nested.url
    let url: URL
    try { url = new URL(String(candidate || '')) }
    catch { fail(422, 'provider_media_url_invalid', 'Provider media URL is invalid; source payload retained.') }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) fail(422, 'provider_media_url_invalid', 'Provider media requires canonical HTTPS.')
    let authorization: string | undefined
    const provider = String(channel.provider)
    if (['sms', 'whatsapp'].includes(provider)) {
      const expected = `/2010-04-01/Accounts/${config.accountSid}/Messages/${record.provider_event_id}/Media/`
      if (url.hostname !== 'api.twilio.com' || !url.pathname.startsWith(expected) || !/^ME[a-f0-9]{32}(?:\.[\w]+)?$/i.test(url.pathname.slice(expected.length)) || url.search) fail(422, 'provider_media_url_invalid', 'Twilio media must belong to this exact account and source message.')
      authorization = `Basic ${btoa(config.apiKeySid && config.apiKeySecret ? `${config.apiKeySid}:${config.apiKeySecret}` : `${config.accountSid}:${config.authToken}`)}`
    }
    else if (provider === 'slack') {
      if (url.hostname !== 'files.slack.com' || !url.pathname.startsWith('/files-pri/')) fail(422, 'provider_media_url_invalid', 'Slack media must use its private file host.')
      authorization = `Bearer ${config.botToken}`
    }
    else if (provider === 'discord') {
      if (url.hostname !== 'cdn.discordapp.com' || !url.pathname.startsWith(`/attachments/${config.channelId}/`)) fail(422, 'provider_media_url_invalid', 'Discord media must belong to the configured channel.')
    }
    else if (['messenger', 'instagram'].includes(provider)) {
      if (!(url.hostname === 'lookaside.fbsbx.com' || url.hostname.endsWith('.fbcdn.net'))) fail(422, 'provider_media_url_invalid', 'Meta media must use the provider CDN.')
    }
    else fail(422, 'unsupported_provider_media', 'This provider has no qualified private media ingestion adapter.')
    const name = typeof item.name === 'string' ? item.name : `provider-attachment-${index + 1}`
    return { url: url.href, name, mimeType: typeof item.mimeType === 'string' ? item.mimeType : typeof item.mimetype === 'string' ? item.mimetype : undefined, authorization }
  })
}
export async function ingestProviderMedia(project: Row, channel: Row, record: Row, conversationId: unknown, payload: Row, dependencies: ChannelDependencies = {}) {
  const media = object(payload.normalized).media
  if (!Array.isArray(media) || !media.length) return []
  const config = await channelConfig({ ...channel, configuration: payload._configuration || channel.configuration })
  const sources = providerMediaSources(channel, config, record, media), result = []
  const quota = limitsFor((await entitled(Number(project.workspace_id))).plan as Plan), maximum = quota.fileBytes ?? 50000000
  for (const [index, source] of sources.entries()) {
    const response = await (dependencies.mediaFetch || ((url, init) => fetchPublicUrl(String(url), init, { maxBytes: maximum, maxRedirects: 3, timeoutMs: 15000 })))(source.url, { headers: source.authorization ? { Authorization: source.authorization } : {}, redirect: 'manual' })
    if (!response.ok) fail(503, 'provider_media_unavailable', 'Provider media could not be downloaded; original source remains pending.')
    const declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) fail(413, 'provider_media_large', 'Provider attachment exceeds the private ingestion bound.')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!bytes.length || bytes.length > maximum || (declared && Number(declared) !== bytes.length)) fail(413, 'provider_media_large', 'Provider attachment byte count is invalid.')
    const mime = (response.headers.get('content-type') || source.mimeType || 'application/octet-stream').split(';')[0]!.trim()
    const owner = await one('SELECT support_contacts.* FROM support_contacts JOIN support_conversations ON support_conversations.contact_id = support_contacts.id WHERE support_conversations.id = ? AND support_conversations.project_id = ? AND support_contacts.project_id = ?', [identifier(conversationId), project.id, project.id])
    if (!owner) fail(404, 'media_conversation_unavailable', 'The source conversation customer is unavailable.')
    result.push((await upload(project, conversationId, new File([bytes], source.name, { type: mime }), `channel-inbound:${record.id}:media:${index}`, owner)).attachment)
  }
  return result
}
