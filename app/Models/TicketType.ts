import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'TicketType',
  table: 'support_ticket_types',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    kind: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'customer' },
    opensConversation: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    fields: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() }, default: '[]' },
    states: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() }, default: '[]' },
    slaPolicyId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
