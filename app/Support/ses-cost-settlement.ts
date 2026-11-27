import { ensureDatabaseConfigLoaded, isInTransaction } from '@stacksjs/database/runtime'
import { sesInvoiceCostCents, settleSesWalletReservation } from './billing'
import { db, insert, one, query, workspaceTransaction } from './database'
import type { Row } from './database'
import { fail, identifier, text } from './errors'
import { normalizeSesInvoice, planSesOutboundCosts, sesEvidenceDigest, sesInvoiceApproval, sesRecipientCost } from './ses-cost-preview'

interface Cost { micros: number, cents: number }
interface Charge { row: Row, cost: Cost, previous?: Cost }

function chargesByWorkspace(rows: Row[], total: number) {
  const workspaces = new Map<number, { micros: number, charges: Charge[] }>()
  for (const [index, row] of rows.entries()) {
    const workspaceId = identifier(row.workspace_id)
    const group = workspaces.get(workspaceId) ?? { micros: 0, charges: [] }
    const micros = sesRecipientCost(total, rows.length, index)
    const cents = sesInvoiceCostCents(group.micros + micros) - sesInvoiceCostCents(group.micros)
    group.micros += micros
    group.charges.push({ row, cost: { micros, cents } })
    workspaces.set(workspaceId, group)
  }
  return workspaces
}

async function applyCharge(workspaceId: number, revisionId: number, { row, cost, previous }: Charge) {
  const projectId = identifier(row.project_id)
  const providerId = String(row.provider_message_id)
  const timestamp = new Date().toISOString()
  const delivery = await one(`UPDATE support_channel_deliveries
    SET status = 'settled', provider_cost_micros = ?, provider_currency = 'USD', updated_at = ?
    WHERE id = ? AND workspace_id = ? AND project_id = ? AND channel_id = ?
      AND public_id = ? AND wallet_reservation_id = ? AND provider_message_id = ? AND status = ?
      AND provider_cost_micros = ? AND provider_currency = ?
    RETURNING id`, [cost.micros, timestamp, row.delivery_id, workspaceId, projectId, row.channel_id,
    row.public_id, row.wallet_reservation_id, providerId, previous ? 'settled' : 'cost_pending',
    previous?.micros ?? 0, previous ? 'USD' : ''])
  if (!delivery) fail(409, 'ses_invoice_delivery_changed', 'The invoice does not match the exact accepted email delivery.')

  await settleSesWalletReservation(workspaceId, projectId, String(row.public_id), String(row.wallet_reservation_id), providerId, revisionId, cost, previous)
  await query("UPDATE support_messages SET delivery_status = 'settled' WHERE id = ? AND workspace_id = ? AND project_id = ?",
    [row.message_id, workspaceId, projectId])
}

function revisionView(revision: Row, replayed: boolean) {
  return {
    approval: String(revision.approval), recipients: Number(revision.recipient_units),
    costMicros: Number(revision.cost_micros), chargedCents: Number(revision.charged_cents), replayed,
  }
}

/** Operator-only write. Charging requires the reviewed invoice and its exact signed-recipient preview. */
export async function settleSesInvoice(input: unknown, approvedPreview: unknown, caseReason: unknown, now = Date.now()) {
  const invoice = normalizeSesInvoice(input, now)
  const approval = text(approvedPreview, 'approve', 64)
  const reason = text(caseReason, 'reason', 500)
  if (!/^[a-f0-9]{64}$/.test(approval)) fail(422, 'ses_invoice_approval_invalid', 'Use the approval digest from the matching cost preview.')
  if (isInTransaction()) throw new Error('SES invoice settlement must own the outer transaction')
  await ensureDatabaseConfigLoaded()

  return await db.transaction(async () => {
    const timestamp = new Date().toISOString()
    const scope = [invoice.accountId, invoice.region, invoice.period]
    await query(`INSERT INTO support_ses_invoice_pools (account_id, region, period, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (account_id, region, period) DO NOTHING`, [...scope, timestamp, timestamp])
    // Always lock the pool first, then workspace wallets in ascending order.
    const pool = (await one(`UPDATE support_ses_invoice_pools SET account_id = account_id
      WHERE account_id = ? AND region = ? AND period = ? RETURNING id`, scope))!
    const prior = await one('SELECT * FROM support_ses_invoice_revisions WHERE pool_id = ? AND approval = ?', [pool.id, approval])
    if (prior) {
      if (sesInvoiceApproval(invoice, String(prior.evidence_sha256)) !== approval)
        fail(409, 'ses_invoice_approval_changed', 'The invoice differs from the applied review.')
      return revisionView(prior, true)
    }

    const latest = await one('SELECT * FROM support_ses_invoice_revisions WHERE pool_id = ? ORDER BY id DESC LIMIT 1', [pool.id])
    if (String(latest?.approval ?? '') !== invoice.replaces)
      fail(409, 'ses_invoice_revision_changed', 'A correction must replace the current invoice approval.')
    const reused = await one('SELECT id FROM support_ses_invoice_revisions WHERE pool_id = ? AND manifest_sha256 = ?', [pool.id, invoice.manifestSha256])
    if (reused) fail(409, 'ses_invoice_manifest_reused', 'This export manifest already backs an applied invoice revision.')

    const { rows, evidenceSha256, preview } = await planSesOutboundCosts(invoice)
    if (preview.state !== 'matched')
      fail(409, 'ses_invoice_incomplete', 'The provider unit count differs from the signed send evidence. Wallet holds remain pending.')
    if (preview.approval !== approval)
      fail(409, 'ses_invoice_approval_changed', 'The invoice or its signed evidence changed after preview.')
    const previousCosts = new Map<string, Cost>()
    if (latest) {
      const previousRows = rows.filter(row => row.delivery_status === 'settled')
      if (latest.evidence_sha256 !== sesEvidenceDigest(previousRows))
        fail(409, 'ses_invoice_cohort_changed', 'A correction must retain every previously settled signed recipient.')
      for (const group of chargesByWorkspace(previousRows, Number(latest.cost_micros)).values()) {
        for (const charge of group.charges)
          previousCosts.set(String(charge.row.delivery_id), charge.cost)
      }
    }

    const groups = chargesByWorkspace(rows, invoice.costMicros)
    const chargedCents = preview.allocations.reduce((total, allocation) => total + allocation.chargedCents, 0)
    const revision = await insert('support_ses_invoice_revisions', {
      pool_id: pool.id, approval, replaces: invoice.replaces, format: invoice.format, invoice_id: invoice.invoiceId,
      manifest_sha256: invoice.manifestSha256, evidence_sha256: evidenceSha256,
      recipient_units: invoice.recipientUnits, cost_micros: invoice.costMicros, charged_cents: chargedCents, reason,
    })
    for (const [workspaceId, group] of groups) {
      await workspaceTransaction(workspaceId, async () => {
        for (const charge of group.charges)
          await applyCharge(workspaceId, identifier(revision.id), { ...charge, previous: previousCosts.get(String(charge.row.delivery_id)) })
      })
    }
    return revisionView(revision, false)
  })
}
