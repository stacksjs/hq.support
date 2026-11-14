import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ChannelThread',
  table: 'support_channel_threads',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_channel_thread_identity', columns: ['project_id', 'channel_id', 'remote_key'], unique: true },
  ],
  attributes: {
    workspaceId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    remoteKey: { fillable: true, required: true, validation: { rule: schema.string() } },
    contactId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    recipient: { fillable: true, required: true, validation: { rule: schema.string() } },
    lastInboundAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    consent: { fillable: true, required: true, default: 'reply_only', validation: { rule: schema.string() } },
  },
} as const)
