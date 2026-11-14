import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ChannelConsent', table: 'support_channel_consents',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [{ name: 'support_channel_consent_recipient', columns: ['channel_id', 'recipient'], unique: true }],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    recipient: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.enum(['opted_out', 'opted_in']) } },
    providerEventId: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    eventAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
