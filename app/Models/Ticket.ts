import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Ticket',
  table: 'support_tickets',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { type: 'bigint', fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
    title: { fillable: true, required: true, validation: { rule: schema.string() } },
    description: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'open' },
    priority: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'normal' },
    assigneeId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    dueAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
