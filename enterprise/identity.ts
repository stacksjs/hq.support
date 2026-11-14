// SPDX-License-Identifier: LicenseRef-HQ-Support-Enterprise
import type { Row } from '../app/Support/database'
import type { EnterpriseOidcConfig } from '@stacksjs/auth/enterprise-oidc'
import { revokeAccountCredentials } from '@stacksjs/auth'
import { insert, one, query, workspaceTransaction } from '../app/Support/database'
import { fail, identifier, text } from '../app/Support/errors'
import { digest, secret, workspace } from '../app/Support/service'
import { requireEnterprise } from './license'
import { limitsFor } from '../app/Support/limits'
import type { Plan } from '../app/Support/limits'

export async function audit(workspaceId: number, actorId: number | null, action: string, targetId: unknown, detail: Row = {}) {
  await insert('support_enterprise_audit_events', { workspace_id: workspaceId, actor_id: actorId, action, target_id: String(targetId), detail: JSON.stringify(detail) })
}
export async function provider(reference: string) {
  const row = await one('SELECT * FROM support_enterprise_providers WHERE public_id = ?', [reference])
  if (!row || !row.enabled) fail(503, 'identity_provider_unavailable', 'The identity provider is not configured or enabled.')
  return row
}
export function oidcConfig(row: Row, transport?: typeof fetch): EnterpriseOidcConfig {
  if (row.protocol !== 'oidc') fail(503, 'saml_unavailable', 'SAML is not available in this release.')
  let secrets: Record<string, string> = {}, allowed: unknown = []
  try { secrets = JSON.parse(process.env.SUPPORT_ENTERPRISE_OIDC_CLIENTS || '{}'); allowed = JSON.parse(process.env.SUPPORT_ENTERPRISE_OIDC_ISSUERS || '[]') }
  catch { fail(503, 'identity_provider_unavailable', 'Identity provider operator configuration is invalid.') }
  const clientSecret = secrets[String(row.public_id)]
  if (!Array.isArray(allowed) || !allowed.includes(row.issuer) || typeof clientSecret !== 'string' || !clientSecret) fail(503, 'identity_provider_unavailable', 'Identity provider credentials are not configured.')
  const appUrl = new URL(process.env.APP_URL || 'https://hq.support')
  if (appUrl.protocol !== 'https:') fail(503, 'identity_provider_unavailable', 'SSO requires the canonical HTTPS application URL.')
  return { issuer: String(row.issuer), clientId: String(row.client_id), clientSecret, redirectUri: new URL(`/api/enterprise/providers/${row.public_id}/callback`, appUrl).href, ...(transport ? { fetch: transport } : {}) }
}
export async function configureProvider(workspaceId: number, input: Row, actorId: number) {
  return await workspaceTransaction(workspaceId, async () => {
    const owner = await workspace(workspaceId); requireEnterprise(owner, 'oidc')
    if (input.protocol !== 'oidc') fail(503, 'saml_unavailable', 'Only verified OIDC providers are available in this release.')
    const issuer = text(input.issuer, 'issuer', 500), url = new URL(issuer)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) fail(422, 'invalid_issuer', 'Use an approved HTTPS issuer URL.')
    const existing = await one('SELECT * FROM support_enterprise_providers WHERE workspace_id = ?', [workspaceId])
    // An issuer/client change must not reinterpret old subject links. Rotate by
    // removing those links in a reviewed migration, not by editing this row.
    if (existing && (existing.issuer !== issuer || existing.client_id !== input.clientId)) fail(409, 'provider_immutable', 'Provider identity is immutable. Use an operator-reviewed identity migration to replace it.')
    const row = existing ?? await insert('support_enterprise_providers', { workspace_id: workspaceId, public_id: crypto.randomUUID(), protocol: 'oidc', issuer, client_id: text(input.clientId, 'clientId', 500), enabled: true })
    await audit(workspaceId, actorId, 'identity.provider.configured', row.public_id)
    return row
  })
}
export async function issueScimToken(workspaceId: number, actorId: number) {
  return await workspaceTransaction(workspaceId, async () => {
    const owner = await workspace(workspaceId); requireEnterprise(owner, 'scim')
    const idp = await one('SELECT * FROM support_enterprise_providers WHERE workspace_id = ? AND enabled = ?', [workspaceId, true])
    if (!idp) fail(503, 'identity_provider_unavailable', 'Configure a provider before creating a provisioning token.')
    const token = `scim_${secret()}`, expiresAt = Date.now() + 90 * 86400000
    const row = await insert('support_enterprise_scim_tokens', { workspace_id: workspaceId, provider_id: idp.id, digest: digest(token), expires_at: expiresAt, revoked_at: 0 })
    await audit(workspaceId, actorId, 'scim.token.issued', row.id)
    return { id: row.id, token, expiresAt }
  })
}
export async function revokeScimToken(workspaceId: number, reference: unknown, actorId: number) {
  await workspaceTransaction(workspaceId, async () => {
    const row = await one('SELECT id FROM support_enterprise_scim_tokens WHERE id = ? AND workspace_id = ?', [identifier(reference), workspaceId])
    if (!row) fail(404, 'not_found', 'Provisioning token not found.')
    await query('UPDATE support_enterprise_scim_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ?', [Date.now(), row.id, workspaceId])
    await audit(workspaceId, actorId, 'scim.token.revoked', row.id)
  })
}
export async function scimPrincipal(workspaceId: number, token: string) {
  const row = await one('SELECT t.* FROM support_enterprise_scim_tokens t JOIN support_enterprise_providers p ON p.id = t.provider_id AND p.workspace_id = t.workspace_id WHERE t.workspace_id = ? AND t.digest = ? AND t.revoked_at = 0 AND t.expires_at > ? AND p.enabled = ?', [workspaceId, digest(token), Date.now(), true])
  if (!row) fail(401, 'invalid_scim_token', 'A valid workspace provisioning token is required.')
  return row
}
export async function scimIdentity(workspaceId: number, providerId: unknown, reference: unknown) {
  const row = await one('SELECT i.*, m.email, m.role, m.status, m.user_id AS membership_user_id FROM support_enterprise_identities i JOIN support_memberships m ON m.id = i.membership_id AND m.workspace_id = i.workspace_id WHERE i.id = ? AND i.workspace_id = ? AND i.provider_id = ?', [identifier(reference), workspaceId, providerId])
  if (!row) fail(404, 'not_found', 'Provisioned user not found.')
  return row
}
export function scimResource(row: Row) {
  return { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: String(row.id), externalId: String(row.external_id), userName: String(row.email), active: Boolean(row.active) && row.status !== 'revoked', meta: { resourceType: 'User' } }
}
export async function provision(workspaceId: number, principal: Row, input: Row) {
  return await workspaceTransaction(workspaceId, async () => {
    // Recheck authority under the same workspace lock as token revocation.
    const current = await one('SELECT * FROM support_enterprise_scim_tokens WHERE id = ? AND workspace_id = ? AND revoked_at = 0 AND expires_at > ?', [principal.id, workspaceId, Date.now()])
    if (!current) fail(401, 'invalid_scim_token', 'Provisioning token is no longer valid.')
    const owner = await workspace(workspaceId)
    requireEnterprise(owner, 'scim')
    if (process.env.SUPPORT_DEPLOYMENT_MODE === 'hosted') {
      const seats = limitsFor(owner.plan as Plan).seats
      const count = Number((await one("SELECT COUNT(*) AS total FROM support_memberships WHERE workspace_id = ? AND status IN ('active', 'pending')", [workspaceId]))?.total)
      if (seats !== null && count >= seats) fail(402, 'seat_limit', 'Agent allowance includes pending invitations.')
    }
    const email = text(input.userName, 'userName', 254).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(422, 'invalid_input', 'userName must be an email address.')
    if (input.active !== undefined && typeof input.active !== 'boolean') fail(422, 'invalid_input', 'active must be a boolean.')
    if (await one('SELECT id FROM support_memberships WHERE workspace_id = ? AND email = ?', [workspaceId, email])) fail(409, 'uniqueness', 'A workspace membership already uses this address.')
    const externalId = input.externalId === undefined ? crypto.randomUUID() : text(input.externalId, 'externalId', 255)
    if (await one('SELECT id FROM support_enterprise_identities WHERE provider_id = ? AND external_id = ?', [principal.provider_id, externalId])) fail(409, 'uniqueness', 'The external identity already exists.')
    // Provision an agent invitation, never a global account or a privileged role.
    const active = input.active !== false
    const membership = await insert('support_memberships', { workspace_id: workspaceId, user_id: null, email, role: 'agent', status: active ? 'pending' : 'revoked' })
    const row = await insert('support_enterprise_identities', { workspace_id: workspaceId, provider_id: principal.provider_id, membership_id: membership.id, user_id: null, external_id: externalId, subject: null, active })
    await audit(workspaceId, null, 'scim.user.provisioned', row.id)
    return await scimIdentity(workspaceId, principal.provider_id, row.id)
  })
}
export async function setProvisionedActive(workspaceId: number, principal: Row, reference: unknown, active: boolean) {
  return await workspaceTransaction(workspaceId, async () => {
    const current = await one('SELECT id FROM support_enterprise_scim_tokens WHERE id = ? AND workspace_id = ? AND revoked_at = 0 AND expires_at > ?', [principal.id, workspaceId, Date.now()])
    if (!current) fail(401, 'invalid_scim_token', 'Provisioning token is no longer valid.')
    if (active) requireEnterprise(await workspace(workspaceId), 'scim')
    const row = await scimIdentity(workspaceId, principal.provider_id, reference)
    if (row.role === 'owner') fail(403, 'protected_membership', 'Provisioning cannot deactivate a workspace owner.')
    await query('UPDATE support_enterprise_identities SET active = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [active, new Date().toISOString(), row.id, workspaceId])
    await query('UPDATE support_memberships SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', [active ? (row.user_id || row.membership_user_id) ? 'active' : 'pending' : 'revoked', new Date().toISOString(), row.membership_id, workspaceId])
    if (!active && (row.user_id || row.membership_user_id)) {
      // Existing native credentials must lose authority immediately. This
      // signs the account out, but does not remove any other workspace membership.
      await revokeAccountCredentials(Number(row.user_id || row.membership_user_id), { tx: true })
    }
    await audit(workspaceId, null, active ? 'scim.user.reactivated' : 'scim.user.revoked', row.id)
    return await scimIdentity(workspaceId, principal.provider_id, row.id)
  })
}
