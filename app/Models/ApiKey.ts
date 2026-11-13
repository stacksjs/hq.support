import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ApiKey',
  table: 'support_api_keys',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    digest: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    scope: { fillable: true, required: true, validation: { rule: schema.string() } },
    revokedAt: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
