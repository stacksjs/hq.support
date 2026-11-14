import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'WalletEntry', table: 'support_wallet_entries',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [
    { name: 'wallet_entry_reference', columns: ['workspace_id', 'reference'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    reference: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    kind: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    amountCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    balanceCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    provider: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    providerReference: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
