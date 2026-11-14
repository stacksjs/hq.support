import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'TicketRelation',
  table: 'support_ticket_relations',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_ticket_relation_unique', columns: ['ticket_id', 'related_ticket_id', 'kind'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    ticketId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    relatedTicketId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    kind: { fillable: true, required: true, validation: { rule: schema.string() } },
  },
} as const)
