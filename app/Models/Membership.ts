import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'Membership',
  table: 'support_memberships',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_workspace_human', columns: ['workspace_id', 'user_id'], unique: true },
    { name: 'support_membership_identity', columns: ['workspace_id', 'email'], unique: true },
  ],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    userId: { type: 'bigint', fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
    email: { fillable: true, required: true, validation: { rule: schema.string() } },
    role: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'agent' },
    status: { fillable: true, required: true, validation: { rule: schema.string() }, default: 'active' },
  },
} as const)
