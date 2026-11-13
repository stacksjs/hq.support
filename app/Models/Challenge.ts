import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Challenge',
  table: 'support_challenges',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    digest: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    kind: { fillable: true, required: true, validation: { rule: schema.string() } },
    expiresAt: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    consumedAt: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
