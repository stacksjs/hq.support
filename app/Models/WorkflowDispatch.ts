import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'WorkflowDispatch',
  table: 'support_workflow_dispatches',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_workflow_dispatches_identity', columns: ['project_id', 'source_id'], unique: true }],
  attributes: {
    workspaceId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    sourceId: { fillable: true, required: true, validation: { rule: schema.string() } },
    eventId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    depth: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
  },
} as const)
