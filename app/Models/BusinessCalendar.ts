import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'BusinessCalendar',
  table: 'support_business_calendars',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    timeZone: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'UTC' },
    definition: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() }, default: '{}' },
  },
} as const)
