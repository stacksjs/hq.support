import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Conversation',
  table: 'support_conversations',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    contactId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    subject: { fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'open' },
    assigneeId: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    unreadCount: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    channel: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'widget' },
    aiTurns: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    aiTokens: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    aiChargedPeriod: { fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
  },
} as const)
