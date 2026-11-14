import { digest } from '../../app/Support/service'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { Storage } from '@stacksjs/storage'
import { buildMimeMessage } from '@stacksjs/email/mime'
import { suppress, unsuppress } from '@stacksjs/email/suppression'
import { parseInboundEmail } from '@stacksjs/email/inbound-parser'
import { runIsolated, assertIsolatedOk } from '@stacksjs/testing/isolated'
import { emailAction } from '../../app/Actions/Support/EmailAction'
import { channelAction } from '../../app/Actions/Support/ChannelAction'
import { one, query } from '../../app/Support/database'
import { processEmailReceipt } from '../../app/Support/email-receipts'
import { emailReplyAddress, registerSupportEmail } from '../../app/Support/support-email'
import { channelConfig, loadChannel } from '../../app/Support/channels'
import { applyChannelInbound, dispatchChannelDelivery } from '../../app/Support/managed-channels'
import { configureWalletLimits } from '../../app/Support/billing'

await overridesReady
config.database.queryLogging.enabled = false
Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const region = 'us-east-1', accountId = '123456789012', topicArn = `arn:aws:sns:${region}:${accountId}:hq-support-email`, bucket = 'hq-support-email-private', cert = readFileSync(new URL('enterprise-saml-test-cert.pem', import.meta.url), 'utf8'), key = readFileSync(new URL('enterprise-saml-test-key.pem', import.meta.url), 'utf8')
let sends = 0, reads = 0, certificates = 0, failure: 'unknown' | 'rejected' | 'server_error' | undefined, privateBucket = true
const rawSources = new Map<string, string>(), outgoing: string[] = []
const gateway = async (options: any) => {
  assert.equal(options.region, region); assert.equal(options.retries, 0); assert.equal(options.timeoutMs, 15000)
  if (options.service === 'sts') return { GetCallerIdentityResponse: { GetCallerIdentityResult: { Account: accountId } } }
  if (options.service === 'ses' && options.method === 'GET') return { VerificationStatus: 'SUCCESS', VerifiedForSendingStatus: true, DkimAttributes: { SigningEnabled: true, Status: 'SUCCESS' } }
  if (options.service === 's3' && options.queryParams?.publicAccessBlock === '') return { PublicAccessBlockConfiguration: Object.fromEntries(['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets'].map(key => [key, privateBucket])) }
  if (options.service === 's3') { reads++; assert.equal(options.bucket, bucket); const raw = rawSources.get(options.path); assert.ok(raw); return new Response(raw, { headers: { 'Content-Length': String(Buffer.byteLength(raw)) } }) }
  assert.equal(options.service, 'ses'); assert.equal(options.method, 'POST'); sends++
  const form = new URLSearchParams(options.body)
  assert.equal(form.get('Action'), 'SendRawEmail'); assert.equal(form.get('Source'), 'support@owned.example.test')
  assert.equal(form.get('Destinations.member.1'), 'customer@example.test')
  const raw = Buffer.from(form.get('RawMessage.Data')!, 'base64').toString(); outgoing.push(raw)
  if (failure === 'unknown') { failure = undefined; throw new Error('Provider response lost after acceptance') }
  if (failure === 'server_error') { failure = undefined; throw Object.assign(new Error('upstream service unavailable'), { statusCode: 503 }) }
  if (failure === 'rejected') { failure = undefined; throw Object.assign(new Error('provider secret body'), { statusCode: 400 }) }
  return { SendRawEmailResponse: { SendRawEmailResult: { MessageId: `ses-out-${sends}` } } }
}
const dependencies = { awsRequest: gateway, fetchCert: async () => { certificates++; return cert } }
registerSupportEmail(dependencies)
route.post('/api/_email/channels/{channel}/incoming', emailAction('incoming', 'POST', dependencies)).skipCsrf()
route.get('/api/_email/projects/{project}/receipts', emailAction('receipts', 'GET', dependencies)).middleware('auth')
for (const [path, operation] of [['channels', 'save'], ['channels/{channel}/verify', 'verify'], ['conversations/{conversation}/reply', 'reply']] as const) route.post(`/api/_email/projects/{project}/${path}`, channelAction(operation, 'POST')).middleware('auth')
const server = await route.serve({ port: 0, hostname: '127.0.0.1' }), base = `http://127.0.0.1:${server.port}/api`
registerSupportEmail(dependencies)
let checks = 0, csrf = '', cookie = ''
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, bearer?: string, contentType = 'application/json') {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'Content-Type': contentType } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, data: await response.json() as any, headers: response.headers }
}
async function account(email: string) {
  check((await http('/register', 'POST', { name: 'Email Owner', email, password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })).status < 300, 'native email account registers')
  const result = await http('/login', 'POST', { email, password: 'SecureSupport2026!' })
  return result.data.access_token ?? result.data.token
}
function signed(message: any, change: Record<string, unknown> = {}) {
  const envelope = { Type: 'Notification', MessageId: crypto.randomUUID(), TopicArn: topicArn, Message: JSON.stringify(message), Timestamp: new Date().toISOString(), SignatureVersion: '2', SigningCertURL: `https://sns.${region}.amazonaws.com/SimpleNotificationService-${'a'.repeat(32)}.pem`, ...change }
  const canonical = ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'].map(key => `${key}\n${String((envelope as any)[key])}\n`).join('')
  return { ...envelope, Signature: createSign('RSA-SHA256').update(canonical).sign(key, 'base64') }
}
function received(id: string, destination: string, source = 'customer@example.test', verdict = 'PASS') {
  return { notificationType: 'Received', mail: { messageId: id, source, commonHeaders: { from: [source] }, destination: [destination], timestamp: new Date().toISOString() }, receipt: { ...Object.fromEntries(['virusVerdict', 'spamVerdict', 'spfVerdict', 'dkimVerdict', 'dmarcVerdict'].map(key => [key, { status: verdict }])), action: { type: 'S3', bucketName: bucket, objectKey: `incoming/${id}`, topicArn } } }
}
function source(id: string, from = 'customer@example.test', body = 'Please help with checkout', attachment = false) {
  rawSources.set(`/incoming/${id}`, buildMimeMessage({ from, to: 'attacker-controlled-to@example.test', subject: 'A real MIME subject', text: body, ...(attachment ? { attachments: [{ filename: '../customer-note.bin', contentType: 'application/octet-stream', content: new Uint8Array([0, 255, 128, 1, 2, 10, 13]) }] } : {}) }))
}
async function applyLatest(channel: any) {
  const receipt = (await one('SELECT * FROM support_email_receipts WHERE channel_id = ? ORDER BY id DESC LIMIT 1', [channel.id]))!
  await processEmailReceipt(receipt.id, dependencies)
  const current = (await one('SELECT * FROM support_email_receipts WHERE id = ?', [receipt.id]))!
  if (Number(current.inbound_id)) await applyChannelInbound(current.inbound_id)
  return (await one('SELECT * FROM support_email_receipts WHERE id = ?', [receipt.id]))!
}
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const owner = await account('email-owner@example.test'), outsider = await account('email-outsider@example.test')
  const workspace = (await http('/support/workspaces', 'POST', { name: 'Email Workspace' }, owner)).data.workspace
  const otherWorkspace = (await http('/support/workspaces', 'POST', { name: 'Other Email' }, outsider)).data.workspace
  const project = (await http(`/support/workspaces/${workspace.id}/projects`, 'POST', { name: 'Email App' }, owner)).data.project
  const other = (await http(`/support/workspaces/${otherWorkspace.id}/projects`, 'POST', { name: 'Other App' }, outsider)).data.project
  const user = (await one('SELECT id FROM users WHERE email = ?', ['email-owner@example.test']))!
  await query('UPDATE support_workspaces SET wallet_cents = 10000 WHERE id = ?', [workspace.id])
  await configureWalletLimits(Number(user.id), Number(workspace.id), { dailyLimitCents: 10000, monthlyLimitCents: 20000 })
  process.env.SUPPORT_EMAIL_REPLY_KEY = 'fixture-email-reply-signing-key-32-bytes'
  const policy = { region, accountId, topicArn, bucket, prefix: 'incoming/', fromAddresses: ['support@owned.example.test'], inboundAddresses: ['inbox@owned.example.test'], replyDomain: 'reply.hq.support', rateVersion: 'fixture-ceiling-v1', maxMicrosPerMessage: 1000 }
  process.env.SUPPORT_EMAIL_POLICIES = JSON.stringify({ [String(workspace.id)]: policy })
  const path = `/_email/projects/${project.public_id}`, config = { fromAddress: 'support@owned.example.test', inboundAddress: 'inbox@owned.example.test' }
  const saved = await http(path + '/channels', 'POST', { provider: 'email', label: 'Support email', configuration: config }, owner), channel = saved.data.channel
  check(saved.status === 201 && channel.status === 'pending', 'saved email metadata is not readiness')
  privateBucket = false
  const publicProbe = await http(path + `/channels/${channel.id}/verify`, 'POST', {}, owner)
  check(publicProbe.status === 403, `public source bucket cannot become ready ${JSON.stringify(publicProbe)}`)
  privateBucket = true
  check((await http(path + `/channels/${channel.id}/verify`, 'POST', {}, owner)).status === 200, 'native gateway probes exact SES account/DKIM and private source bucket')
  const foreignChannel = (await http(`/_email/projects/${other.public_id}/channels`, 'POST', { provider: 'email', label: 'Stolen sender', configuration: config }, outsider)).data.channel
  check((await http(`/_email/projects/${other.public_id}/channels/${foreignChannel.id}/verify`, 'POST', {}, outsider)).status === 503, 'global SES verification does not authorize another workspace sender')
  const inboundPath = `/_email/channels/${channel.publicId}/incoming`
  source('mail-one', undefined, undefined, true)
  const envelope = signed(received('mail-one', config.inboundAddress))
  const certificateCount = certificates
  check((await http(inboundPath, 'POST', { ...envelope, TopicArn: topicArn + '-wrong' }, undefined, 'text/plain')).status === 401 && certificates === certificateCount, 'foreign topic refused before certificate fetch')
  check((await http(inboundPath, 'POST', { ...envelope, SigningCertURL: 'https://127.0.0.1/private.pem' })).status === 401 && certificates === certificateCount, 'private certificate SSRF refused before fetch')
  check((await http(inboundPath, 'POST', { ...envelope, Message: envelope.Message + ' ' })).status === 401, 'real RSA signature detects signed message tampering')
  const admitted = await http(inboundPath, 'POST', envelope, undefined, 'text/plain; charset=UTF-8')
  check(admitted.status === 202 && reads === 0, `signed receipt is durable before S3 fetch and SNS ACK ${JSON.stringify(admitted.data)}`)
  check((await query('SELECT * FROM support_email_receipts')).length === 1 && (await query("SELECT * FROM jobs WHERE queue = 'support-email'")).length === 1, 'receipt and native queue intent commit before acknowledgement')
  const duplicate = await http(inboundPath, 'POST', envelope)
  check(duplicate.status === 202 && duplicate.data.duplicate && (await query('SELECT * FROM support_email_receipts')).length === 1, 'SNS replay deduplicates durable SES identity')
  const receipt = await applyLatest(channel)
  check(receipt.status === 'processed' && Number(receipt.raw_bytes) > 0 && Number(receipt.inbound_id) > 0, 'private MIME is archived before normalized inbox admission')
  const firstThread = (await one('SELECT * FROM support_channel_threads WHERE channel_id = ?', [channel.id]))!
  const firstCustomer = (await one('SELECT * FROM support_contacts WHERE id = ?', [firstThread.contact_id]))!
  check(String(firstCustomer.external_id).startsWith(`email:${channel.publicId}:`) && firstThread.recipient === 'customer@example.test', 'new email thread receives a unique contact identity without email lookup')
  const attachment = (await one('SELECT * FROM support_attachments WHERE conversation_id = ?', [firstThread.conversation_id]))!
  check(attachment.status === 'stored' && !String(attachment.file_name).includes('/') && String(attachment.contact_id) === String(firstCustomer.id), 'real MIME attachment has sanitized filename and private scoped customer ownership')
  check(Buffer.from(await Storage.disk(String(attachment.storage_disk)).readToBuffer(String(attachment.storage_key))).equals(Buffer.from([0, 255, 128, 1, 2, 10, 13])), 'native MIME parsing preserves exact binary attachment bytes')
  source('mail-two')
  await http(inboundPath, 'POST', signed(received('mail-two', config.inboundAddress)))
  await applyLatest(channel)
  const threads = await query('SELECT * FROM support_channel_threads WHERE channel_id = ?', [channel.id])
  check(threads.length === 2 && String(threads[0]!.contact_id) !== String(threads[1]!.contact_id), 'same email address starting a new thread never merges contact or private history')
  const rawChannel = await loadChannel(project, channel.id), privateConfig = await channelConfig(rawChannel), replyAddress = emailReplyAddress(rawChannel, privateConfig, firstThread)
  check(replyAddress.split('@')[0]!.length <= 64, 'signed reply capability fits RFC local part bound')
  source('mail-reply')
  await http(inboundPath, 'POST', signed(received('mail-reply', replyAddress)))
  await applyLatest(channel)
  check((await query('SELECT * FROM support_channel_threads WHERE channel_id = ?', [channel.id])).length === 2 && (await query('SELECT * FROM support_messages WHERE conversation_id = ?', [firstThread.conversation_id])).length === 2, 'signed reply capability binds exact original thread and sender')
  source('mail-stolen', 'attacker@example.test')
  await http(inboundPath, 'POST', signed(received('mail-stolen', replyAddress, 'attacker@example.test')))
  check((await applyLatest(channel)).status === 'quarantined' && (await query('SELECT * FROM support_channel_threads WHERE channel_id = ?', [channel.id])).length === 2, 'stolen reply capability cannot append another sender to existing history')
  source('mail-expired')
  const expiredAddress = emailReplyAddress(rawChannel, privateConfig, firstThread, Date.now() - 31 * 86400000)
  await http(inboundPath, 'POST', signed(received('mail-expired', expiredAddress)))
  check((await applyLatest(channel)).status === 'quarantined', 'expired reply capability quarantines source without exposing old history')
  source('mail-spam')
  await http(inboundPath, 'POST', signed(received('mail-spam', config.inboundAddress, undefined, 'FAIL')))
  const spam = await applyLatest(channel)
  check(spam.status === 'quarantined' && Number(spam.raw_bytes) > 0 && !Number(spam.inbound_id), 'failed SES verdict quarantines archived source without inbox exposure')
  source('mail-mismatch', 'attacker@example.test')
  await http(inboundPath, 'POST', signed(received('mail-mismatch', config.inboundAddress)))
  check((await applyLatest(channel)).status === 'quarantined', 'MIME From must match signed authenticated SES sender')
  const listing = await http(path + '/receipts', 'GET', undefined, owner)
  check(listing.status === 200 && !JSON.stringify(listing.data).includes('RawMessage') && !JSON.stringify(listing.data).includes('sourceHash') && !JSON.stringify(listing.data).includes('raw.eml'), 'receipt views omit raw MIME/private keys and signed payload')
  check((await http(path + '/receipts', 'GET', undefined, outsider)).status === 403, 'foreign workspace cannot inspect receipt metadata')
  await suppress('customer@example.test', 'complaint', 'fixture suppression')
  check((await http(path + `/conversations/${firstThread.conversation_id}/reply`, 'POST', { body: 'Must not send', idempotencyKey: 'suppressed-reply' }, owner)).status === 403 && sends === 0, 'native suppression blocks managed email before wallet reservation or provider send')
  await unsuppress('customer@example.test', 'complaint')
  const replyInput = { body: 'Accepted public email reply', idempotencyKey: 'email-reply-one' }
  const pending = await http(path + `/conversations/${firstThread.conversation_id}/reply`, 'POST', replyInput, owner)
  check(pending.status === 201 && pending.data.delivery.status === 'pending' && sends === 0, 'native SQL journal and wallet reserve precede paid send')
  const delivery = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [pending.data.delivery.id]))!
  await Promise.all([dispatchChannelDelivery(Number(delivery.id)), dispatchChannelDelivery(Number(delivery.id))])
  const accepted = (await one('SELECT * FROM support_channel_deliveries WHERE id = ?', [delivery.id]))!
  check(sends === 1 && accepted.status === 'cost_pending' && accepted.provider_message_id === 'ses-out-1', 'concurrent workers send once and accepted SES cost stays honestly pending')
  const mime = await parseInboundEmail(outgoing[0]!)
  check(mime.from === config.fromAddress && mime.text === replyInput.body && outgoing[0]!.includes('Reply-To: r+'), 'native MIME wire uses exact operator sender and signed reply route')
  const hold = await one('SELECT * FROM support_wallet_reservations WHERE public_id = ?', [accepted.wallet_reservation_id])
  check(hold?.status === 'reserved' && Number(hold.provider_cost_micros) === -1, 'missing actual SES per-email price retains unknown-cost wallet hold')
  await http(path + `/conversations/${firstThread.conversation_id}/reply`, 'POST', replyInput, owner)
  await dispatchChannelDelivery(Number(delivery.id))
  check(sends === 1, 'same operation replay never sends again')
  failure = 'unknown'
  const uncertain = await http(path + `/conversations/${firstThread.conversation_id}/reply`, 'POST', { body: 'Uncertain reply', idempotencyKey: 'email-unknown' }, owner)
  const uncertainRow = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [uncertain.data.delivery.id]))!
  await dispatchChannelDelivery(Number(uncertainRow.id)); await dispatchChannelDelivery(Number(uncertainRow.id))
  check(sends === 2 && (await one('SELECT status FROM support_channel_deliveries WHERE id = ?', [uncertainRow.id]))?.status === 'unknown', 'lost provider acknowledgement persists unknown without retrying POST')
  failure = 'rejected'
  const rejected = await http(path + `/conversations/${firstThread.conversation_id}/reply`, 'POST', { body: 'Rejected reply', idempotencyKey: 'email-rejected' }, owner)
  const rejectedRow = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [rejected.data.delivery.id]))!
  await dispatchChannelDelivery(Number(rejectedRow.id))
  check((await one('SELECT status FROM support_channel_deliveries WHERE id = ?', [rejectedRow.id]))?.status === 'rejected' && (await one('SELECT status FROM support_wallet_reservations WHERE public_id = ?', [rejectedRow.wallet_reservation_id]))?.status === 'released', 'confirmed SES rejection releases reservation without exposing provider body')
  failure = 'server_error'
  const serviceFailure = await http(path + `/conversations/${firstThread.conversation_id}/reply`, 'POST', { body: 'SES temporary service failure', idempotencyKey: 'email-503' }, owner)
  const serviceFailureRow = (await one('SELECT * FROM support_channel_deliveries WHERE public_id = ?', [serviceFailure.data.delivery.id]))!
  const before503 = sends
  await dispatchChannelDelivery(Number(serviceFailureRow.id)); await dispatchChannelDelivery(Number(serviceFailureRow.id))
  check(sends === before503 + 1 && (await one('SELECT status FROM support_channel_deliveries WHERE id = ?', [serviceFailureRow.id]))?.status === 'unknown', 'HTTP 503 is uncertain and never automatically resends POST')
  check((await one('SELECT status FROM support_wallet_reservations WHERE public_id = ?', [serviceFailureRow.wallet_reservation_id]))?.status === 'reserved', 'uncertain service failure keeps maximum-cost hold')
  await query("UPDATE support_email_receipts SET status = 'pending', lease_until = 0 WHERE id = ?", [receipt.id])
  const restart = await runIsolated('tests/fixtures/email-resume.ts', { args: [String(receipt.id)], env: { QUEUE_DRIVER: 'database' }, envFile: false, preload: [], timeoutMs: 25000 })
  assertIsolatedOk(restart, 'PASS restarted email worker')
  check((await query('SELECT * FROM support_channel_threads WHERE channel_id = ?', [channel.id])).length === 2 && Number((await one('SELECT inbound_id FROM support_email_receipts WHERE id = ?', [receipt.id]))!.inbound_id) === Number(receipt.inbound_id), 'new native queue process resumes retained MIME without duplicate inbox admission')
  source('mail-bounce-envelope')
  const bounceEnvelope = received('mail-bounce-envelope', config.inboundAddress)
  bounceEnvelope.mail.source = 'bounces@mailer.example.test'
  await http(inboundPath, 'POST', signed(bounceEnvelope))
  check((await applyLatest(channel)).status === 'processed', 'authenticated signed MIME From remains usable when SMTP envelope is a provider bounce address')
  rawSources.set('/incoming/mail-large', 'x'.repeat(8 * 1024 * 1024 + 1))
  await http(inboundPath, 'POST', signed(received('mail-large', config.inboundAddress)))
  const large = await applyLatest(channel)
  check(large.status === 'quarantined' && !Number(large.raw_bytes) && !Number(large.inbound_id), 'oversize private S3 source is bounded before archive allocation or inbox exposure')
  const badKey = received('mail-arbitrary-key', config.inboundAddress)
  badKey.receipt.action.objectKey = 'incoming/different-message'
  check((await http(inboundPath, 'POST', signed(badKey))).status === 422, 'signed source key must be exact prefix plus SES message identity')
  const beforeEmailContinuation = Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id]))!.used)
  await query("UPDATE support_conversations SET status = 'closed', resolved_at = ? WHERE id = ?", [Date.now() - 7 * 86400000 - 1000, firstThread.conversation_id])
  source('mail-late-reply', 'customer@example.test', 'Private attachment on continued email request', true)
  await http(inboundPath, 'POST', signed(received('mail-late-reply', replyAddress))); await applyLatest(channel)
  const advancedEmail = (await one('SELECT * FROM support_channel_threads WHERE id = ?', [firstThread.id]))!
  check(String(advancedEmail.conversation_id) !== String(firstThread.conversation_id) && Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id]))!.used) === beforeEmailContinuation + 1, 'signed original email reply capability admits exactly one late successor without merging another same-email thread')
  check(String((await one('SELECT continued_from_id FROM support_conversations WHERE id = ?', [advancedEmail.conversation_id]))!.continued_from_id) === String(firstThread.conversation_id) && Number((await one('SELECT COUNT(*) AS count FROM support_channel_conversations WHERE thread_id = ?', [firstThread.id]))!.count) === 2, 'email preserves original request binding and exact continuation lineage')
  check(Number((await one("SELECT COUNT(*) AS count FROM support_attachments WHERE conversation_id = ? AND contact_id = ? AND status = 'stored'", [advancedEmail.conversation_id, advancedEmail.contact_id]))!.count) === 1, 'signed late email attachment ingestion uses the successor and its exact private customer binding')
  const historicalEmail = await http(path + `/conversations/${firstThread.conversation_id}/reply`, 'POST', { body: 'Historical email operation after rollover', idempotencyKey: 'email-historical-after-rollover' }, owner)
  check(historicalEmail.status === 201 && String(historicalEmail.data.message.conversation_id) === String(firstThread.conversation_id), 'agent historical email reply remains bound to the original request rather than the current inbound pointer')
  const historicalPayload = { body: 'Historical email operation after rollover', idempotencyKey: 'email-historical-after-rollover' }
  const oldMessagePath = `/support/projects/${project.public_id}/conversations/${firstThread.conversation_id}/messages`, newMessagePath = `/support/projects/${project.public_id}/conversations/${advancedEmail.conversation_id}/messages`
  const wrongTarget = await http(newMessagePath, 'POST', historicalPayload, owner)
  check(wrongTarget.status === 409 && wrongTarget.data.error.code === 'idempotency_conflict', 'production agent HTTP rejects same key/body for another request sharing the provider thread')
  const historicalDelivery = (await one('SELECT * FROM support_channel_deliveries WHERE project_id = ? AND operation_key = ?', [project.id, historicalPayload.idempotencyKey]))!
  const legacyPayload = JSON.parse(String(historicalDelivery.payload)); delete legacyPayload._configuration
  await query('UPDATE support_channel_deliveries SET request_hash = ? WHERE id = ?', [digest(JSON.stringify({ channel: rawChannel.id, thread: firstThread.id, payload: legacyPayload })), historicalDelivery.id])
  const legacyReplay = await http(oldMessagePath, 'POST', historicalPayload, owner)
  check(legacyReplay.status === 201 && legacyReplay.data.message.id === historicalEmail.data.message.id && String(legacyReplay.data.message.conversation_id) === String(firstThread.conversation_id), 'legacy operation fingerprint replays only its immutable original stored message target')
  check((await http(newMessagePath, 'POST', historicalPayload, owner)).status === 409, 'legacy fingerprint cannot relabel an old message as a successor message')
  const racingPayload = { body: 'Concurrent identical provider operation on different requests', idempotencyKey: 'email-shared-thread-request-race' }
  const racing = await Promise.all([http(oldMessagePath, 'POST', racingPayload, owner), http(newMessagePath, 'POST', racingPayload, owner)])
  check(racing.map(result => result.status).sort().join(',') === '201,409', 'concurrent old/new requests commit one provider operation and refuse the other selected target')
  const winning = racing.find(result => result.status === 201)!, immutable = (await one('SELECT conversation_id FROM support_messages WHERE id = ?', [winning.data.message.id]))!
  check(String(winning.data.message.conversation_id) === String(immutable.conversation_id) && Number((await one('SELECT COUNT(*) AS count FROM support_channel_deliveries WHERE project_id = ? AND operation_key = ?', [project.id, racingPayload.idempotencyKey]))!.count) === 1, 'concurrent replay response target and durable delivery remain exactly the stored message destination')

  await query("UPDATE support_conversations SET status = 'closed', resolved_at = ? WHERE id = ?", [Date.now() - 8 * 86400000, advancedEmail.conversation_id])
  const acceptedEmailMeter = Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id]))!.used)
  source('mail-within-window-delayed')
  await http(inboundPath, 'POST', signed(received('mail-within-window-delayed', replyAddress)))
  const acceptedEmail = (await one('SELECT id FROM support_email_receipts WHERE ses_message_id = ?', ['mail-within-window-delayed']))!
  const firstAcceptedAt = Date.now() - 2 * 86400000
  await query('UPDATE support_email_receipts SET created_at = ? WHERE id = ?', [new Date(firstAcceptedAt).toISOString(), acceptedEmail.id])
  await applyLatest(channel)
  const normalizedEmail = (await one('SELECT created_at FROM support_inbound WHERE id = (SELECT inbound_id FROM support_email_receipts WHERE id = ?)', [acceptedEmail.id]))!
  const normalizedAcceptedAt = normalizedEmail.created_at instanceof Date ? normalizedEmail.created_at.getTime() : new Date(String(normalizedEmail.created_at)).getTime()
  check(normalizedAcceptedAt === firstAcceptedAt && String((await one('SELECT conversation_id FROM support_channel_threads WHERE id = ?', [firstThread.id]))!.conversation_id) === String(advancedEmail.conversation_id) && Number((await one("SELECT used FROM support_usage WHERE workspace_id = ? AND meter = 'conversations'", [project.workspace_id]))!.used) === acceptedEmailMeter, 'delayed MIME processing preserves the first verified server email receipt time for quota-free reopening')
  console.log(`PASS email HTTP and MIME (${checks} checks)`)
}
finally { server.stop(true) }
