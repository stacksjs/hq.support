import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'WalletReservation', table: 'support_wallet_reservations',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [
    { name: 'wallet_reservation_operation', columns: ['workspace_id', 'operation_key'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    publicId: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    operationKey: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    provider: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    reservedCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    actualCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    status: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: 'reserved' },
    providerReference: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
