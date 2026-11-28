import { userInfo } from 'node:os'
import { applyReviewedVoiceWallet } from './billing'
import { insert, one, query, workspaceTransaction } from './database'
import type { Row } from './database'
import { fail, identifier, text } from './errors'
import { normalizeVoiceCostEvidence, planVoiceCosts } from './voice-cost-preview'

function revisionView(revision: Row, replayed: boolean) {
  return {
    approval: String(revision.approval),
    costMicros: Number(revision.cost_micros),
    chargedCents: Number(revision.charged_cents),
    walletDeltaCents: Number(revision.wallet_delta_cents),
    replayed,
  }
}

/** Deployment CLI only. Require the exact reviewed allocation before making a wallet change. */
export async function settleVoiceCosts(input: unknown, approvedPreview: unknown, caseReason: unknown, now = Date.now()) {
  const evidence = normalizeVoiceCostEvidence(input, now)
  const approval = text(approvedPreview, 'approve', 64)
  const reason = text(caseReason, 'reason', 500)
  const operator = text(userInfo().username, 'operator', 128)
  if (!/^[a-f0-9]{64}$/.test(approval))
    fail(422, 'voice_cost_approval_invalid', 'Use the approval digest from the matching voice cost preview.')

  async function existingRevision() {
    const row = await one('SELECT * FROM support_voice_cost_revisions WHERE approval = ?', [approval])
    if (row && row.input_sha256 !== evidence.inputSha256)
      fail(409, 'voice_cost_approval_changed', 'The evidence differs from the applied review.')
    return row
  }

  const previous = await existingRevision()
  if (previous) return revisionView(previous, true)
  const first = await planVoiceCosts(evidence)
  if (!first.row || first.preview.state !== 'matched' || first.preview.approval !== approval) {
    const committed = await existingRevision()
    if (committed) return revisionView(committed, true)
    fail(409, 'voice_cost_approval_changed', 'The evidence or wallet allocation changed after preview.')
  }
  const workspaceId = identifier(first.row.workspace_id)
  return await workspaceTransaction(workspaceId, async () => {
    const replay = await existingRevision()
    if (replay) return revisionView(replay, true)
    const current = await planVoiceCosts(evidence)
    if (!current.row || !current.wallet || !current.receiptSha256 || current.preview.state !== 'matched'
      || current.preview.approval !== approval || Number(current.row.workspace_id) !== workspaceId)
      fail(409, 'voice_cost_approval_changed', 'The evidence or wallet allocation changed after preview.')
    const { row, wallet } = current
    const projectId = identifier(row.project_id)
    const reused = await one('SELECT id FROM support_voice_cost_revisions WHERE billing_scope = ? AND day = ? AND source_sha256 = ?', [evidence.scope, evidence.day, evidence.sourceSha256])
    if (reused) fail(409, 'voice_cost_source_reused', 'This export digest already backs a revision for the same scope and day.')
    const revision = await insert('support_voice_cost_revisions', {
      workspace_id: workspaceId, project_id: projectId, call_id: identifier(row.id),
      billing_scope: evidence.scope, day: evidence.day, format: evidence.format, approval, replaces: evidence.replaces,
      source_sha256: evidence.sourceSha256, input_sha256: evidence.inputSha256, receipt_sha256: current.receiptSha256,
      cost_micros: evidence.costMicros, charged_cents: wallet.chargedCents, wallet_delta_cents: wallet.walletDeltaCents, operator, reason,
    })
    await applyReviewedVoiceWallet(workspaceId, projectId, String(row.public_id), String(row.hold_id), identifier(revision.id), evidence.costMicros, wallet)
    const timestamp = new Date()
    await query(`
      UPDATE support_phone_calls SET ai_cost_micros = ?, updated_at = ?,
        last_error = CASE WHEN last_error = 'realtime_usage_pending' THEN '' ELSE last_error END,
        settled_at = CASE WHEN provider_cost_micros IS NOT NULL AND settled_at = 0 THEN ? ELSE settled_at END
      WHERE id = ? AND workspace_id = ? AND project_id = ?
    `, [evidence.costMicros, timestamp.toISOString(), timestamp.getTime(), row.id, workspaceId, projectId])
    return revisionView(revision, false)
  })
}
