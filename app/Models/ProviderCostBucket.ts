import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ProviderCostBucket', table: 'support_provider_cost_buckets',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [{ name: 'support_provider_cost_bucket', columns: ['workspace_id', 'provider', 'period'], unique: true }],
  attributes: {
    workspaceId: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    provider: { required: true, validation: { rule: schema.string() } },
    period: { required: true, validation: { rule: schema.string() } },
    providerCostMicros: { type: 'bigint', foreignKey: false, required: true, default: 0, validation: { rule: schema.number().integer() } },
    chargedCents: { type: 'bigint', foreignKey: false, required: true, default: 0, validation: { rule: schema.number().integer() } },
    rateVersion: { required: true, default: '2026-11-v1', validation: { rule: schema.string() } },
  },
} as const)
