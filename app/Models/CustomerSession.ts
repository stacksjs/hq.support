import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'CustomerSession',
  table: 'support_customer_sessions',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    digest: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    expiresAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
