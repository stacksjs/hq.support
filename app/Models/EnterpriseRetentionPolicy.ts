import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EnterpriseRetentionPolicy',
  table: 'support_enterprise_retention_policies',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_enterprise_retention_workspace', columns: ['workspace_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    days: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    enabled: { fillable: true, required: true, default: false, validation: { rule: schema.boolean() } },
    lastRunAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
