import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SesSendEvidence',
  table: 'support_ses_send_evidence',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'ses_evidence_delivery', columns: ['delivery_id'], unique: true },
    { name: 'ses_evidence_provider', columns: ['account_id', 'region', 'provider_message_id'], unique: true },
    { name: 'ses_evidence_period', columns: ['account_id', 'region', 'sent_at'] },
  ],
  attributes: {
    workspaceId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    deliveryId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    accountId: { fillable: true, required: true, validation: { rule: schema.string() } },
    region: { fillable: true, required: true, validation: { rule: schema.string() } },
    configurationSet: { fillable: true, required: true, validation: { rule: schema.string() } },
    providerMessageId: { fillable: true, required: true, validation: { rule: schema.string() } },
    notificationId: { fillable: true, required: true, validation: { rule: schema.string() } },
    eventSha256: { fillable: true, required: true, validation: { rule: schema.string() } },
    sentAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
