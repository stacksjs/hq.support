import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

/** Immutable historical conversation binding; ChannelThread points at the current request. */
export default defineModel({
  name: 'ChannelConversation',
  table: 'support_channel_conversations',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_channel_conversation_identity', columns: ['workspace_id', 'project_id', 'channel_id', 'conversation_id'], unique: true },
    { name: 'support_channel_conversation_thread', columns: ['workspace_id', 'project_id', 'thread_id'] },
  ],
  attributes: {
    workspaceId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    threadId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
