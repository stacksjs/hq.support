import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PhoneEvent',
  table: 'support_phone_events',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_phone_event_digest', columns: ['call_id', 'digest'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    callId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    digest: { fillable: true, required: true, validation: { rule: schema.string() } },
    sequence: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() } },
    payload: { fillable: true, required: true, validation: { rule: schema.string() }, type: 'text', default: '{}' },
  },
} as const)
