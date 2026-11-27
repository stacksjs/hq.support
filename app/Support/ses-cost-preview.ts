import { sesInvoiceCostCents } from './billing'
import { query } from './database'
import type { Row } from './database'
import { fail, text } from './errors'
import { digest, object } from './service'

const format = 'aws-cur2-ses-outbound-v1'
const sha256 = /^[a-f0-9]{64}$/

export function normalizeSesInvoice(input: unknown, now: number) {
  const evidence = object(input)
  const accountId = text(evidence.accountId, 'accountId', 12)
  const region = text(evidence.region, 'region', 30)
  const period = text(evidence.period, 'period', 7)
  const invoiceId = text(evidence.invoiceId, 'invoiceId', 120)
  const manifestSha256 = text(evidence.manifestSha256, 'manifestSha256', 64)
  const { recipientUnits, costMicros, replaces = '' } = evidence
  if (evidence.format !== format || evidence.currency !== 'USD' || !/^\d{12}$/.test(accountId) || !/^[a-z]{2}-[a-z]+-\d$/.test(region) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !sha256.test(manifestSha256))
    fail(422, 'ses_invoice_scope_invalid', 'An AWS CUR 2.0 USD outbound invoice pool with an account, region, period and manifest digest is required.')
  if (typeof recipientUnits !== 'number' || !Number.isSafeInteger(recipientUnits) || recipientUnits < 0 || typeof costMicros !== 'number' || !Number.isSafeInteger(costMicros) || costMicros < 0 || (!recipientUnits && costMicros))
    fail(422, 'ses_invoice_total_invalid', 'Use whole recipient units and whole USD microdollars for the base send pool.')
  if (typeof replaces !== 'string' || (replaces !== '' && !sha256.test(replaces)))
    fail(422, 'ses_invoice_revision_invalid', 'Use the previous settlement approval for an invoice correction.')

  const end = new Date(`${period}-01T00:00:00.000Z`)
  end.setUTCMonth(end.getUTCMonth() + 1)
  if (end.getTime() > now)
    fail(409, 'ses_invoice_period_open', 'Wait for the UTC billing month to close and the AWS invoice to finalize.')
  return { format, accountId, region, period, invoiceId, manifestSha256, currency: 'USD' as const, recipientUnits, costMicros, replaces }
}
type Invoice = ReturnType<typeof normalizeSesInvoice>

export function sesInvoiceApproval(invoice: Invoice, evidenceSha256: string) {
  return digest(JSON.stringify([invoice, evidenceSha256]))
}

export function sesEvidenceDigest(rows: Row[]) {
  return digest(JSON.stringify(rows.map(row => [
    String(row.workspace_id), String(row.project_id), String(row.channel_id), String(row.delivery_id), String(row.public_id), String(row.message_id),
    String(row.wallet_reservation_id), String(row.provider_message_id), String(row.event_sha256),
  ])))
}

/** Split a verified pool evenly, assigning the first recipients one residual microdollar each. */
export function sesRecipientCost(costMicros: number, units: number, index: number) {
  const total = BigInt(costMicros), recipients = BigInt(units)
  return Number(total / recipients) + (index < Number(total % recipients) ? 1 : 0)
}

export async function planSesOutboundCosts(invoice: Invoice) {
  const { accountId, region, period, recipientUnits, costMicros } = invoice
  const start = new Date(`${period}-01T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  const rows = await query(`
    SELECT e.workspace_id, e.project_id, e.channel_id, e.delivery_id, e.event_sha256,
      e.provider_message_id, d.public_id, d.message_id, d.wallet_reservation_id, d.status AS delivery_status
    FROM support_ses_send_evidence e
    JOIN support_channel_deliveries d ON d.id = e.delivery_id
      AND d.workspace_id = e.workspace_id AND d.project_id = e.project_id AND d.channel_id = e.channel_id
      AND d.provider_message_id = e.provider_message_id
    WHERE e.account_id = ? AND e.region = ? AND e.sent_at >= ? AND e.sent_at < ?
    ORDER BY e.workspace_id, e.id
  `, [accountId, region, start.getTime(), end.getTime()])
  const scope = { ...invoice, verifiedRecipients: rows.length }
  const evidenceSha256 = sesEvidenceDigest(rows)
  const allocations = new Map<number, { workspaceId: number, recipients: number, costMicros: number }>()
  const matched = rows.length === recipientUnits
  if (matched) {
    for (const [index, row] of rows.entries()) {
      const workspaceId = Number(row.workspace_id)
      const allocation = allocations.get(workspaceId) ?? { workspaceId, recipients: 0, costMicros: 0 }
      allocation.recipients++
      allocation.costMicros += sesRecipientCost(costMicros, recipientUnits, index)
      allocations.set(workspaceId, allocation)
    }
  }
  const preview = matched
    ? {
        ...scope, state: 'matched' as const,
        allocations: [...allocations.values()].map(allocation => ({ ...allocation, chargedCents: sesInvoiceCostCents(allocation.costMicros) })),
        approval: sesInvoiceApproval(invoice, evidenceSha256),
      }
    : { ...scope, state: 'incomplete' as const, allocations: [] }
  return { rows, evidenceSha256, preview }
}

/** Review an operator-normalized AWS invoice pool without releasing holds or charging wallets. */
export async function previewSesOutboundCosts(input: unknown, now = Date.now()) {
  return (await planSesOutboundCosts(normalizeSesInvoice(input, now))).preview
}
