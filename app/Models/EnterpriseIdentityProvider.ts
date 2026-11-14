import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EnterpriseIdentityProvider',
  table: 'support_enterprise_providers',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_enterprise_provider_workspace', columns: ['workspace_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    publicId: { fillable: true, required: true, validation: { rule: schema.string() }, unique: true },
    protocol: { fillable: true, required: true, validation: { rule: schema.string() } },
    issuer: { fillable: true, required: true, validation: { rule: schema.string() } },
    clientId: { fillable: true, required: true, validation: { rule: schema.string() } },
    enabled: { fillable: true, required: true, default: true, validation: { rule: schema.boolean() } },
  },
} as const)
