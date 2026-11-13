import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Channel',
  table: 'support_channels',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    provider: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'unconfigured' },
    configuration: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '{}' },
  },
} as const)
