import type { Row } from './database'
import type { EmailDependencies } from './support-email'
import { channelConfig, loadChannel } from './channels'
import { deliveryChannelThread } from './channel-history'
import { one, workspaceTransaction } from './database'
import { verifyEmailNotification } from './email-receipts'
import { fail } from './errors'
import { deliveryCredentials, recordChannelAcceptance, writeDeliveryStatus } from './managed-channels'
import { object } from './service'
import { emailAddress, emailDispatchId, emailDispatchTagName, emailPolicy } from './support-email'

export async function acceptEmailSendNotification(channel: Row, envelope: Row, dependencies: EmailDependencies) {
  if (channel.provider !== 'email' || channel.status !== 'ready') fail(503, 'email_channel_unavailable', 'Verify an active email channel first.')
  const policy = emailPolicy(channel, await channelConfig(channel))
  if (!policy.outbound) fail(503, 'email_unconfigured', 'Configure an outbound SES event destination first.')
  const notification = await verifyEmailNotification(envelope, { region: policy.region, topicArn: policy.outbound.topicArn }, dependencies)
  const mail = object(notification.mail), tags = object(mail.tags)
  const [configurationSet] = Array.isArray(tags['ses:configuration-set']) ? tags['ses:configuration-set'] : []
  const dispatchTags = tags[emailDispatchTagName]
  const providerId = mail.messageId, sentAt = Date.parse(String(mail.timestamp))
  if (notification.eventType !== 'Send' || mail.sendingAccountId !== policy.accountId || configurationSet !== policy.outbound.configurationSet || typeof providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(providerId) || !Number.isFinite(sentAt) || sentAt > Date.now() + 300000 || !Array.isArray(mail.destination) || mail.destination.length !== 1 || !Array.isArray(dispatchTags) || dispatchTags.length !== 1) fail(422, 'email_send_notification_invalid', 'SES event must identify one send in the configured AWS account and configuration set.')
  const recipient = emailAddress(mail.destination[0])
  const id = emailDispatchId(channel, dispatchTags[0], recipient)
  const project = (await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [channel.project_id, channel.workspace_id]))!
  return await workspaceTransaction(Number(channel.workspace_id), async () => {
    const fresh = await loadChannel(project, channel.id)
    if (fresh.configuration !== channel.configuration || fresh.status !== 'ready') fail(409, 'email_channel_changed', 'Email connection changed during signature verification.')
    const delivery = await one('SELECT * FROM support_channel_deliveries WHERE public_id = ? AND channel_id = ? AND project_id = ? AND workspace_id = ?', [id, channel.id, project.id, project.workspace_id])
    if (!delivery) fail(403, 'email_dispatch_mismatch', 'SES send evidence does not authorize this delivery.')
    const thread = await deliveryChannelThread(project, delivery)
    const credentials = await deliveryCredentials(delivery, channel)
    if (emailAddress(thread.recipient) !== recipient || emailAddress(credentials.fromAddress) !== emailAddress(mail.source)) fail(403, 'email_dispatch_mismatch', 'SES sender or recipient differs from this exact delivery.')
    if (delivery.provider_message_id === providerId) return { duplicate: true }
    if (delivery.provider_message_id || !['dispatching', 'unknown'].includes(String(delivery.status)) || Number(delivery.attempts) < 1) fail(409, 'email_send_receipt_conflict', 'SES send evidence conflicts with the recorded delivery.')
    await recordChannelAcceptance(project, delivery, sentAt)
    const status = delivery.wallet_reservation_id ? 'cost_pending' : 'accepted'
    await writeDeliveryStatus(delivery, status, providerId, { outcome: 'accepted', source: 'ses-sns-send', notificationId: envelope.MessageId, sentAt })
    return { duplicate: false }
  })
}
