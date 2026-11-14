import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Message',
  table: 'support_messages',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_message_thread', columns: ['project_id', 'conversation_id', 'id'] },
    { name: 'support_message_public_activity', columns: ['workspace_id', 'project_id', 'conversation_id', 'contact_id', 'visibility', 'created_at'] },
  ],
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
