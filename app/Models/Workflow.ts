import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Workflow',
  table: 'support_workflows',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    event: { fillable: true, required: true, validation: { rule: schema.string() } },
    enabled: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    definition: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '{}' },
  },
} as const)
