import type { Row } from './database'
import type { EmailDependencies } from './support-email'
import { channelConfig, loadChannel } from './channels'
import { deliveryChannelThread } from './channel-history'
import { one, query, workspaceTransaction } from './database'
import { verifyEmailNotification } from './email-receipts'
import { fail } from './errors'
import { deliveryCredentials, recordChannelAcceptance, writeDeliveryStatus } from './managed-channels'
import { digest, object } from './service'
import { emailAddress, emailDispatchId, emailDispatchTagName, emailPolicy, matchesSesBillingScope, sesBillingScope } from './support-email'

/** Record one invoice-eligible send without writing to the wallet. */
async function retainSesSendEvidence(
  delivery: Row,
  scope: NonNullable<ReturnType<typeof sesBillingScope>>,
  providerId: string,
  sentAt: number,
  envelope: Row,
): Promise<void> {
  const now = new Date().toISOString()
  const inserted = await query(
    `INSERT INTO support_ses_send_evidence
      (workspace_id, project_id, channel_id, delivery_id, account_id, region, configuration_set,
       provider_message_id, notification_id, event_sha256, sent_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING RETURNING id`,
    [delivery.workspace_id, delivery.project_id, delivery.channel_id, delivery.id, scope.accountId, scope.region, scope.configurationSet, providerId, envelope.MessageId, digest(String(envelope.Message)), sentAt, now, now],
  )
  if (inserted.length > 0) return

  const existing = await one('SELECT * FROM support_ses_send_evidence WHERE delivery_id = ? AND workspace_id = ? AND project_id = ? AND channel_id = ?',
    [delivery.id, delivery.workspace_id, delivery.project_id, delivery.channel_id])
  if (!existing || existing.account_id !== scope.accountId || existing.region !== scope.region || existing.configuration_set !== scope.configurationSet || existing.provider_message_id !== providerId || Number(existing.sent_at) !== sentAt)
    fail(409, 'ses_billing_evidence_conflict', 'SES billing evidence conflicts with a recorded send.')
}

export async function acceptEmailSendNotification(channel: Row, envelope: Row, dependencies: EmailDependencies) {
  if (channel.provider !== 'email' || channel.status !== 'ready') fail(503, 'email_channel_unavailable', 'Verify an active email channel first.')
  const policy = emailPolicy(channel, await channelConfig(channel))
  const scope = sesBillingScope(policy)
  if (!scope) fail(503, 'email_unconfigured', 'Configure an outbound SES event destination first.')
  const notification = await verifyEmailNotification(envelope, { region: policy.region, topicArn: scope.topicArn }, dependencies)
  const mail = object(notification.mail), tags = object(mail.tags)
  const [configurationSet] = Array.isArray(tags['ses:configuration-set']) ? tags['ses:configuration-set'] : []
  const dispatchTags = tags[emailDispatchTagName]
  const providerId = mail.messageId, sentAt = Date.parse(String(mail.timestamp))
  if (notification.eventType !== 'Send' || mail.sendingAccountId !== policy.accountId || configurationSet !== scope.configurationSet || typeof providerId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(providerId) || !Number.isFinite(sentAt) || sentAt <= 0 || sentAt > Date.now() + 300000 || !Array.isArray(mail.destination) || mail.destination.length !== 1 || !Array.isArray(dispatchTags) || dispatchTags.length !== 1) fail(422, 'email_send_notification_invalid', 'SES event must identify one send in the configured AWS account and configuration set.')
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
    const alreadyAccepted = delivery.provider_message_id === providerId
    if (!alreadyAccepted && (delivery.provider_message_id || !['dispatching', 'unknown'].includes(String(delivery.status)) || Number(delivery.attempts) < 1)) fail(409, 'email_send_receipt_conflict', 'SES send evidence conflicts with the recorded delivery.')
    const dispatchScope = object(JSON.parse(String(delivery.payload)))._sesBillingScope
    if (dispatchScope !== undefined) {
      if (!matchesSesBillingScope(dispatchScope, scope))
        fail(409, 'ses_billing_scope_changed', 'SES billing evidence does not match the recorded dispatch pool.')
      await retainSesSendEvidence(delivery, scope, providerId, sentAt, envelope)
    }
    if (alreadyAccepted) return { duplicate: true }
    await recordChannelAcceptance(project, delivery, { at: sentAt, slaAt: sentAt })
    const status = delivery.wallet_reservation_id ? 'cost_pending' : 'accepted'
    await writeDeliveryStatus(delivery, status, providerId, { outcome: 'accepted', source: 'ses-sns-send', notificationId: envelope.MessageId, sentAt })
    return { duplicate: false }
  })
}
