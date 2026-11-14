import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, text } from './errors'

/** Consent belongs to the channel/sender that received it, including before conversation admission. */
export async function recordChannelConsent(project: Row, channel: Row, recipient: string, kind: string, eventId: string, eventAt: number) {
  if (!['stop', 'start'].includes(kind)) return
  if (!Number.isSafeInteger(eventAt) || eventAt < 0 || eventAt > Date.now() + 60000) fail(422, 'invalid_consent_timestamp', 'A verified provider timestamp is required for consent.')
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const address = text(recipient, 'recipient', 200)
    const row = await one('SELECT * FROM support_channel_consents WHERE workspace_id = ? AND project_id = ? AND channel_id = ? AND recipient = ?', [project.workspace_id, project.id, channel.id, address])
    const status = kind === 'stop' ? 'opted_out' : 'opted_in'
    if (row) {
      if (Number(row.event_at) > eventAt || (Number(row.event_at) === eventAt && row.status === 'opted_out' && kind === 'start')) return row
      await query('UPDATE support_channel_consents SET status = ?, provider_event_id = ?, event_at = ?, updated_at = ? WHERE id = ?', [status, eventId, eventAt, new Date().toISOString(), row.id])
      return row
    }
    return await insert('support_channel_consents', { workspace_id: project.workspace_id, project_id: project.id, channel_id: channel.id, recipient: address, status, provider_event_id: eventId, event_at: eventAt })
  })
}
export async function channelOptedOut(channel: Row, recipient: string) {
  return Boolean(await one("SELECT id FROM support_channel_consents WHERE workspace_id = ? AND project_id = ? AND channel_id = ? AND recipient = ? AND status = 'opted_out'", [channel.workspace_id, channel.project_id, channel.id, recipient]))
}
