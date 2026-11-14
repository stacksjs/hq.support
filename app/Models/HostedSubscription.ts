import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'HostedSubscription', table: 'support_subscriptions',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [{ name: 'support_subscription_workspace', columns: ['workspace_id'], unique: true }],
  attributes: {
    workspaceId: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    checkoutId: { foreignKey: false, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    providerId: { foreignKey: false, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    providerCustomer: { foreignKey: false, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    status: { foreignKey: false, fillable: true, required: true, default: 'pending', validation: { rule: schema.string() } },
    plan: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    interval: { foreignKey: false, fillable: true, required: true, default: 'month', validation: { rule: schema.string() } },
    currentPeriodEnd: { type: 'bigint', foreignKey: false, fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    cancelAtPeriodEnd: { foreignKey: false, fillable: true, required: true, default: false, validation: { rule: schema.boolean() } },
    syncVersion: { type: 'bigint', foreignKey: false, fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
  },
} as const)
