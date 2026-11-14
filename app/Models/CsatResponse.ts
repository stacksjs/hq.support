import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'CsatResponse', table: 'support_csat_responses', traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [
    { name: 'support_csat_response_conversation', columns: ['conversation_id'], unique: true },
    { name: 'support_csat_response_report', columns: ['workspace_id', 'project_id', 'created_at'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', required: true, fillable: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', required: true, fillable: true, foreignKey: { table: 'support_projects', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    conversationId: { type: 'bigint', required: true, fillable: true, foreignKey: { table: 'support_conversations', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    contactId: { type: 'bigint', required: true, fillable: true, foreignKey: { table: 'support_contacts', onDelete: 'cascade' }, validation: { rule: schema.number().integer() } },
    settingRevision: { type: 'bigint', required: true, fillable: true, validation: { rule: schema.number().integer() } },
    question: { required: true, fillable: true, validation: { rule: schema.string() } },
    score: { type: 'bigint', required: true, fillable: true, validation: { rule: schema.number().integer().min(1).max(5) } },
    comment: { type: 'text', required: true, fillable: true, default: '', validation: { rule: schema.string() } },
  },
} as const)
