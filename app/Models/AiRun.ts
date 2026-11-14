import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'AiRun',
  table: 'support_ai_runs',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_ai_request', columns: ['project_id', 'actor_scope', 'key'], unique: true },
    { name: 'support_ai_conversation', columns: ['project_id', 'conversation_id', 'status'] },
  ],
  attributes: {
    workspaceId: { required: true, validation: { rule: schema.number().integer() } },
    projectId: { required: true, validation: { rule: schema.number().integer() } },
    conversationId: { required: true, validation: { rule: schema.number().integer() } },
    actorScope: { required: true, validation: { rule: schema.string() } },
    key: { required: true, validation: { rule: schema.string() } },
    fingerprint: { required: true, validation: { rule: schema.string() } },
    status: { required: true, default: 'pending', validation: { rule: schema.string() } },
    period: { required: true, validation: { rule: schema.string() } },
    previousPeriod: { required: true, default: '', validation: { rule: schema.string() } },
    ownerToken: { required: true, validation: { rule: schema.string() } },
    leaseUntil: { required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    reservedTokens: { required: true, validation: { rule: schema.number().integer() } },
    actualTokens: { required: true, default: 0, validation: { rule: schema.number().integer() } },
    chargedUnit: { required: true, default: false, validation: { rule: schema.boolean() } },
    response: { required: true, default: '', type: 'text', validation: { rule: schema.string() } },
    errorCode: { required: true, default: '', validation: { rule: schema.string() } },
  },
} as const)
