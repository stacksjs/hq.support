import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Idempotency',
  table: 'support_idempotency',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_idempotency_operation', columns: ['project_id', 'operation', 'key'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    operation: { fillable: true, required: true, validation: { rule: schema.string() } },
    key: { fillable: true, required: true, validation: { rule: schema.string() } },
    fingerprint: { fillable: true, required: true, validation: { rule: schema.string() } },
    response: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
  },
} as const)
