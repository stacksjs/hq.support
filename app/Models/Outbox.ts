import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Outbox',
  table: 'support_outbox',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    workspaceId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    eventId: { foreignKey: false, fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    kind: { fillable: true, required: true, validation: { rule: schema.string() } },
    payload: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() } },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'pending' },
    attempts: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    availableAt: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    leaseToken: { fillable: true, required: true, validation: { rule: schema.string() }, default: '' },
    leaseUntil: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    lastError: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '' },
  },
} as const)
