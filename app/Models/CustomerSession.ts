import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'CustomerSession',
  table: 'support_customer_sessions',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    digest: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    expiresAt: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
