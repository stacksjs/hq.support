import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'TicketSlaPolicy',
  table: 'support_ticket_sla_policies',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    calendarId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    firstResponseMinutes: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    resolutionMinutes: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    pauseStates: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() }, default: '["pending"]' },
    escalationAssigneeId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
