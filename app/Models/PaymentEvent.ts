import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PaymentEvent', table: 'support_payment_events',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [
    { name: 'payment_event_reference', columns: ['provider_event_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    providerEventId: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    digest: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    kind: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
  },
} as const)
