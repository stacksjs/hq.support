import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EnterpriseRetentionHold',
  table: 'support_enterprise_retention_holds',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_enterprise_retention_hold', columns: ['workspace_id', 'conversation_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    reason: { fillable: true, required: true, validation: { rule: schema.string() } },
    active: { fillable: true, required: true, default: false, validation: { rule: schema.boolean() } },
  },
} as const)
