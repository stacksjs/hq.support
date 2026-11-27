import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'SesInvoicePool', table: 'support_ses_invoice_pools',
  traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [{ name: 'ses_invoice_pool_scope', columns: ['account_id', 'region', 'period'], unique: true }],
  attributes: {
    accountId: { required: true, validation: { rule: schema.string() } },
    region: { required: true, validation: { rule: schema.string() } },
    period: { required: true, validation: { rule: schema.string() } },
  },
} as const)
