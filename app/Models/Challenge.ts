import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Challenge',
  table: 'support_challenges',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    origin: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    ownerId: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    frameworkVersion: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    attempts: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },

    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    digest: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    kind: { fillable: true, required: true, validation: { rule: schema.string() } },
    expiresAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    consumedAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
