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
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    provider: { fillable: true, required: true, validation: { rule: schema.string() } },
    providerEventId: { fillable: true, required: true, validation: { rule: schema.string() } },
    payload: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'pending' },
    lastError: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
  },
} as const)
