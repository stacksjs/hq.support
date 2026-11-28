import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PhoneAgentDial',
  table: 'support_phone_agent_dials',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_phone_agent_dial_scope', columns: ['call_id', 'agent_id'], unique: true },
    { name: 'support_phone_agent_dial_membership', columns: ['workspace_id', 'agent_id'] },
    { name: 'support_phone_agent_dial_due', columns: ['finished_at', 'available_at', 'lease_until'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    callId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    agentId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    revokedAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    finishedAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    availableAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    leaseUntil: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    progressRevision: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    lastError: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
  },
} as const)
