import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'VoiceCostRevision',
  table: 'support_voice_cost_revisions',
  traits: { useTimestamps: true },
  dashboard: { access: false },
  indexes: [
    { name: 'voice_cost_revision_approval', columns: ['approval'], unique: true },
    { name: 'voice_cost_revision_source', columns: ['billing_scope', 'day', 'source_sha256'], unique: true },
    { name: 'voice_cost_revision_scope', columns: ['billing_scope', 'day', 'id'] },
  ],
  attributes: {
    workspaceId: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    projectId: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    callId: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    billingScope: { required: true, validation: { rule: schema.string() } },
    day: { required: true, validation: { rule: schema.string() } },
    format: { required: true, validation: { rule: schema.string() } },
    approval: { required: true, validation: { rule: schema.string() } },
    replaces: { required: true, default: '', validation: { rule: schema.string() } },
    sourceSha256: { required: true, validation: { rule: schema.string() } },
    inputSha256: { required: true, validation: { rule: schema.string() } },
    receiptSha256: { required: true, validation: { rule: schema.string() } },
    costMicros: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    chargedCents: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    walletDeltaCents: { type: 'bigint', required: true, validation: { rule: schema.number().integer() } },
    operator: { required: true, validation: { rule: schema.string() } },
    reason: { type: 'text', required: true, validation: { rule: schema.string() } },
  },
} as const)
