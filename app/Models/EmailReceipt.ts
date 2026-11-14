import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation/runtime'

export default defineModel({
  name: 'EmailReceipt', table: 'support_email_receipts', traits: { useTimestamps: true }, dashboard: { access: false },
  indexes: [{ name: 'support_email_receipt_source', columns: ['channel_id', 'ses_message_id'], unique: true }],
  attributes: {
    publicId: { unique: true, fillable: true, required: true, validation: { rule: schema.string() } },
    workspaceId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    projectId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    channelId: { foreignKey: false, type: 'bigint', fillable: true, required: true, validation: { rule: schema.number().integer() } },
    sesMessageId: { fillable: true, required: true, validation: { rule: schema.string() } },
    snsMessageId: { fillable: true, required: true, validation: { rule: schema.string() } },
    sourceHash: { fillable: true, required: true, validation: { rule: schema.string() } },
    payload: { hidden: true, type: 'text', fillable: true, required: true, validation: { rule: schema.string() } },
    status: { fillable: true, required: true, default: 'pending', validation: { rule: schema.string() } },
    rawDisk: { hidden: true, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    rawKey: { hidden: true, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    rawSha256: { hidden: true, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    rawBytes: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    inboundId: { foreignKey: false, type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    leaseToken: { hidden: true, fillable: true, required: true, default: '', validation: { rule: schema.string() } },
    leaseUntil: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    attempts: { type: 'bigint', fillable: true, required: true, default: 0, validation: { rule: schema.number().integer() } },
    lastError: { fillable: true, required: true, default: '', validation: { rule: schema.string() } },
  },
} as const)
