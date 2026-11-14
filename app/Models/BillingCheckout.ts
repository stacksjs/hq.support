import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'BillingCheckout', table: 'support_billing_checkouts',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [
    { name: 'billing_checkout_operation', columns: ['workspace_id', 'operation_key'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    publicId: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    operationKey: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    kind: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    amountCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    plan: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    interval: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: 'month' },
    status: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: 'creating' },
    providerSession: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    providerPayment: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    providerCustomer: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    providerSubscription: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    url: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    refundedCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
