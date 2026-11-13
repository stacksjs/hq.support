import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Workspace',
  table: 'support_workspaces',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  attributes: {
    publicId: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    ownerId: { fillable: true, required: true, validation: { rule: schema.number().integer() } },
    plan: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'trial' },
    trialEndsAt: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    stacksVerified: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    deploymentVerified: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    overagesEnabled: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    spendingCapCents: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    walletCents: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    storageBytes: { fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
