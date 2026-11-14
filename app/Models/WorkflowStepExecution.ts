import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'WorkflowStepExecution',
  table: 'support_workflow_steps',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_workflow_steps_identity', columns: ['workflow_run_id', 'step_id'], unique: true }],
  attributes: {
    workspaceId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    workflowRunId: { fillable: true, required: true, type: 'bigint', validation: { rule: schema.number().integer() } },
    stepId: { fillable: true, required: true, validation: { rule: schema.string() } },
    type: { fillable: true, required: true, validation: { rule: schema.string() } },
    result: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
  },
} as const)
