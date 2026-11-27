import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'CustomerPresence',
  table: 'support_customer_presences',
  traits: { useTimestamps: false },
  dashboard: { access: false },
  indexes: [
    { name: 'support_customer_presence_tab', columns: ['session_id', 'tab_id'], unique: true },
    { name: 'support_customer_presence_conversation', columns: ['workspace_id', 'project_id', 'conversation_id', 'expires_at'] },
    { name: 'support_customer_presence_expiry', columns: ['expires_at'] },
  ],
  attributes: {
    workspaceId: { foreignKey: false, type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    projectId: { foreignKey: false, type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    conversationId: { foreignKey: false, type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    sessionId: { foreignKey: false, type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    tabId: { foreignKey: false, required: true, validation: { rule: schema.string() } },
    sequence: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    state: { required: true, validation: { rule: schema.enum(['composing', 'away']) } },
    expiresAt: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
  },
} as const)
