import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'WorkflowRun',
  table: 'support_workflow_runs',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_workflow_event', columns: ['workflow_id', 'event_id'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    workflowId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    eventId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'pending' },
    cursor: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    availableAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    lastError: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
  },
} as const)
