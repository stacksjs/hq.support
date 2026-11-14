import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EnterpriseIdentity',
  table: 'support_enterprise_identities',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'support_enterprise_external_identity', columns: ['provider_id', 'external_id'], unique: true },
    { name: 'support_enterprise_subject', columns: ['provider_id', 'subject'], unique: true },
  ],
  attributes: {
    deletedAt: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    providerId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    membershipId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    userId: { type: 'bigint', fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
    externalId: { fillable: true, required: true, validation: { rule: schema.string() } },
    subject: { fillable: true, nullable: true, validation: { rule: schema.string() } },
    active: { fillable: true, required: true, default: true, validation: { rule: schema.boolean() } },
  },
} as const)
