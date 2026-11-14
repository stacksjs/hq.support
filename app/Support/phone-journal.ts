import type { OperationJournal, OperationOutcome, OperationRecord } from '@stacksjs/telephony'
import { insert, one, query, workspaceTransaction } from './database'

/** A durable native SQL claim. Pending/uncertain writes never turn into a fresh attempt. */
export class SqlPhoneJournal implements OperationJournal {
  constructor(private workspaceId: number, private channelId: number) {}
  async claim(key: string, fingerprint: string) {
    return await workspaceTransaction(this.workspaceId, async () => {
      const existing = await one('SELECT * FROM support_phone_operations WHERE workspace_id = ? AND key = ?', [this.workspaceId, key])
      if (existing) {
        if (Number(existing.channel_id) !== this.channelId) throw new Error('Operation channel mismatch')
        return { acquired: false, record: { fingerprint: String(existing.fingerprint), ...JSON.parse(String(existing.outcome)) } as OperationRecord }
      }
      await insert('support_phone_operations', { workspace_id: this.workspaceId, channel_id: this.channelId, key, fingerprint, state: 'pending', outcome: '{"state":"pending"}' })
      return { acquired: true, record: { fingerprint, state: 'pending' } as OperationRecord }
    })
  }
  /** Internal reconciliation only after a signed call callback plus exact provider resource lookup. */
  async resolveConfirmed(key: string, value: unknown) {
    await workspaceTransaction(this.workspaceId, async () => {
      const record = await one('SELECT * FROM support_phone_operations WHERE workspace_id = ? AND channel_id = ? AND key = ?', [this.workspaceId, this.channelId, key])
      if (!record || !['pending', 'uncertain'].includes(String(record.state))) return
      const outcome = JSON.stringify({ state: 'succeeded', value })
      await query('UPDATE support_phone_operations SET state = ?, outcome = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', ['succeeded', outcome, new Date().toISOString(), record.id, this.workspaceId])
      const stored = await one('SELECT state, outcome FROM support_phone_operations WHERE id = ? AND workspace_id = ?', [record.id, this.workspaceId])
      if (!stored || stored.state !== 'succeeded' || stored.outcome !== outcome) throw new Error('Reconciled provider outcome was not durably recorded')
    })
  }
  async settle(key: string, outcome: OperationOutcome) {
    await workspaceTransaction(this.workspaceId, async () => {
      const existing = await one('SELECT * FROM support_phone_operations WHERE workspace_id = ? AND channel_id = ? AND key = ?', [this.workspaceId, this.channelId, key])
      if (existing?.state !== 'pending') throw new Error('Only a pending provider operation can settle')
      const serialized = JSON.stringify(outcome)
      await query("UPDATE support_phone_operations SET state = ?, outcome = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND state = 'pending'", [outcome.state, serialized, new Date().toISOString(), existing.id, this.workspaceId])
      const stored = await one('SELECT state, outcome FROM support_phone_operations WHERE id = ? AND workspace_id = ?', [existing.id, this.workspaceId])
      if (!stored || stored.state !== outcome.state || stored.outcome !== serialized) throw new Error('Provider outcome was not durably recorded')
    })
  }
}
