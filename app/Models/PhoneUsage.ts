import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PhoneUsage',
  table: 'support_phone_usage',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_phone_usage_identity', columns: ['call_id', 'response_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    callId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    responseId: { fillable: true, required: true, validation: { rule: schema.string() } },
    usage: { fillable: true, required: true, validation: { rule: schema.string() }, type: 'text', default: '{}' },
    costMicros: { type: 'bigint', fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
  },
} as const)
