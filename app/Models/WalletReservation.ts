import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'WalletReservation', table: 'support_wallet_reservations',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [
    { name: 'wallet_reservation_operation', columns: ['workspace_id', 'operation_key'], unique: true },
    { name: 'wallet_reservation_project_period', columns: ['workspace_id', 'project_id', 'created_at'] },
  ],
  attributes: {
    providerCostMicros: { type: 'bigint', foreignKey: false, fillable: true, required: true, default: -1, validation: { rule: schema.number().integer() } },
    workspaceId: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', foreignKey: false, fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    publicId: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    operationKey: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    provider: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    reservedCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    actualCents: { type: 'bigint', foreignKey: false, fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    status: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: 'reserved' },
    providerReference: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
