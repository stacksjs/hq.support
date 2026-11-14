import { decrypt, encrypt } from '@stacksjs/security'
import type { Row } from './database'
import { insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { member, object } from './service'

export const channelProviders = ['email', 'sms', 'whatsapp', 'messenger', 'instagram', 'slack', 'discord', 'twilio'] as const
export function publicChannel(row: Row) {
  return { id: String(row.id), publicId: String(row.public_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), provider: String(row.provider), label: String(row.label), externalId: String(row.external_id), status: String(row.status), verifiedAt: Number(row.verified_at), configured: Boolean(row.configuration && row.configuration !== '{}'), lastError: String(row.last_error), createdAt: row.created_at, updatedAt: row.updated_at }
}
export async function loadChannel(project: Row, id: unknown): Promise<Row> {
  const row = await one('SELECT * FROM support_channels WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])
  if (!row) fail(404, 'channel_not_found', 'Channel connection not found.')
  return row
}
export async function channelByPublicId(publicId: string): Promise<Row> {
  const row = await one('SELECT * FROM support_channels WHERE public_id = ?', [text(publicId, 'channel public ID', 100)])
  if (!row) fail(404, 'channel_not_found', 'Channel connection not found.')
  return row
}
export async function channelConfig(row: Row): Promise<Row> {
  if (!row.configuration || row.configuration === '{}') return {}
  try { return object(JSON.parse(await decrypt(String(row.configuration)))) }
  catch { fail(503, 'channel_configuration_unavailable', 'Stored channel credentials could not be decrypted. Reconnect the provider.') }
}
export async function requireReadyChannel(project: Row, id: unknown, provider?: string): Promise<Row> {
  const row = await loadChannel(project, id)
  if (provider && row.provider !== provider) fail(422, 'channel_provider_mismatch', 'This connection uses a different provider.')
  if (row.status !== 'ready' || Number(row.verified_at) <= 0) fail(409, 'channel_not_ready', 'Verify this provider connection before using it.')
  return row
}
export async function saveChannel(project: Row, input: Row, userId: number): Promise<Row> {
  await member(userId, Number(project.workspace_id), ['owner', 'admin'])
  const provider = text(input.provider, 'provider', 50)
  if (!channelProviders.includes(provider as typeof channelProviders[number])) fail(422, 'unsupported_channel', 'Unsupported channel provider.')
  const configuration = { ...object(input.configuration) }
  delete configuration._verification
  if (JSON.stringify(configuration).length > 16000) fail(422, 'channel_configuration_large', 'Channel configuration exceeds the credential bound.')
  const sealed = await encrypt(JSON.stringify(configuration))
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    await member(userId, Number(project.workspace_id), ['owner', 'admin'])
    if (input.id !== undefined) {
      const row = await loadChannel(project, input.id)
      if (row.provider !== provider) fail(409, 'channel_provider_immutable', 'Create a new connection to change its provider.')
      await query("UPDATE support_channels SET label = ?, configuration = ?, status = 'pending', verified_at = 0, last_error = '', updated_at = ? WHERE id = ?", [input.label === undefined ? row.label : text(input.label, 'label', 100), sealed, new Date().toISOString(), row.id])
      return await loadChannel(project, row.id)
    }
    return await insert('support_channels', { workspace_id: project.workspace_id, project_id: project.id, public_id: crypto.randomUUID(), provider, label: input.label ? text(input.label, 'label', 100) : provider, configuration: sealed, status: 'pending', external_id: '', verified_at: 0, last_error: '' })
  })
}
/** Only a configured provider adapter calls this after a successful real probe or provisioning receipt. */
export async function markChannelReady(project: Row, id: unknown, evidence: { externalId: string, receipt: string, expectedConfiguration: string }): Promise<Row> {
  const externalId = text(evidence.externalId, 'provider external ID', 200), receipt = text(evidence.receipt, 'provider verification receipt', 2000)
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const row = await loadChannel(project, id)
    if (row.status === 'disabled' || row.configuration !== evidence.expectedConfiguration) fail(409, 'channel_configuration_changed', 'The channel changed during provider verification. Probe its current configuration again.')
    const configuration = await channelConfig(row)
    const verifiedAt = Date.now(), sealed = await encrypt(JSON.stringify({ ...configuration, _verification: { receipt, verifiedAt } }))
    await query("UPDATE support_channels SET status = 'ready', external_id = ?, verified_at = ?, configuration = ?, last_error = '', updated_at = ? WHERE id = ?", [externalId, verifiedAt, sealed, new Date(verifiedAt).toISOString(), row.id])
    return await loadChannel(project, id)
  })
}
export async function markChannelError(project: Row, id: unknown, reason: string) {
  await loadChannel(project, id)
  await query("UPDATE support_channels SET status = 'error', last_error = ?, updated_at = ? WHERE id = ? AND project_id = ?", [reason.slice(0, 1000), new Date().toISOString(), identifier(id), project.id])
}
