import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'ChannelCursor', table: 'support_channel_cursors',
  traits: { useTimestamps: true }, dashboard: { access: false },
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { type: 'bigint', unique: true, fillable: true, required: true, validation: { rule: schema.number().integer() } },
    cursor: { fillable: true, required: true, default: '0', validation: { rule: schema.string() } },
    leaseToken: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    leaseUntil: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
  },
} as const)
