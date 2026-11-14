import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'TicketSlaClock',
  table: 'support_ticket_sla_clocks',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_ticket_sla_cycle_unique', columns: ['ticket_id', 'cycle'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    ticketId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    cycle: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 1 },
    snapshot: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() }, default: '{}' },
    phase: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'running' },
    anchorAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    firstRemainingMs: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    resolutionRemainingMs: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    firstDueAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    resolutionDueAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    firstResponseAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    resolvedAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    firstBreachedAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    resolutionBreachedAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
