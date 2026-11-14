import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EnterpriseDirectoryGroup',
  table: 'support_enterprise_groups',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_enterprise_group_external', columns: ['provider_id', 'external_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    providerId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    externalId: { fillable: true, required: true, validation: { rule: schema.string() } },
    displayName: { fillable: true, required: true, validation: { rule: schema.string() } },
    members: { fillable: true, required: true, validation: { rule: schema.string() }, type: 'text', default: '[]' },
  },
} as const)
