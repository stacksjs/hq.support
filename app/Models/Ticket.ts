import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Ticket',
  table: 'support_tickets',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
    title: { fillable: true, required: true, validation: { rule: schema.string() } },
    description: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'open' },
    priority: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'normal' },
    assigneeId: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    dueAt: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
