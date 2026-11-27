import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Project',
  table: 'support_projects',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    buddyConnectedAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    verifiedOrigin: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    deploymentVerifiedAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },

    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    publicId: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    allowedOrigins: { fillable: true, required: true, type: 'text', validation: { rule: schema.string() }, default: '[]' },
    anonymousEnabled: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    managedDailyCapCents: { type: 'bigint', fillable: true, required: true, default: -1, validation: { rule: schema.number().integer() } },
    managedMonthlyCapCents: { type: 'bigint', fillable: true, required: true, default: -1, validation: { rule: schema.number().integer() } },
  },
} as const)
