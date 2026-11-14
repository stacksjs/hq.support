import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'PhoneOperation',
  table: 'support_phone_operations',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_phone_operation_key', columns: ['workspace_id', 'key'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    key: { fillable: true, required: true, validation: { rule: schema.string() }, type: 'text', default: '' },
    fingerprint: { fillable: true, required: true, validation: { rule: schema.string() } },
    state: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'pending' },
    outcome: { fillable: true, required: true, validation: { rule: schema.string() }, type: 'text', default: '{}' },
  },
} as const)
