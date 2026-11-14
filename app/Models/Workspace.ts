import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Workspace',
  table: 'support_workspaces',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_one_free_workspace_per_owner', columns: ['owner_id'], unique: true, where: "plan = 'free'" }],
  attributes: {
    freeQualifiedAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },

    publicId: { fillable: true, required: true, unique: true, validation: { rule: schema.string() } },
    name: { fillable: true, required: true, validation: { rule: schema.string() } },
    ownerId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    plan: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'trial' },
    trialEndsAt: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    stacksVerified: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    deploymentVerified: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    overagesEnabled: { fillable: true, required: true, validation: { rule: schema.boolean() }, default: false },
    spendingCapCents: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    walletCents: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    managedDailyCapCents: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    managedMonthlyCapCents: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
    storageBytes: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() }, default: 0 },
  },
} as const)
