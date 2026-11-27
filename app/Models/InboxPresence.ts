import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'InboxPresence',
  table: 'support_inbox_presences',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_inbox_presence_tab', columns: ['workspace_id', 'user_id', 'tab_id'], unique: true },
    { name: 'support_inbox_presence_conversation', columns: ['workspace_id', 'project_id', 'conversation_id', 'expires_at'] },
    { name: 'support_inbox_presence_expiry', columns: ['expires_at'] },
  ],
  attributes: {
    workspaceId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    userId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    tabId: { foreignKey: false, fillable: true, required: true, validation: { rule: schema.string() } },
    sequence: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    state: { fillable: true, required: true, validation: { rule: schema.enum(['viewing', 'composing', 'away']) } },
    expiresAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
