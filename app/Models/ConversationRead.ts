import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ConversationRead',
  table: 'support_conversation_reads',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_conversation_reads_identity', columns: ['conversation_id', 'user_id'], unique: true }],
  attributes: {
    workspaceId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    conversationId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    userId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    lastMessageId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
  },
} as const)
