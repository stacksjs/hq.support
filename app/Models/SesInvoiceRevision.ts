import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SesInvoiceRevision', table: 'support_ses_invoice_revisions',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [
    { name: 'ses_invoice_revision_approval', columns: ['pool_id', 'approval'], unique: true },
    { name: 'ses_invoice_revision_manifest', columns: ['pool_id', 'manifest_sha256'], unique: true },
  ],
  attributes: {
    poolId: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    approval: { required: true, validation: { rule: schema.string() } },
    replaces: { required: true, default: '', validation: { rule: schema.string() } },
    format: { required: true, validation: { rule: schema.string() } },
    invoiceId: { required: true, validation: { rule: schema.string() } },
    manifestSha256: { required: true, validation: { rule: schema.string() } },
    evidenceSha256: { required: true, validation: { rule: schema.string() } },
    recipientUnits: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    costMicros: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    chargedCents: { type: 'bigint', foreignKey: false, required: true, validation: { rule: schema.number().integer() } },
    reason: { type: 'text', required: true, validation: { rule: schema.string() } },
  },
} as const)
