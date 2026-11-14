// SPDX-License-Identifier: LicenseRef-HQ-Support-Enterprise
import type { RequestInstance } from '@stacksjs/types'
import type { Row } from '../app/Support/database'
import { Auth, browserSessionCookie, startBrowserSession } from '@stacksjs/auth'
import { clearOAuthFlowCookie, consumeOAuthFlow, issueOAuthFlow, readOAuthFlowCookie } from '@stacksjs/socials'
import { insert, one, query, workspaceTransaction } from '../app/Support/database'
import { SupportError, fail, identifier } from '../app/Support/errors'
import { member, object, workspace } from '../app/Support/service'
import { inspectLicense, requireEnterprise } from './license'
import { applyRetention, configureRetention, previewRetention, retentionHold, retentionPolicy } from './retention'
import { directoryGroup, groupResource, writeGroup } from './groups'
import { audit, configureProvider, issueScimToken, oidcConfig, samlConfig, provider, provision, revokeScimToken, scimIdentity, scimPrincipal, scimResource, setProvisionedActive } from './identity'

export type EnterpriseOperation = 'retention.get' | 'retention.configure' | 'retention.preview' | 'retention.run' | 'retention.hold' | 'status' | 'configure' | 'token.issue' | 'token.revoke' | 'audit' | 'oidc.start' | 'oidc.link' | 'oidc.callback' | 'scim.config' | 'scim.list' | 'scim.get' | 'scim.create' | 'scim.replace' | 'scim.patch' | 'scim.delete' | 'scim.groups.list' | 'scim.groups.get' | 'scim.groups.create' | 'scim.groups.replace' | 'scim.groups.patch' | 'scim.groups.delete' | 'saml.start' | 'saml.link' | 'saml.callback'
const json = (body: unknown, status = 200, scim = false) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...(scim ? { 'Content-Type': 'application/scim+json' } : {}) } })
async function account(request: RequestInstance) {
  const user = await request.user()
  if (!user) fail(401, 'unauthorized', 'Sign in to continue.')
  return { id: Number(user.id), email: String(user.email).toLowerCase() }
}
function activePatch(input: Row): boolean {
  if (!Array.isArray(input.Operations) || input.Operations.length !== 1) fail(400, 'invalidPath', 'Only one active replacement is supported.')
  const operation = object(input.Operations[0]), op = String(operation.op).toLowerCase()
  if (op !== 'replace' || (operation.path !== undefined && String(operation.path).toLowerCase() !== 'active')) fail(400, 'invalidPath', 'Only active replacement is supported.')
  const value = operation.path ? operation.value : object(operation.value).active
  if (typeof value !== 'boolean') fail(400, 'invalidValue', 'active must be a boolean.')
  return value
}
async function finishIdentity(idp: Row, identity: { subject: string, email: string | null, emailVerified: boolean }, flow: { userId: number | null }, clearFlow: string) {
  const workspaceId = Number(idp.workspace_id)
  return await workspaceTransaction(workspaceId, async () => {
        const current = await provider(String(idp.public_id))
        if (current.issuer !== idp.issuer || current.client_id !== idp.client_id) fail(401, 'invalid_sso_state', 'The identity provider changed during sign-in.')
        let linked = await one('SELECT * FROM support_enterprise_identities WHERE workspace_id = ? AND provider_id = ? AND subject = ?', [workspaceId, idp.id, identity.subject])
        if (flow.userId) {
          requireEnterprise(await workspace(workspaceId), idp.protocol === 'saml' ? 'saml' : 'oidc')
          const membership = await member(flow.userId, workspaceId)
          if (!identity.emailVerified || identity.email?.toLowerCase() !== String(membership.email).toLowerCase()) fail(403, 'identity_link_refused', 'The provider must verify the email of your signed-in workspace membership.')
          if (linked && Number(linked.user_id) !== flow.userId) fail(409, 'identity_already_linked', 'This provider identity is linked to another account.')
          if (!linked) {
            linked = await one('SELECT * FROM support_enterprise_identities WHERE workspace_id = ? AND provider_id = ? AND membership_id = ?', [workspaceId, idp.id, membership.id])
            if (linked && (!linked.active || linked.subject)) fail(409, 'identity_link_refused', 'The provisioned identity is inactive or already linked.')
            if (linked) await query('UPDATE support_enterprise_identities SET user_id = ?, subject = ?, updated_at = ? WHERE id = ?', [flow.userId, identity.subject, new Date().toISOString(), linked.id])
            else linked = await insert('support_enterprise_identities', { workspace_id: workspaceId, provider_id: idp.id, membership_id: membership.id, user_id: flow.userId, external_id: crypto.randomUUID(), subject: identity.subject, active: true })
          }
          await audit(workspaceId, flow.userId, 'identity.linked', linked.id)
          const result = json({ linked: true }); result.headers.append('Set-Cookie', clearFlow); return result
        }
        if (!linked?.active || !linked.user_id) fail(403, 'identity_not_linked', 'Sign in with your native account and link this provider before using SSO.')
        await member(Number(linked.user_id), workspaceId)
        const issued = await Auth.loginUsingId(Number(linked.user_id))
        if (!issued) fail(401, 'native_signin_refused', 'The native account is unavailable.')
        const session = await startBrowserSession(issued.token)
        if (!session) fail(401, 'native_signin_refused', 'A native session could not be created.')
        await audit(workspaceId, Number(linked.user_id), 'identity.signed_in', linked.id)
        const result = new Response(null, { status: 302, headers: { Location: '/', 'Cache-Control': 'no-store' } })
        result.headers.append('Set-Cookie', browserSessionCookie(session)); result.headers.append('Set-Cookie', clearFlow)
        return result
      })
}
export async function enterpriseHttp(request: RequestInstance, operation: EnterpriseOperation, transport?: typeof fetch): Promise<Response> {
  const scim = operation.startsWith('scim.')
  let clearFlow = ''
  try {
    const input = object(request.all())
    if (JSON.stringify(input).length > 50_000) fail(413, 'body_too_large', 'Request body is too large.')
    if (operation.startsWith('saml.')) {
      const idp = await provider(request.getParam('provider')), config = samlConfig(idp)
      const { enterpriseSamlAuthorization, enterpriseSamlRequest, verifyEnterpriseSamlResponse } = await import('@stacksjs/auth/enterprise-saml')
      const purpose = `enterprise-saml:${idp.public_id}`
      if (operation !== 'saml.callback') {
        let userId: number | undefined
        if (operation === 'saml.link') {
          const user = await account(request)
          requireEnterprise(await workspace(Number(idp.workspace_id)), 'saml')
          await member(user.id, Number(idp.workspace_id))
          if (!(await one('SELECT email_verified_at FROM users WHERE id = ?', [user.id]))?.email_verified_at) fail(403, 'verified_account_required', 'Verify your native account before linking SSO.')
          userId = user.id
        }
        const challenge = enterpriseSamlRequest()
        const flow = await issueOAuthFlow({ purpose, ttlMs: 300_000, bindBrowser: true, ...(userId ? { userId } : {}), data: { ...challenge, issuer: idp.issuer, clientId: idp.client_id }, cookie: { secure: true, sameSite: 'None' } })
        const result = new Response(null, { status: 302, headers: { Location: await enterpriseSamlAuthorization(config, flow.state, challenge), 'Cache-Control': 'no-store' } })
        if (flow.cookie) result.headers.append('Set-Cookie', flow.cookie)
        return result
      }
      const form = object((request as { formBody?: Row }).formBody)
      const state = String(form.RelayState ?? input.RelayState ?? '')
      clearFlow = await clearOAuthFlowCookie(state, { secure: true, sameSite: 'None' })
      const flow = await consumeOAuthFlow(state, { purpose, browserSecret: readOAuthFlowCookie(request.headers.get('cookie'), state) })
      if (!flow?.data || flow.data.issuer !== idp.issuer || flow.data.clientId !== idp.client_id || typeof flow.data.requestId !== 'string' || typeof flow.data.createdAt !== 'number') fail(401, 'invalid_sso_state', 'SAML expired, was already used, or belongs to another browser.')
      let identity
      try { identity = await verifyEnterpriseSamlResponse(config, String(form.SAMLResponse ?? input.SAMLResponse ?? ''), { requestId: flow.data.requestId, createdAt: flow.data.createdAt }) }
      catch { fail(401, 'invalid_sso_assertion', 'The signed SAML assertion could not be verified.') }
      return await finishIdentity(idp, identity, flow, clearFlow)
    }
    if (operation.startsWith('oidc.')) {
      const idp = await provider(request.getParam('provider'))
      const config = oidcConfig(idp, transport), workspaceId = Number(idp.workspace_id)
      const { enterpriseOidcAuthorization, enterpriseOidcChallenge, verifyEnterpriseOidcCallback } = await import('@stacksjs/auth/enterprise-oidc')
      const purpose = `enterprise:${idp.public_id}`
      if (operation !== 'oidc.callback') {
        let userId: number | undefined
        if (operation === 'oidc.link') {
          const user = await account(request)
          requireEnterprise(await workspace(workspaceId), 'oidc')
          await member(user.id, workspaceId)
          const native = await one('SELECT email_verified_at FROM users WHERE id = ?', [user.id])
          if (!native?.email_verified_at) fail(403, 'verified_account_required', 'Verify your native account email before linking SSO.')
          userId = user.id
        }
        const challenge = enterpriseOidcChallenge()
        const flow = await issueOAuthFlow({ purpose, ttlMs: 5 * 60_000, bindBrowser: true, nonce: challenge.nonce, ...(userId ? { userId } : {}), data: { verifier: challenge.verifier, provider: idp.public_id, issuer: idp.issuer, clientId: idp.client_id }, cookie: { secure: true, sameSite: 'Lax' } })
        challenge.state = flow.state
        const redirect = new Response(null, { status: 302, headers: { Location: await enterpriseOidcAuthorization(config, challenge), 'Cache-Control': 'no-store' } })
        if (flow.cookie) redirect.headers.append('Set-Cookie', flow.cookie)
        return redirect
      }
      const state = new URL(request.url).searchParams.get('state') ?? ''
      clearFlow = await clearOAuthFlowCookie(state, { secure: true, sameSite: 'Lax' })
      const flow = await consumeOAuthFlow(state, { purpose, browserSecret: readOAuthFlowCookie(request.headers.get('cookie'), state) })
      if (!flow?.nonce || typeof flow.data?.verifier !== 'string' || flow.data.issuer !== idp.issuer || flow.data.clientId !== idp.client_id || flow.data.provider !== idp.public_id) fail(401, 'invalid_sso_state', 'SSO expired, was already used, or belongs to another browser.')
      // Use the canonical operator-configured redirect origin, never a Host header.
      const callback = config.redirectUri + new URL(request.url).search
      let identity
      try { identity = await verifyEnterpriseOidcCallback(config, callback, { state, nonce: flow.nonce, verifier: flow.data.verifier }) }
      catch { fail(401, 'invalid_sso_assertion', 'The identity provider response could not be verified.') }
      return await finishIdentity(idp, identity, flow, clearFlow)
    }
    const workspaceId = identifier(request.getParam('workspace'))
    if (scim) {
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
      const principal = await scimPrincipal(workspaceId, token)
      if (operation.startsWith('scim.groups.')) {
        if (operation === 'scim.groups.list') {
          const params = new URL(request.url).searchParams, filter = params.get('filter'), match = filter ? /^displayName eq "([^"\\]+)"$/.exec(filter) : null
          if (filter && !match) fail(400, 'invalidFilter', 'Only displayName eq filters are supported.')
          const start = Number(params.get('startIndex') || 1), count = Math.min(100, Number(params.get('count') ?? 100))
          if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 0) fail(400, 'invalidValue', 'Invalid pagination values.')
          const where = 'workspace_id = ? AND provider_id = ?' + (match ? ' AND display_name = ?' : ''), values = [workspaceId, principal.provider_id, ...(match ? [match[1]] : [])]
          const total = Number((await one(`SELECT COUNT(*) AS total FROM support_enterprise_groups WHERE ${where}`, values))?.total)
          const rows = await query(`SELECT * FROM support_enterprise_groups WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`, [...values, count, start - 1])
          return json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: await Promise.all(rows.map(groupResource)) }, 200, true)
        }
        if (operation === 'scim.groups.get') return json(await groupResource(await directoryGroup(workspaceId, principal.provider_id, request.getParam('id'))), 200, true)
        const action = operation.split('.').at(-1) as 'create' | 'replace' | 'patch' | 'delete'
        const row = await writeGroup(workspaceId, principal, action, input, request.getParam('id'))
        return row ? json(await groupResource(row), action === 'create' ? 201 : 200, true) : new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
      }
      if (operation === 'scim.config') return json({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 100 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false }, authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Workspace bearer token', description: 'A revocable workspace provisioning token', primary: true }] }, 200, true)
      if (operation === 'scim.list') {
        const params = new URL(request.url).searchParams, filter = params.get('filter')
        const match = filter ? /^userName eq "([^"\\]+)"$/.exec(filter) : null
        if (filter && !match) fail(400, 'invalidFilter', 'Only userName eq filters are supported.')
        const start = Math.max(1, Number(params.get('startIndex') || 1)), count = Math.min(100, Math.max(0, Number(params.get('count') ?? 100)))
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count)) fail(400, 'invalidValue', 'Invalid pagination values.')
        const where = 'i.workspace_id = ? AND i.provider_id = ? AND i.deleted_at = 0' + (match ? ' AND m.email = ?' : ''), values = [workspaceId, principal.provider_id, ...(match ? [match[1]!.toLowerCase()] : [])]
        const total = Number((await one(`SELECT COUNT(*) AS total FROM support_enterprise_identities i JOIN support_memberships m ON m.id = i.membership_id AND m.workspace_id = i.workspace_id WHERE ${where}`, values))?.total)
        const rows = await query(`SELECT i.*, m.email, m.status FROM support_enterprise_identities i JOIN support_memberships m ON m.id = i.membership_id AND m.workspace_id = i.workspace_id WHERE ${where} ORDER BY i.id LIMIT ? OFFSET ?`, [...values, count, start - 1])
        return json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: rows.map(scimResource) }, 200, true)
      }
      if (operation === 'scim.get') return json(scimResource(await scimIdentity(workspaceId, principal.provider_id, request.getParam('id'))), 200, true)
      if (operation === 'scim.create') return json(scimResource(await provision(workspaceId, principal, input)), 201, true)
      const active = operation === 'scim.delete' ? false : operation === 'scim.patch' ? activePatch(input) : input.active
      if (typeof active !== 'boolean') fail(400, 'invalidValue', 'active must be a boolean.')
      if (operation === 'scim.replace') {
        const row = await scimIdentity(workspaceId, principal.provider_id, request.getParam('id'))
        if (input.userName !== row.email || (input.externalId !== undefined && input.externalId !== row.external_id)) fail(400, 'mutability', 'Renaming provisioned identities is not supported.')
      }
      const updated = await setProvisionedActive(workspaceId, principal, request.getParam('id'), active, operation === 'scim.delete')
      return operation === 'scim.delete' ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : json(scimResource(updated), 200, true)
    }
    const user = await account(request)
    await member(user.id, workspaceId, ['owner', 'admin'])
    if (operation === 'retention.get') return json({ policy: await retentionPolicy(workspaceId) })
    if (operation === 'retention.configure') return json({ policy: await configureRetention(workspaceId, input, user.id) })
    if (operation === 'retention.preview') return json(await previewRetention(workspaceId))
    if (operation === 'retention.hold') return json(await retentionHold(workspaceId, request.getParam('id'), input, user.id))
    if (operation === 'retention.run') return json(await applyRetention(workspaceId, user.id))
    if (operation === 'status') return json({ license: inspectLicense(String((await workspace(workspaceId)).public_id)), provider: await one('SELECT public_id, protocol, issuer, client_id, enabled FROM support_enterprise_providers WHERE workspace_id = ?', [workspaceId]), samlAvailable: true })
    if (operation === 'configure') return json({ provider: await configureProvider(workspaceId, input, user.id) }, 201)
    if (operation === 'token.issue') return json(await issueScimToken(workspaceId, user.id), 201)
    if (operation === 'token.revoke') { await revokeScimToken(workspaceId, request.getParam('id'), user.id); return json({ revoked: true }) }
    if (operation === 'audit') {
      const cursor = new URL(request.url).searchParams.get('cursor'), after = cursor ? identifier(cursor) : 0
      const events = await query('SELECT id, actor_id, action, target_id, detail, created_at FROM support_enterprise_audit_events WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 100', [workspaceId, after])
      return json({ events, nextCursor: events.length === 100 ? String(events.at(-1)!.id) : null })
    }
    fail(404, 'not_found', 'Endpoint not found.')
  }
  catch (error) {
    if (!(error instanceof SupportError)) {
      console.error('[enterprise]', error instanceof Error ? error.name : 'UnknownError')
      if (process.env.APP_ENV === 'test') console.error(error)
    }
    const status = error instanceof SupportError ? error.status : 503
    const code = error instanceof SupportError ? error.code : 'enterprise_unavailable'
    const message = error instanceof SupportError ? error.message : 'Enterprise identity is temporarily unavailable.'
    const result = scim ? json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), scimType: code, detail: message }, status, true) : json({ error: { code, message } }, status)
    if (clearFlow) result.headers.append('Set-Cookie', clearFlow)
    return result
  }
}
