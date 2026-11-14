import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PhoneToolResult',
  table: 'support_phone_tool_results',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_phone_tool_identity', columns: ['call_id', 'tool_call_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    callId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    toolCallId: { fillable: true, required: true, validation: { rule: schema.string() } },
    fingerprint: { fillable: true, required: true, validation: { rule: schema.string() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    result: { fillable: true, required: true, validation: { rule: schema.string() }, type: 'text', default: '{}' },
  },
} as const)
