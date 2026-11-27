import { query } from './database'
import { fail, text } from './errors'
import { object } from './service'

const format = 'aws-cur2-ses-outbound-v1'

/** Review an operator-normalized AWS invoice pool without releasing holds or charging wallets. */
export async function previewSesOutboundCosts(input: unknown, now = Date.now()) {
  const evidence = object(input)
  const accountId = text(evidence.accountId, 'accountId', 12)
  const region = text(evidence.region, 'region', 30)
  const period = text(evidence.period, 'period', 7)
  const invoiceId = text(evidence.invoiceId, 'invoiceId', 120)
  const manifestSha256 = text(evidence.manifestSha256, 'manifestSha256', 64)
  const { recipientUnits, costMicros } = evidence
  if (evidence.format !== format || evidence.currency !== 'USD' || !/^\d{12}$/.test(accountId) || !/^[a-z]{2}-[a-z]+-\d$/.test(region) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !/^[a-f0-9]{64}$/.test(manifestSha256))
    fail(422, 'ses_invoice_scope_invalid', 'An AWS CUR 2.0 USD outbound invoice pool with an account, region, period and manifest digest is required.')
  if (typeof recipientUnits !== 'number' || !Number.isSafeInteger(recipientUnits) || recipientUnits < 0 || typeof costMicros !== 'number' || !Number.isSafeInteger(costMicros) || costMicros < 0 || (!recipientUnits && costMicros))
    fail(422, 'ses_invoice_total_invalid', 'Use whole recipient units and whole USD microdollars for the base send pool.')

  const start = new Date(`${period}-01T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  if (end.getTime() > now)
    fail(409, 'ses_invoice_period_open', 'Wait for the UTC billing month to close and the AWS invoice to finalize.')

  const counts = await query(`
    SELECT e.workspace_id, COUNT(*) AS recipients
    FROM support_ses_send_evidence e
    JOIN support_channel_deliveries d ON d.id = e.delivery_id
      AND d.workspace_id = e.workspace_id AND d.project_id = e.project_id AND d.channel_id = e.channel_id
      AND d.provider_message_id = e.provider_message_id
    WHERE e.account_id = ? AND e.region = ? AND e.sent_at >= ? AND e.sent_at < ?
    GROUP BY e.workspace_id ORDER BY e.workspace_id
  `, [accountId, region, start.getTime(), end.getTime()])
  const verifiedRecipients = counts.reduce((sum, row) => sum + Number(row.recipients), 0)
  const scope = { format, accountId, region, period, invoiceId, manifestSha256, currency: 'USD' as const, recipientUnits, verifiedRecipients, costMicros }
  if (verifiedRecipients !== recipientUnits)
    return { ...scope, state: 'incomplete' as const, allocations: [] }

  // Allocate the monthly base send pool equally per verified recipient.
  // Allocate the residual microdollars once, starting at the lowest workspace ID.
  const units = BigInt(recipientUnits), micros = BigInt(costMicros)
  const unitCost = units === 0n ? 0n : micros / units
  let remainder = units === 0n ? 0 : Number(micros % units)
  const allocations = counts.map((row) => {
    const recipients = Number(row.recipients)
    const extra = Math.min(remainder, recipients)
    remainder -= extra
    return { workspaceId: Number(row.workspace_id), recipients, costMicros: Number(unitCost * BigInt(recipients) + BigInt(extra)) }
  })
  return { ...scope, state: 'matched' as const, allocations }
}
