import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'AssignmentAudit',
  table: 'support_assignment_audits',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_assignment_audit_cursor', columns: ['project_id', 'conversation_id', 'id'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    conversationId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    actorId: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    workflowRunId: { foreignKey: false, type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    source: { fillable: true, required: true, validation: { rule: schema.string() } },
    reason: { fillable: true, required: true, validation: { rule: schema.string() } },
    beforeState: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() } },
    afterState: { type: 'text', fillable: true, required: true, validation: { rule: schema.string() } },
  },
} as const)
