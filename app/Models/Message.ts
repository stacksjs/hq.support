import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Message',
  table: 'support_messages',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    body: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
    visibility: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'public' },
    authorType: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'customer' },
    authorId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    deliveryStatus: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'stored' },
  },
} as const)
