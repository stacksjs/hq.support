import { createHash } from 'node:crypto'
import { verifySesSnsSignature } from '@stacksjs/email/webhook-signatures'
import type { SesSnsSignatureInput } from '@stacksjs/email/webhook-signatures'
import { parseInboundEmail } from '@stacksjs/email/inbound-parser'
import { Storage, Visibility } from '@stacksjs/storage'
import { fetchPublicUrl } from '@stacksjs/security'
import { storeJob } from '@stacksjs/queue/utils'
import type { Row } from './database'
import type { EmailDependencies } from './support-email'
import { emailAddress, emailAws, emailPolicy, emailPrivateBucket, emailReplyThread } from './support-email'
import { channelConfig, loadChannel } from './channels'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier } from './errors'
import { object, secret } from './service'
import { retainChannelInbound } from './managed-channels'
import { upload } from './attachments'

const maximumRaw = 8 * 1024 * 1024
const hash = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex')
export function emailReceiptView(row: Row) { return { id: String(row.public_id), channelId: String(row.channel_id), status: row.status, attempts: Number(row.attempts), rawRetained: Number(row.raw_bytes) > 0, inboundId: Number(row.inbound_id) ? String(row.inbound_id) : null, lastError: row.last_error, createdAt: row.created_at } }
async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) fail(503, 'email_source_unavailable', 'Private source is unavailable.')
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) { await response.body.cancel(); fail(413, 'email_source_bound', 'Private source exceeds the email size limit.') }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let count = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      count += value.length
      if (count > maximum) { await reader.cancel(); fail(413, 'email_source_bound', 'Private source exceeds the email size limit.') }
      chunks.push(value)
    }
  }
  finally { reader.releaseLock() }
  if (!count || (length && count !== Number(length))) fail(413, 'email_source_bound', 'Private source byte count is invalid.')
  const bytes = new Uint8Array(count)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}
export async function retainEmailNotification(channel: Row, envelope: Row, dependencies: EmailDependencies = {}) {
  if (channel.provider !== 'email' || channel.status !== 'ready') fail(503, 'email_channel_unavailable', 'Verify an active email channel first.')
  const config = await channelConfig(channel), policy = emailPolicy(channel, config)
  if (JSON.stringify(envelope).length > 262144) fail(413, 'email_notification_bound', 'SNS notification exceeds the receipt bound.')
  let cert: URL
  try { cert = new URL(String(envelope.SigningCertURL)) } catch { fail(401, 'email_signature_invalid', 'SNS signing certificate URL is invalid.') }
  const expectedHost = `sns.${policy.region}.amazonaws.com`
  if (envelope.TopicArn !== policy.topicArn || !['1', '2'].includes(String(envelope.SignatureVersion)) || cert.protocol !== 'https:' || cert.hostname !== expectedHost || cert.port || cert.username || cert.password || cert.search || cert.hash || !/^\/SimpleNotificationService-[a-fA-F0-9]+\.pem$/.test(cert.pathname) || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(envelope.Signature || ''))) fail(401, 'email_signature_invalid', 'SNS topic, account, region or signing certificate is not authorized.')
  if (!Number.isFinite(Date.parse(String(envelope.Timestamp))) || Date.parse(String(envelope.Timestamp)) > Date.now() + 300000 || typeof envelope.Message !== 'string' || typeof envelope.MessageId !== 'string' || envelope.MessageId.length > 200 || (envelope.Subject !== undefined && typeof envelope.Subject !== 'string')) fail(401, 'email_signature_invalid', 'SNS signature fields are invalid.')
  let valid = false
  try {
    valid = (await verifySesSnsSignature({ message: envelope as SesSnsSignatureInput['message'], certUrlHostAllowlist: new RegExp(`^sns\\.${policy.region}\\.amazonaws\\.com$`), fetchCert: dependencies.fetchCert || (async url => new TextDecoder().decode(await boundedBytes(await fetchPublicUrl(url, { redirect: 'error' }, { maxBytes: 32768, maxRedirects: 0, timeoutMs: 10000 }), 32768))) })).ok
  }
  catch { /* Invalid provider signatures never reach storage or the queue. */ }
  if (!valid) fail(401, 'email_signature_invalid', 'SNS signature verification failed.')
  if (envelope.Type !== 'Notification') fail(409, 'email_subscription_setup', 'Confirm the exact SNS subscription through the operator setup flow.')
  let notification: Row
  try { notification = object(JSON.parse(String(envelope.Message))) } catch { fail(422, 'email_notification_invalid', 'SES notification is invalid.') }
  const mail = object(notification.mail), receipt = object(notification.receipt), action = object(receipt.action)
  if (notification.notificationType !== 'Received' || action.type !== 'S3' || action.bucketName !== policy.bucket || action.topicArn !== policy.topicArn || typeof action.objectKey !== 'string' || action.objectKey !== policy.prefix + String(mail.messageId) || action.objectKey.length > 1000 || /[\x00-\x1f]/.test(action.objectKey) || typeof mail.messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(mail.messageId)) fail(422, 'email_notification_invalid', 'SES receipt must identify the exact operator S3 source.')
  const destinations = Array.isArray(mail.destination) ? mail.destination.map(emailAddress) : []
  if (!destinations.some(address => address === emailAddress(config.inboundAddress) || (address.startsWith('r+') && address.endsWith(`@${policy.replyDomain}`)))) fail(403, 'email_recipient_mismatch', 'Signed SES envelope does not address this channel.')
  const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [channel.project_id, channel.workspace_id]))!
  return await workspaceTransaction(Number(channel.workspace_id), async () => {
    const fresh = await loadChannel(project, channel.id)
    if (fresh.configuration !== channel.configuration || fresh.status !== 'ready') fail(409, 'email_channel_changed', 'Email connection changed during signature verification.')
    const sourceHash = hash(String(envelope.Message)), previous = await one('SELECT * FROM support_email_receipts WHERE channel_id = ? AND ses_message_id = ?', [channel.id, mail.messageId])
    if (previous) {
      if (previous.source_hash !== sourceHash) fail(409, 'email_receipt_conflict', 'SES source identity changed. Original receipt remains retained.')
      return { receipt: emailReceiptView(previous), duplicate: true }
    }
    const row = await insert('support_email_receipts', { public_id: crypto.randomUUID(), workspace_id: channel.workspace_id, project_id: channel.project_id, channel_id: channel.id, ses_message_id: mail.messageId, sns_message_id: envelope.MessageId, source_hash: sourceHash, payload: JSON.stringify({ envelope, notification, _configuration: channel.configuration }) })
    await storeJob('RunSupportEmail', { queue: 'support-email', payload: { receiptId: Number(row.id) }, maxTries: 5, timeout: 120 })
    return { receipt: emailReceiptView(row), duplicate: false }
  })
}
async function retainedRaw(row: Row): Promise<Uint8Array> {
  if (!row.raw_key || !row.raw_disk || !Number(row.raw_bytes)) fail(503, 'email_archive_unavailable', 'Email source archive is unavailable.')
  const bytes = new Uint8Array(await Storage.disk(String(row.raw_disk)).readToBuffer(String(row.raw_key)))
  if (bytes.length !== Number(row.raw_bytes) || hash(bytes) !== row.raw_sha256) fail(503, 'email_archive_integrity', 'Email source archive integrity check failed.')
  return bytes
}
function safeVerdicts(receipt: Row): boolean {
  return ['virusVerdict', 'spamVerdict', 'spfVerdict', 'dkimVerdict', 'dmarcVerdict'].every(key => object(receipt[key]).status === 'PASS')
}
export async function processEmailReceipt(id: unknown, dependencies: EmailDependencies = {}) {
  const initial = await one('SELECT * FROM support_email_receipts WHERE id = ?', [identifier(id)])
  if (!initial) return { processed: false }
  const row: Row | undefined = await workspaceTransaction(Number(initial.workspace_id), async () => {
    const current = await one('SELECT * FROM support_email_receipts WHERE id = ?', [initial.id])
    if (!current || ['processed', 'quarantined'].includes(String(current.status)) || Number(current.lease_until) > Date.now()) return undefined
    const token = secret()
    await query("UPDATE support_email_receipts SET status = 'processing', lease_token = ?, lease_until = ?, attempts = attempts + 1 WHERE id = ?", [token, Date.now() + 120000, current.id])
    return { ...current, lease_token: token }
  })
  if (!row) return { processed: false }
  let quarantined = false
  try {
    const payload = object(JSON.parse(String(row.payload))), notification = object(payload.notification), mail = object(notification.mail), receipt = object(notification.receipt), action = object(receipt.action)
    const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [row.project_id, row.workspace_id]))!
    const channel = await loadChannel(project, row.channel_id), config = await channelConfig({ ...channel, configuration: payload._configuration })
    const policy = emailPolicy(channel, config)
    let bytes: Uint8Array
    if (row.raw_key) bytes = await retainedRaw(row)
    else {
      const response = await emailAws({ service: 's3', region: policy.region, bucket: policy.bucket, method: 'GET', path: '/' + String(action.objectKey).split('/').map(encodeURIComponent).join('/'), streamResponse: true, retries: 0, timeoutMs: 15000 }, dependencies) as unknown as Response
      bytes = await boundedBytes(response, maximumRaw)
      const disk = process.env.SUPPORT_EMAIL_ARCHIVE_DISK || process.env.SUPPORT_STORAGE_DISK || Storage.getDefaultDisk()
      const diskConfig = Storage.getDiskConfig(disk)
      if (disk === 'public' || !diskConfig || diskConfig.visibility === 'public' || !['local', 's3'].includes(diskConfig.driver)) fail(503, 'email_private_archive_required', 'Configure a qualified private local or S3 email archive disk.')
      if (diskConfig.driver === 's3') {
        if (diskConfig.endpoint || !diskConfig.bucket || !diskConfig.region) fail(503, 'email_private_archive_required', 'Use a canonical private AWS S3 archive bucket.')
        await emailPrivateBucket(diskConfig.bucket, diskConfig.region, dependencies)
      }
      const directory = `support-email/${row.workspace_id}/${row.public_id}`, key = `${directory}/raw.eml`
      if (diskConfig.driver === 'local') {
        await Storage.disk(disk).createDirectory(directory)
        await Storage.disk(disk).changeVisibility(directory, Visibility.PRIVATE)
        if (await Storage.disk(disk).visibility(directory) !== Visibility.PRIVATE) fail(503, 'email_private_archive_required', 'Email archive directory must remain private.')
      }
      const stored = await Storage.disk(disk).write(key, bytes)
      if (diskConfig.driver === 'local') await Storage.disk(disk).changeVisibility(key, Visibility.PRIVATE)
      if (await Storage.disk(disk).visibility(key) !== Visibility.PRIVATE) fail(503, 'email_private_archive_required', 'Email archive must remain private.')
      if (stored.size !== bytes.length) fail(503, 'email_archive_integrity', 'Private email archive write did not complete.')
      await query('UPDATE support_email_receipts SET raw_disk = ?, raw_key = ?, raw_sha256 = ?, raw_bytes = ? WHERE id = ? AND lease_token = ?', [disk, key, hash(bytes), bytes.length, row.id, row.lease_token])
      row.raw_disk = disk; row.raw_key = key; row.raw_sha256 = hash(bytes); row.raw_bytes = bytes.length
    }
    if (!safeVerdicts(receipt)) { quarantined = true; fail(422, 'email_verdict_quarantine', 'SES authentication, spam or virus verdict was not PASS.') }
    let parsed: Awaited<ReturnType<typeof parseInboundEmail>>
    try { parsed = await parseInboundEmail(bytes) } catch { quarantined = true; fail(422, 'email_mime_quarantine', 'Raw MIME could not be parsed within supported bounds.') }
    if (parsed.attachments.length > 10 || parsed.text.length > 20000 || parsed.subject.length > 200 || (!parsed.text.trim() && !parsed.attachments.length)) { quarantined = true; fail(422, 'email_content_quarantine', 'Email content exceeds qualified bounds or has no supported plain-text body.') }
    const signedFrom = object(mail.commonHeaders).from
    if (!Array.isArray(signedFrom) || signedFrom.length !== 1 || typeof signedFrom[0] !== 'string' || signedFrom[0].length > 1000 || /[\r\n]/.test(signedFrom[0])) { quarantined = true; fail(422, 'email_sender_quarantine', 'Signed SES From header is ambiguous or unavailable.') }
    const signedMailbox = await parseInboundEmail(`From: ${signedFrom[0]}\r\nSubject: Sender verification\r\n\r\nSigned sender`)
    const sender = emailAddress(signedMailbox.from)
    if (emailAddress(parsed.from) !== sender) { quarantined = true; fail(422, 'email_sender_quarantine', 'MIME From does not match the signed, DMARC-passing SES From header.') }
    const destinations = (mail.destination as unknown[]).map(emailAddress), relevant = destinations.filter(address => address === emailAddress(config.inboundAddress) || address.endsWith(`@${policy.replyDomain}`) && address.startsWith('r+'))
    if (relevant.length !== 1) { quarantined = true; fail(422, 'email_recipient_quarantine', 'Ambiguous email routing requires review.') }
    let remoteKey = `email:${row.public_id}`, contactExternalId = `email:${channel.public_id}:${row.public_id}`
    if (relevant[0]!.startsWith('r+')) {
      let thread: Row
      try { thread = await emailReplyThread(channel, config, relevant[0]!, sender) } catch { quarantined = true; fail(403, 'email_reply_quarantine', 'Reply capability is invalid, expired or belongs to another sender.') }
      const who = await one('SELECT external_id FROM support_contacts WHERE id = ? AND project_id = ? AND workspace_id = ?', [thread.contact_id, project.id, project.workspace_id])
      if (!who) { quarantined = true; fail(422, 'email_reply_quarantine', 'Reply thread customer is unavailable.') }
      remoteKey = String(thread.remote_key); contactExternalId = String(who.external_id)
    }
    const normalized = { sender, name: parsed.fromName || sender, remoteKey, contactExternalId, subject: parsed.subject, body: parsed.text, timestamp: Number.isFinite(Date.parse(String(mail.timestamp))) ? Date.parse(String(mail.timestamp)) : Date.parse(String(object(payload.envelope).Timestamp)), media: parsed.attachments.map((attachment, index) => ({ receiptId: String(row.public_id), index, sha256: hash(attachment.content), name: attachment.name, mimeType: attachment.contentType })) }
    await workspaceTransaction(Number(row.workspace_id), async () => {
      const current = await one('SELECT * FROM support_email_receipts WHERE id = ?', [row.id])
      if (!current || current.lease_token !== row.lease_token || Number(current.lease_until) <= Date.now()) fail(409, 'email_lease_changed', 'Email archive processing ownership changed.')
      const inbound = await retainChannelInbound(project, channel, String(row.ses_message_id), normalized, { receiptId: String(row.public_id), sourceHash: row.source_hash })
      await query("UPDATE support_email_receipts SET status = 'processed', inbound_id = ?, lease_until = 0, last_error = '' WHERE id = ? AND lease_token = ?", [inbound.id, row.id, row.lease_token])
    })
    return { processed: true }
  }
  catch (error) {
    const code = String(object(error).code || '')
    if (['email_source_bound', 'email_address_invalid'].includes(code)) quarantined = true
    await query('UPDATE support_email_receipts SET status = ?, lease_until = 0, last_error = ? WHERE id = ? AND lease_token = ?', [quarantined ? 'quarantined' : 'pending', quarantined ? code || 'email_content_quarantine' : 'Email processing deferred; signed source remains retained.', row.id, row.lease_token])
    return { processed: false, quarantined }
  }
}
export async function recoverEmailReceipts(dependencies: EmailDependencies = {}) {
  const rows = await query("SELECT id FROM support_email_receipts WHERE status IN ('pending', 'processing') AND lease_until <= ? ORDER BY id LIMIT 100", [Date.now()])
  for (const row of rows) await processEmailReceipt(row.id, dependencies)
  return { checked: rows.length }
}
export async function validateEmailMedia(channel: Row, config: Row, record: Row, media: unknown) {
  emailPolicy(channel, config)
  if (!Array.isArray(media) || media.length > 10) fail(422, 'email_media_invalid', 'Email media descriptors are invalid.')
  const row = await one('SELECT * FROM support_email_receipts WHERE channel_id = ? AND ses_message_id = ? AND project_id = ? AND workspace_id = ?', [channel.id, record.provider_event_id, record.project_id, record.workspace_id])
  if (!row || row.status !== 'processed' || String(row.inbound_id) !== String(record.id)) fail(422, 'email_media_invalid', 'Email media does not belong to this retained source event.')
  const parsed = await parseInboundEmail(await retainedRaw(row))
  if (media.length !== parsed.attachments.length || media.some((raw, index) => { const item = object(raw), attachment = parsed.attachments[index]; return !attachment || String(item.receiptId) !== String(row.public_id) || item.index !== index || item.sha256 !== hash(attachment.content) || item.name !== attachment.name || item.mimeType !== attachment.contentType })) fail(422, 'email_media_invalid', 'Email media descriptor differs from its private source archive.')
  return { row, parsed }
}
export async function ingestEmailMedia(project: Row, channel: Row, record: Row, conversationId: unknown, payload: Row) {
  const media = object(payload.normalized).media
  if (!Array.isArray(media) || !media.length) return []
  const config = await channelConfig({ ...channel, configuration: payload._configuration || channel.configuration }), { parsed } = await validateEmailMedia(channel, config, record, media)
  const thread = await one('SELECT contact_id FROM support_channel_threads WHERE conversation_id = ? AND project_id = ? AND channel_id = ?', [conversationId, project.id, channel.id])
  const customer = thread ? await one('SELECT * FROM support_contacts WHERE id = ? AND project_id = ?', [thread.contact_id, project.id]) : undefined
  if (!customer) fail(409, 'email_media_customer_missing', 'Email media customer is unavailable.')
  const result = []
  for (const [index, attachment] of parsed.attachments.entries()) result.push((await upload(project, conversationId, new File([new Uint8Array(attachment.content).buffer], attachment.name, { type: attachment.contentType }), `email:${record.id}:${index}`, customer)).attachment)
  return result
}
