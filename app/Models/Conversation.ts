import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Conversation',
  table: 'support_conversations',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_conversation_cursor', columns: ['project_id', 'id'] }, { name: 'support_conversation_capacity', columns: ['workspace_id', 'assignee_id', 'status'] }, { name: 'support_conversation_inbox', columns: ['project_id', 'inbox_id', 'status'] }],
  attributes: {
    teamId: { foreignKey: false, type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    inboxId: { foreignKey: false, type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    routingReason: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    subject: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'open' },
    assigneeId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    unreadCount: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    channel: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'widget' },
    aiTurns: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    aiTokens: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    aiChargedPeriod: { fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
