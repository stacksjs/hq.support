import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Usage',
  table: 'support_usage',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_usage_meter', columns: ['workspace_id', 'period', 'meter'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    period: { fillable: true, required: true, validation: { rule: schema.string() } },
    meter: { fillable: true, required: true, validation: { rule: schema.string() } },
    used: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
