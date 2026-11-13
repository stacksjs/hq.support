import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Event',
  table: 'support_events',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    event: { fillable: true, required: true, validation: { rule: schema.string() } },
    attributes: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '{}' },
  },
} as const)
