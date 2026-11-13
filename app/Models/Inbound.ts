import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Inbound',
  table: 'support_inbound',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_inbound_provider_event', columns: ['project_id', 'provider', 'provider_event_id'], unique: true },
  ],
  attributes: {
    attempts: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    leaseToken: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    leaseUntil: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    availableAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    provider: { fillable: true, required: true, validation: { rule: schema.string() } },
    providerEventId: { fillable: true, required: true, validation: { rule: schema.string() } },
    payload: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'pending' },
    lastError: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
  },
} as const)
