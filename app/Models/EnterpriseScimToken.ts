import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EnterpriseScimToken',
  table: 'support_enterprise_scim_tokens',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    providerId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    digest: { fillable: true, required: true, validation: { rule: schema.string() }, unique: true, hidden: true },
    expiresAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    revokedAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
