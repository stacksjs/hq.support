// SPDX-License-Identifier: LicenseRef-HQ-Support-Enterprise
import type { Row } from '../app/Support/database'
import { insert, one, query, workspaceTransaction } from '../app/Support/database'
import { SupportError, fail, identifier, text } from '../app/Support/errors'
import { remove as removeAttachment } from '../app/Support/attachments'
import { object, workspace } from '../app/Support/service'
import { audit } from './identity'
import { requireEnterprise } from './license'

export const retentionMarker = '[Removed by retention policy]'
export async function retentionPolicy(workspaceId: number) { return await one('SELECT * FROM support_enterprise_retention_policies WHERE workspace_id = ?', [workspaceId]) }
export async function configureRetention(workspaceId: number, input: Row, actorId: number) {
  return await workspaceTransaction(workspaceId, async () => {
    const days = Number(input.days)
    if (!Number.isSafeInteger(days) || days < 30 || days > 3650 || typeof input.enabled !== 'boolean') fail(422, 'invalid_retention', 'Retention requires 30 to 3650 days and a boolean enabled value.')
    if (input.enabled) requireEnterprise(await workspace(workspaceId), 'retention')
    const current = await retentionPolicy(workspaceId)
    if (current) await query('UPDATE support_enterprise_retention_policies SET days = ?, enabled = ?, updated_at = ? WHERE workspace_id = ?', [days, input.enabled, new Date().toISOString(), workspaceId])
    else await insert('support_enterprise_retention_policies', { workspace_id: workspaceId, days, enabled: input.enabled, last_run_at: 0 })
    await audit(workspaceId, actorId, 'retention.policy.updated', workspaceId, { days, enabled: input.enabled })
    return await retentionPolicy(workspaceId)
  })
}
export async function retentionHold(workspaceId: number, conversationId: unknown, input: Row, actorId: number) {
  return await workspaceTransaction(workspaceId, async () => {
    const id = identifier(conversationId)
    if (!await one('SELECT id FROM support_conversations WHERE workspace_id = ? AND id = ?', [workspaceId, id])) fail(404, 'not_found', 'Conversation not found.')
    if (typeof input.active !== 'boolean') fail(422, 'invalid_retention', 'Hold active must be a boolean.')
    const reason = text(input.reason, 'reason', 500)
    const existing = await one('SELECT id FROM support_enterprise_retention_holds WHERE workspace_id = ? AND conversation_id = ?', [workspaceId, id])
    if (existing) await query('UPDATE support_enterprise_retention_holds SET active = ?, reason = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [input.active, reason, new Date().toISOString(), existing.id, workspaceId])
    else await insert('support_enterprise_retention_holds', { workspace_id: workspaceId, conversation_id: id, reason, active: input.active })
    await audit(workspaceId, actorId, input.active ? 'retention.hold.placed' : 'retention.hold.released', id)
    return { held: input.active }
  })
}
async function candidates(workspaceId: number, days: number, limit: number, now: number) {
  const cutoff = new Date(now - days * 86400000).toISOString()
  return await query(`SELECT c.* FROM support_conversations c WHERE c.workspace_id = ? AND c.status = 'closed' AND COALESCE(c.updated_at, c.created_at) < ? AND (c.subject != ? OR EXISTS (SELECT 1 FROM support_messages m WHERE m.workspace_id = c.workspace_id AND m.conversation_id = c.id AND m.body != ?) OR EXISTS (SELECT 1 FROM support_attachments f WHERE f.workspace_id = c.workspace_id AND f.conversation_id = c.id AND f.status != 'deleted')) AND NOT EXISTS (SELECT 1 FROM support_enterprise_retention_holds h WHERE h.workspace_id = c.workspace_id AND h.conversation_id = c.id AND h.active = ?) AND NOT EXISTS (SELECT 1 FROM support_ai_runs a WHERE a.workspace_id = c.workspace_id AND a.conversation_id = c.id AND a.status = 'pending') AND NOT EXISTS (SELECT 1 FROM support_phone_calls p WHERE p.workspace_id = c.workspace_id AND p.conversation_id = c.id AND p.status NOT IN ('completed', 'busy', 'failed', 'no-answer', 'canceled')) ORDER BY c.id LIMIT ?`, [workspaceId, cutoff, retentionMarker, retentionMarker, true, limit])
}
export async function previewRetention(workspaceId: number) {
  const policy = await retentionPolicy(workspaceId)
  if (!policy) return { policy: null, conversations: [], limit: 100 }
  const rows = await candidates(workspaceId, Number(policy.days), 100, Date.now())
  return { policy, conversations: rows.map(row => ({ id: row.id, projectId: row.project_id, updatedAt: row.updated_at })), limit: 100 }
}
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['body', 'answer', 'subject', 'description', 'title'].includes(key) && typeof item === 'string' ? retentionMarker : redact(item)]))
}
/** Opt-in closed-thread content retention. Relational records and accounting stay intact. */
export async function applyRetention(workspaceId: number, actorId: number | null = null, now = Date.now()) {
  return await workspaceTransaction(workspaceId, async () => {
    const policy = await retentionPolicy(workspaceId)
    if (!policy?.enabled) return { processed: 0, skipped: 0 }
    requireEnterprise(await workspace(workspaceId), 'retention')
    const rows = await candidates(workspaceId, Number(policy.days), 25, now)
    let processed = 0, skipped = 0
    for (const row of rows) {
      // Lock the thread against a concurrent reopen while its content is removed.
      await query('UPDATE support_conversations SET id = id WHERE id = ? AND workspace_id = ?', [row.id, workspaceId])
      const current = await one("SELECT * FROM support_conversations WHERE id = ? AND workspace_id = ? AND status = 'closed'", [row.id, workspaceId])
      if (!current || Number(new Date(String(current.updated_at ?? current.created_at))) >= now - Number(policy.days) * 86400000) { skipped++; continue }
      const files = await query("SELECT * FROM support_attachments WHERE workspace_id = ? AND conversation_id = ? AND status != 'deleted'", [workspaceId, row.id])
      if (files.some(file => !['stored', 'deleting'].includes(String(file.status)) || Number(file.lease_until) > now)) { skipped++; continue }
      const project = await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [row.project_id, workspaceId])
      if (!project) fail(503, 'retention_inconsistent', 'Retention project ownership could not be verified.')
      // Native removal verifies storage deletion and releases the exact byte charge.
      for (const file of files) await removeAttachment(project, file.id)
      await query('UPDATE support_messages SET body = ? WHERE workspace_id = ? AND conversation_id = ?', [retentionMarker, workspaceId, row.id])
      await query('UPDATE support_tickets SET title = ?, description = ? WHERE workspace_id = ? AND conversation_id = ?', [retentionMarker, retentionMarker, workspaceId, row.id])
      await query('UPDATE support_conversations SET subject = ? WHERE workspace_id = ? AND id = ?', [retentionMarker, workspaceId, row.id])
      const cached = await query('SELECT * FROM support_idempotency WHERE workspace_id = ? AND project_id = ? AND (operation LIKE ? OR operation LIKE ?)', [workspaceId, row.project_id, `reply:${row.id}:%`, 'conversation:%'])
      for (const record of cached) {
        const data = JSON.parse(String(record.response)), convo = object(object(data).conversation)
        if (String(record.operation).startsWith(`reply:${row.id}:`) || String(convo.id) === String(row.id)) await query('UPDATE support_idempotency SET response = ? WHERE id = ? AND workspace_id = ?', [JSON.stringify(redact(data)), record.id, workspaceId])
      }
      const ai = await query("SELECT id, response FROM support_ai_runs WHERE workspace_id = ? AND conversation_id = ? AND status != 'pending'", [workspaceId, row.id])
      for (const record of ai) if (record.response) await query('UPDATE support_ai_runs SET response = ? WHERE id = ? AND workspace_id = ?', [JSON.stringify(redact(JSON.parse(String(record.response)))), record.id, workspaceId])
      const calls = await query('SELECT id FROM support_phone_calls WHERE workspace_id = ? AND conversation_id = ?', [workspaceId, row.id])
      for (const call of calls) {
        await query('UPDATE support_phone_calls SET transcript = ? WHERE id = ? AND workspace_id = ?', [retentionMarker, call.id, workspaceId])
        const tools = await query('SELECT id, result FROM support_phone_tool_results WHERE workspace_id = ? AND call_id = ?', [workspaceId, call.id])
        for (const tool of tools) await query('UPDATE support_phone_tool_results SET result = ? WHERE id = ? AND workspace_id = ?', [JSON.stringify(redact(JSON.parse(String(tool.result)))), tool.id, workspaceId])
      }
      await audit(workspaceId, actorId, 'retention.conversation.redacted', row.id, { attachments: files.length, days: policy.days })
      processed++
    }
    await query('UPDATE support_enterprise_retention_policies SET last_run_at = ? WHERE workspace_id = ?', [now, workspaceId])
    return { processed, skipped, batchLimit: 25 }
  })
}
export async function retentionTick() {
  const policies = await query('SELECT workspace_id FROM support_enterprise_retention_policies WHERE enabled = ? ORDER BY last_run_at, id LIMIT 20', [true])
  const outcomes: { workspaceId: number, processed?: number, failed?: boolean, skipped?: boolean }[] = []
  for (const policy of policies) {
    try { const result = await applyRetention(Number(policy.workspace_id)); outcomes.push({ workspaceId: Number(policy.workspace_id), processed: result.processed }) }
    catch (error) {
      if (error instanceof SupportError && error.status === 402) {
        await query('UPDATE support_enterprise_retention_policies SET last_run_at = ? WHERE workspace_id = ?', [Date.now(), policy.workspace_id])
        outcomes.push({ workspaceId: Number(policy.workspace_id), skipped: true })
      }
      else outcomes.push({ workspaceId: Number(policy.workspace_id), failed: true })
    }
  }
  if (outcomes.some(result => result.failed)) throw new Error('One or more retention policies failed. Data remains eligible for a later retry.')
  return outcomes
}
