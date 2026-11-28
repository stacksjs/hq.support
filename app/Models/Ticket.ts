import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Ticket',
  table: 'support_tickets',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_customer_ticket_cursor', columns: ['workspace_id', 'project_id', 'contact_id', 'kind', 'id'] }],
  attributes: {
    typeId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    kind: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'customer' },
    state: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'open' },
    customFields: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() }, default: '{}' },
    typeSnapshot: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() }, default: '{}' },
    slaCycle: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 1 },
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
