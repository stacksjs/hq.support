import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'TicketSlaEscalation',
  table: 'support_ticket_sla_escalations',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_ticket_sla_metric_unique', columns: ['clock_id', 'metric'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    clockId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    ticketId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    metric: { fillable: true, required: true, validation: { rule: schema.string() } },
    deadlineAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    processedAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    outboxId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
