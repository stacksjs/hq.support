// SPDX-License-Identifier: LicenseRef-HQ-Support-Enterprise
import type { Row } from '../app/Support/database'
import { insert, one, query, workspaceTransaction } from '../app/Support/database'
import { fail, identifier, text } from '../app/Support/errors'
import { object, workspace } from '../app/Support/service'
import { audit, scimIdentity } from './identity'
import { requireEnterprise } from './license'

export async function directoryGroup(workspaceId: number, providerId: unknown, reference: unknown) {
  const row = await one('SELECT * FROM support_enterprise_groups WHERE workspace_id = ? AND provider_id = ? AND id = ?', [workspaceId, providerId, identifier(reference)])
  if (!row) fail(404, 'not_found', 'Directory group not found.')
  return row
}
export async function groupResource(row: Row) {
  const ids = JSON.parse(String(row.members)) as number[]
  const users = ids.length ? await query(`SELECT i.id, m.email FROM support_enterprise_identities i JOIN support_memberships m ON m.id = i.membership_id AND m.workspace_id = i.workspace_id WHERE i.workspace_id = ? AND i.provider_id = ? AND i.deleted_at = 0 AND i.id IN (${ids.map(() => '?').join(',')})`, [row.workspace_id, row.provider_id, ...ids]) : []
  return { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], id: String(row.id), externalId: String(row.external_id), displayName: String(row.display_name), members: users.map(user => ({ value: String(user.id), display: String(user.email) })), meta: { resourceType: 'Group' } }
}
async function members(workspaceId: number, providerId: unknown, input: unknown) {
  if (!Array.isArray(input) || input.length > 100) fail(400, 'invalidValue', 'Groups support up to 100 directory members.')
  const ids = [...new Set(input.map(value => identifier(object(value).value)))]
  for (const id of ids) await scimIdentity(workspaceId, providerId, id)
  return ids
}
export async function writeGroup(workspaceId: number, principal: Row, operation: 'create' | 'replace' | 'patch' | 'delete', input: Row, reference?: unknown) {
  return await workspaceTransaction(workspaceId, async () => {
    if (!await one('SELECT id FROM support_enterprise_scim_tokens WHERE id = ? AND workspace_id = ? AND revoked_at = 0 AND expires_at > ?', [principal.id, workspaceId, Date.now()])) fail(401, 'invalid_scim_token', 'Provisioning token is no longer valid.')
    if (operation !== 'delete') requireEnterprise(await workspace(workspaceId), 'scim')
    const existing = operation === 'create' ? undefined : await directoryGroup(workspaceId, principal.provider_id, reference)
    if (operation === 'delete') {
      await query('DELETE FROM support_enterprise_groups WHERE id = ? AND workspace_id = ? AND provider_id = ?', [existing!.id, workspaceId, principal.provider_id])
      await audit(workspaceId, null, 'scim.group.deleted', existing!.id)
      return null
    }
    let name = existing ? String(existing.display_name) : '', ids: number[] = existing ? JSON.parse(String(existing.members)) : []
    if (operation === 'patch') {
      if (!Array.isArray(input.Operations) || !input.Operations.length || input.Operations.length > 10) fail(400, 'invalidSyntax', 'Provide one to ten group patch operations.')
      for (const raw of input.Operations) {
        const patch = object(raw), op = String(patch.op).toLowerCase(), path = String(patch.path ?? '')
        if (path === 'displayName' && op === 'replace') name = text(patch.value, 'displayName', 200)
        else if (path === 'members' && ['add', 'replace', 'remove'].includes(op)) {
          const values = patch.value === undefined && op === 'remove' ? ids : await members(workspaceId, principal.provider_id, patch.value)
          ids = op === 'replace' ? values : op === 'add' ? [...new Set([...ids, ...values])] : ids.filter(id => !values.includes(id))
        }
        else if (/^members\[value eq "[0-9]+"\]$/.test(path) && op === 'remove') ids = ids.filter(id => id !== Number(/"([0-9]+)"/.exec(path)![1]))
        else fail(400, 'invalidPath', 'Supported group patches replace displayName or add/remove/replace members.')
      }
    }
    else {
      name = text(input.displayName, 'displayName', 200)
      ids = await members(workspaceId, principal.provider_id, input.members ?? [])
      if (existing && input.externalId !== undefined && input.externalId !== existing.external_id) fail(400, 'mutability', 'Group externalId is immutable.')
    }
    if (ids.length > 100) fail(400, 'invalidValue', 'Groups support up to 100 directory members.')
    let row: Row
    if (existing) {
      await query('UPDATE support_enterprise_groups SET display_name = ?, members = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [name, JSON.stringify(ids), new Date().toISOString(), existing.id, workspaceId])
      row = await directoryGroup(workspaceId, principal.provider_id, existing.id)
    }
    else {
      const externalId = input.externalId === undefined ? crypto.randomUUID() : text(input.externalId, 'externalId', 255)
      if (await one('SELECT id FROM support_enterprise_groups WHERE provider_id = ? AND external_id = ?', [principal.provider_id, externalId])) fail(409, 'uniqueness', 'Group externalId already exists.')
      row = await insert('support_enterprise_groups', { workspace_id: workspaceId, provider_id: principal.provider_id, external_id: externalId, display_name: name, members: JSON.stringify(ids) })
    }
    // Directory group membership never assigns local owner/admin roles.
    await audit(workspaceId, null, `scim.group.${operation === 'create' ? 'created' : 'updated'}`, row.id)
    return row
  })
}
