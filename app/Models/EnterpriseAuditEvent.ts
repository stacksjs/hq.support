import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EnterpriseAuditEvent',
  table: 'support_enterprise_audit_events',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [{ name: 'support_enterprise_audit_target', columns: ['workspace_id', 'action', 'target_id', 'id'] }],
  attributes: {
    workspaceId: { type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    actorId: { type: 'bigint', fillable: true, nullable: true, validation: { rule: schema.number().integer() } },
    action: { fillable: true, required: true, validation: { rule: schema.string() } },
    targetId: { fillable: true, required: true, validation: { rule: schema.string() } },
    detail: { fillable: true, required: true, validation: { rule: schema.string() } , type: 'text' },
  },
} as const)
