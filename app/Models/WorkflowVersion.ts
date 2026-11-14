import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'WorkflowVersion',
  table: 'support_workflow_versions',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_workflow_versions_identity', columns: ['workflow_id', 'version'], unique: true }],
  attributes: {
    workspaceId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    workflowId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    version: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    event: { fillable: true, required: true, validation: { rule: schema.string() } },
    definition: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
    publishedBy: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
  },
} as const)
