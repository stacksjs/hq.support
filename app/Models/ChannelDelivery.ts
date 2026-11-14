import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ChannelDelivery',
  table: 'support_channel_deliveries',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_channel_delivery_operation', columns: ['project_id', 'operation_key'], unique: true },
    { name: 'support_channel_delivery_pending', columns: ['status', 'available_at', 'lease_until'] },
  ],
  attributes: {
    publicId: { unique: true, fillable: true, required: true, validation: { rule: schema.string() } },
    payload: { hidden: true, type: 'text', fillable: true, required: true, default: '{}', validation: { rule: schema.string() } },
    workspaceId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    threadId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    messageId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    operationKey: { fillable: true, required: true, validation: { rule: schema.string() } },
    requestHash: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, default: 'pending', validation: { rule: schema.string() } },
    configurationHash: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    providerMessageId: { foreignKey: false, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    walletReservationId: { foreignKey: false, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    reservedCents: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    providerCostMicros: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    providerCurrency: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    attempts: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    leaseToken: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    leaseUntil: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    availableAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    lastError: { type: 'text', fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    receipt: { type: 'text', fillable: true, required: true, default: '{}', validation: { rule: schema.string() } },
  },
} as const)
