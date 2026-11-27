import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { overridesReady, config } from '@stacksjs/config'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { route } from '@stacksjs/router'
import { one, query } from '../../app/Support/database'
import { inspectLicense } from '../../enterprise/license'
import { createConversation } from '../../app/Support/service'
import { upload } from '../../app/Support/attachments'
import { Storage } from '@stacksjs/storage'
import { retentionMarker } from '../../enterprise/retention'
import { samlTestKey, samlTestCert, samlRequestId, signedSamlResponse } from './enterprise-saml-sign'
import { enterpriseAction } from '../../app/Actions/Support/EnterpriseAction'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const issuer = 'https://identity.example.test'
const defaultOidcEndpoints = { authorizationEndpoint: issuer + '/authorize', tokenEndpoint: issuer + '/token' }
const splitOidcEndpoints = { authorizationEndpoint: 'https://login.example.test/oauth2/authorize', tokenEndpoint: 'https://login.example.test/oauth2/token' }
let oidcEndpoints = defaultOidcEndpoints
let tokenRequests = 0
const signing = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const jwk = { ...await crypto.subtle.exportKey('jwk', signing.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
let providerNonce = '', assertionSubject = 'agent-subject', assertionAudience = 'hq-support', assertionEmail = 'agent@example.test', assertionUnsigned = false
const providerFetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer, authorization_endpoint: oidcEndpoints.authorizationEndpoint, token_endpoint: oidcEndpoints.tokenEndpoint, jwks_uri: issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] })
  if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] })
  tokenRequests++
  assert.equal(url, oidcEndpoints.tokenEndpoint)
  const body = `${encode({ alg: assertionUnsigned ? 'none' : 'RS256', kid: 'fixture' })}.${encode({ iss: issuer, sub: assertionSubject, aud: assertionAudience, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: providerNonce, email: assertionEmail, email_verified: true, roles: ['owner'] })}`
  const signature = assertionUnsigned ? '' : Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signing.privateKey, new TextEncoder().encode(body))).toString('base64url')
  return Response.json({ access_token: 'provider-token', token_type: 'Bearer', id_token: `${body}.${signature}` })
}) as typeof fetch
// Same native Action and HTTP middleware; only provider HTTP is injected.
route.get('/api/_enterprise/providers/{provider}/login', enterpriseAction('oidc.start', 'GET', providerFetch))
route.post('/api/_enterprise/providers/{provider}/link', enterpriseAction('oidc.link', 'POST', providerFetch)).middleware('auth')
route.get('/api/_enterprise/providers/{provider}/callback', enterpriseAction('oidc.callback', 'GET', providerFetch))
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let checks = 0, csrf = '', cookie = ''
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function request(path: string, method = 'GET', body?: unknown, token?: string, cookies = cookie) {
  const result = await fetch(base + path, { method, redirect: 'manual', headers: { accept: 'application/json', ...(cookies ? { cookie: cookies, 'x-csrf-token': csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const raw = await result.text()
  let data: any = null
  if (raw) { try { data = JSON.parse(raw) } catch { throw new Error(`${path} returned ${result.status}: ${raw.slice(0, 300)}`) } }
  return { status: result.status, data, headers: result.headers }
}
async function nativeAccount(email: string) {
  const registration = await request('/register', 'POST', { name: email.split('@')[0] + ' User', email, password: 'SecureSupport2026!', password_confirmation: 'SecureSupport2026!' })
  check([200, 201].includes(registration.status), `native registration ${registration.status}`)
  const login = await request('/login', 'POST', { email, password: 'SecureSupport2026!' })
  const token = login.data.token ?? login.data.access_token ?? login.data.data?.token
  check(typeof token === 'string', 'native bearer issued')
  return token as string
}
const licenseKeys = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')
process.env.SUPPORT_ENTERPRISE_LICENSE_PUBLIC_KEY = String(licenseKeys.publicKey.export({ type: 'spki', format: 'pem' }))
process.env.SUPPORT_INSTALLATION_ID = 'fixture-installation'
function license(workspace: string, expiresAt = Date.now() + 86400000, signingKey = licenseKeys.privateKey) {
  const body = Buffer.from(JSON.stringify({ version: 1, licenseId: 'fixture-license', installation: 'fixture-installation', workspace, issuedAt: Date.now() - 86400000, expiresAt, features: ['oidc', 'saml', 'scim', 'audit', 'retention'] })).toString('base64url')
  return `${body}.${sign(null, Buffer.from(body), signingKey).toString('base64url')}`
}
async function start(provider: string, linkingToken?: string) {
  const flow = await request(`/_enterprise/providers/${provider}/${linkingToken ? 'link' : 'login'}`, linkingToken ? 'POST' : 'GET', linkingToken ? {} : undefined, linkingToken)
  check(flow.status === 302, `SSO starts ${flow.status} ${JSON.stringify(flow.data)}`)
  const url = new URL(flow.headers.get('location')!)
  check(url.origin + url.pathname === oidcEndpoints.authorizationEndpoint, 'SSO uses the expected provider login endpoint')
  providerNonce = url.searchParams.get('nonce')!
  check(url.searchParams.get('code_challenge_method') === 'S256', 'SSO uses PKCE')
  return { state: url.searchParams.get('state')!, cookie: flow.headers.get('set-cookie')!.split(';')[0]! }
}
try {
  const challenge = await request('/csrf-token'); csrf = challenge.data.token; cookie = challenge.headers.get('set-cookie')!.split(';')[0]!
  const owner = await nativeAccount('owner@example.test'), agent = await nativeAccount('agent@example.test'), outsider = await nativeAccount('outsider@example.test')
  const created = await request('/support/workspaces', 'POST', { name: 'Enterprise One' }, owner)
  check(created.status === 201, 'native workspace created')
  const otherWorkspace = (await request('/support/workspaces', 'POST', { name: 'Agent Independent Workspace' }, agent)).data.workspace
  const otherProject = (await request(`/support/workspaces/${otherWorkspace.id}/projects`, 'POST', { name: 'Independent Project' }, agent)).data.project
  const affectedProject = (await request(`/support/workspaces/${created.data.workspace.id}/projects`, 'POST', { name: 'Enterprise Project' }, owner)).data.project
  const workspace = created.data.workspace, workspacePath = `/support/workspaces/${workspace.id}/enterprise`, scimPath = `/scim/v2/${workspace.id}`
  check((await request(workspacePath + '/provider', 'POST', { protocol: 'oidc', issuer, clientId: 'hq-support' }, owner)).status === 402, 'missing license rejects enterprise configuration')
  process.env.SUPPORT_ENTERPRISE_LICENSE = license(workspace.public_id, Date.now() + 86400000, otherKeys.privateKey)
  check(inspectLicense(workspace.public_id).status === 'invalid', 'wrong signing authority refused')
  process.env.SUPPORT_ENTERPRISE_LICENSE = license('foreign-workspace')
  check(inspectLicense(workspace.public_id).status === 'invalid', 'license workspace binding enforced')
  process.env.SUPPORT_ENTERPRISE_LICENSE = license(workspace.public_id)
  check(inspectLicense(workspace.public_id).status === 'active', 'valid Ed25519 license accepted')
  check(inspectLicense(workspace.public_id, { token: process.env.SUPPORT_ENTERPRISE_LICENSE, publicKey: process.env.SUPPORT_ENTERPRISE_LICENSE_PUBLIC_KEY, installation: 'foreign-installation' }).status === 'invalid', 'license installation binding enforced')
  const configured = await request(workspacePath + '/provider', 'POST', { protocol: 'oidc', issuer, clientId: 'hq-support' }, owner)
  check(configured.status === 201, `OIDC configured ${JSON.stringify(configured.data)}`)
  const idp = configured.data.provider
  check((await request(`/enterprise/providers/${idp.public_id}/login`)).status === 503, 'unconfigured provider secrets explicit 503')
  process.env.SUPPORT_ENTERPRISE_OIDC_CLIENTS = JSON.stringify({ [idp.public_id]: 'provider-fixture-secret' })
  process.env.SUPPORT_ENTERPRISE_OIDC_ISSUERS = JSON.stringify([issuer])
  check((await request(workspacePath + '/audit', 'GET', undefined, outsider)).status === 403, 'workspace audit export excludes foreign native users')
  check((await request(workspacePath + '/scim-tokens', 'POST', {}, outsider)).status === 403, 'foreign native user cannot issue token')
  const issued = await request(workspacePath + '/scim-tokens', 'POST', {}, owner)
  check(issued.status === 201 && issued.data.token.startsWith('scim_'), 'workspace SCIM token issued')
  const scimToken = issued.data.token
  check((await request(scimPath + '/Users', 'GET')).status === 401, 'SCIM requires dedicated bearer')
  check((await request(`/scim/v2/${Number(workspace.id) + 1}/Users`, 'GET', undefined, scimToken)).status === 401, 'SCIM token bound to workspace')
  const discoveredSchemas = await request(scimPath + '/Schemas', 'GET', undefined, scimToken)
  check(discoveredSchemas.status === 200, `SCIM schema discovery returns HTTP 200, got ${discoveredSchemas.status}`)
  check(discoveredSchemas.headers.get('content-type') === 'application/scim+json' && discoveredSchemas.headers.get('cache-control') === 'no-store', 'discovery uses the SCIM media type and is not cached')
  check(discoveredSchemas.data.schemas[0] === 'urn:ietf:params:scim:api:messages:2.0:ListResponse' && discoveredSchemas.data.totalResults === 2, 'discovery lists both shipped schemas')
  const discoveredTypes = await request(scimPath + '/ResourceTypes', 'GET', undefined, scimToken)
  check(discoveredTypes.status === 200 && discoveredTypes.data.totalResults === 2, 'discovery lists both shipped resource types')
  const unpaginated = await request(scimPath + '/Schemas?startIndex=10&count=0', 'GET', undefined, scimToken)
  check(unpaginated.status === 200 && unpaginated.data.Resources.length === 2, 'SCIM discovery ignores pagination')
  for (const endpoint of ['/Schemas', '/ResourceTypes']) {
    const filtered = await request(scimPath + endpoint + '?filter=' + encodeURIComponent('name eq "Missing"'), 'GET', undefined, scimToken)
    check(filtered.status === 403 && filtered.data.scimType === 'invalidFilter', 'SCIM discovery rejects unsupported filters')
  }
  for (const [name, endpoint, fields] of [['User', '/Users', ['userName', 'active']], ['Group', '/Groups', ['displayName', 'members']]] as const) {
    const id = `urn:ietf:params:scim:schemas:core:2.0:${name}`
    const schema = await request(scimPath + '/Schemas/' + encodeURIComponent(id), 'GET', undefined, scimToken)
    const type = await request(scimPath + '/ResourceTypes/' + name, 'GET', undefined, scimToken)
    check(schema.status === 200 && schema.data.id === id && schema.data.name === name && schema.data.meta.resourceType === 'Schema', `SCIM discovers the individual ${name} schema`)
    check(type.status === 200 && type.data.id === name && type.data.endpoint === endpoint && type.data.schema === id && type.data.meta.resourceType === 'ResourceType', `SCIM discovers the individual ${name} resource type`)
    check(fields.every(field => schema.data.attributes.some((attribute: { name: string }) => attribute.name === field)), `SCIM advertises supported ${name} fields`)
    check(!schema.data.attributes.some((attribute: { name: string }) => ['password', 'roles', 'entitlements'].includes(attribute.name)), `SCIM leaves unsupported ${name} fields out of discovery`)
    check(schema.data.meta.location === '/api' + scimPath + '/Schemas/' + id, `SCIM publishes a followable ${name} schema location`)
    check(type.data.meta.location === '/api' + scimPath + '/ResourceTypes/' + name, `SCIM publishes a followable ${name} type location`)
    check(schema.headers.get('content-location') === schema.data.meta.location && type.headers.get('content-location') === type.data.meta.location,
      'SCIM discovery detail uses Content-Location matching the resource metadata')
    if (name === 'Group') {
      const members = schema.data.attributes.find((attribute: { name: string }) => attribute.name === 'members')
      check(members.subAttributes.some((attribute: { name: string, required: boolean }) => attribute.name === 'value' && attribute.required), 'group discovery requires a member resource ID')
    }
    const linkedSchema = await request(schema.data.meta.location.slice('/api'.length), 'GET', undefined, scimToken)
    check(linkedSchema.status === 200 && linkedSchema.data.id === id, 'SCIM follows the schema location')
  }
  for (const path of ['/Schemas', '/Schemas/no-schema', '/ResourceTypes', '/ResourceTypes/no-type']) {
    check((await request(scimPath + path)).status === 401, 'SCIM discovery requires a provisioning token')
    check((await request(`/scim/v2/${otherWorkspace.id}` + path, 'GET', undefined, scimToken)).status === 401, 'SCIM discovery remains workspace scoped')
  }
  for (const path of ['/Schemas/no-schema', '/ResourceTypes/no-type']) {
    const missing = await request(scimPath + path, 'GET', undefined, scimToken)
    check(missing.status === 404 && missing.data.schemas[0] === 'urn:ietf:params:scim:api:messages:2.0:Error', 'unsupported discovery resources return SCIM 404')
  }
  const userExternalId = 'Agent "stable" \\ 1'
  const provisioned = await request(scimPath + '/Users', 'POST', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], externalId: userExternalId, userName: 'agent@example.test', active: true, roles: ['owner'] }, scimToken)
  check(provisioned.status === 201, `SCIM provisions ${JSON.stringify(provisioned.data)}`)
  check((await one('SELECT role FROM support_memberships WHERE workspace_id = ? AND email = ?', [workspace.id, 'agent@example.test']))?.role === 'agent', 'SCIM cannot grant privileged role')
  const groupExternalId = 'Group "stable" \\ 1'
  const group = await request(scimPath + '/Groups', 'POST', { externalId: groupExternalId, displayName: 'Support Team', members: [{ value: provisioned.data.id }], roles: ['owner'] }, scimToken)
  check(group.status === 201 && group.data.members.length === 1, `SCIM group provisioning ${JSON.stringify(group.data)}`)
  check((await request(`/scim/v2/${otherWorkspace.id}/Groups/${group.data.id}`, 'GET', undefined, scimToken)).status === 401, 'directory group token cannot cross workspace boundary')
  check((await request(scimPath + `/Groups/${group.data.id}`, 'PATCH', { Operations: [{ op: 'add', path: 'members', value: [{ value: '999999999' }] }] }, scimToken)).status === 404, 'directory group rejects unscoped or unknown user resource')
  const removedMember = await request(scimPath + `/Groups/${group.data.id}`, 'PATCH', { Operations: [{ op: 'remove', path: `members[value eq "${provisioned.data.id}"]` }] }, scimToken)
  check(removedMember.status === 200 && removedMember.data.members.length === 0, 'SCIM filtered member removal')
  check((await request(scimPath + `/Groups/${group.data.id}`, 'PATCH', { Operations: [{ op: 'add', path: 'members', value: [{ value: provisioned.data.id }] }] }, scimToken)).status === 200, 'SCIM group member add')
  const groups = await request(scimPath + '/Groups?filter=' + encodeURIComponent('displayName eq "Support Team"'), 'GET', undefined, scimToken)
  check(groups.status === 200 && groups.data.totalResults === 1, 'SCIM directory group filter')
  const lookup = (resource: 'Users' | 'Groups', filter: string) => request(scimPath + '/' + resource + '?filter=' + encodeURIComponent(filter), 'GET', undefined, scimToken)
  const mixedCaseUser = await lookup('Users', 'USERNAME Eq "AGENT@example.test"')
  check(mixedCaseUser.status === 200 && mixedCaseUser.data.Resources[0]?.id === provisioned.data.id, 'SCIM compares filter names and operators without case')
  const groupName = 'Escalations "Tier 2" \\ EMEA\u2028Group'
  const renamedGroup = await request(scimPath + '/Groups/' + group.data.id, 'PATCH', { Operations: [{ op: 'replace', path: 'displayName', value: groupName }] }, scimToken)
  check(renamedGroup.status === 200 && renamedGroup.data.displayName === groupName, 'SCIM accepts quoted group names')
  const groupByName = await lookup('Groups', 'DISPLAYNAME EQ ' + JSON.stringify(groupName))
  check(groupByName.status === 200 && groupByName.data.Resources[0]?.id === group.data.id, 'SCIM decodes JSON string escapes when matching a group name')
  check((await lookup('Groups', 'displayName eq "Support Team"')).data.totalResults === 0, 'a renamed group no longer matches its old name')
  for (const [resource, externalId, expected] of [['Users', userExternalId, provisioned.data.id], ['Groups', groupExternalId, group.data.id]] as const) {
    const expression = 'EXTERNALid Eq ' + JSON.stringify(externalId)
    const result = await lookup(resource, expression)
    check(result.status === 200 && result.data.totalResults === 1 && result.data.Resources[0]?.id === expected, 'SCIM resolves the stable external ID exactly')
    const query = new URLSearchParams([['filter', expression], ['filter', 'externalId eq "other"']])
    const repeated = await request(`${scimPath}/${resource}?${query}`, 'GET', undefined, scimToken)
    check(repeated.status === 400 && repeated.data.scimType === 'invalidFilter', 'SCIM rejects duplicate filter query parameters')
    const foreign = await request(`/scim/v2/${otherWorkspace.id}/${resource}?filter=${encodeURIComponent(expression)}`, 'GET', undefined, scimToken)
    check(foreign.status === 401 && foreign.headers.get('content-type') === 'application/scim+json', 'external ID lookup requires a token for that workspace')
    const otherCase = await lookup(resource, 'externalId eq ' + JSON.stringify(externalId.toLowerCase()))
    check(otherCase.status === 200 && otherCase.data.totalResults === 0 && otherCase.data.Resources.length === 0, 'SCIM keeps external ID values case-sensitive')
    const invalidValues = [String.fromCharCode(0), String.fromCharCode(0xd800)].map(value => 'externalId eq ' + JSON.stringify(value))
    for (const invalid of ['', 'externalId sw "Agent"', 'externalId eq 42', 'externalId eq "a" or externalId eq "b"', 'externalId eq "bad\\q"', ...invalidValues]) {
      const failure = await lookup(resource, invalid)
      check(failure.status === 400 && failure.data.scimType === 'invalidFilter', 'SCIM rejects unsupported or malformed equality filters')
    }
  }
  const membership = await one('SELECT * FROM support_memberships WHERE workspace_id = ? AND email = ?', [workspace.id, 'agent@example.test'])
  check(membership?.status === 'pending' && membership.user_id === null, 'SCIM creates invitation without account takeover')
  const unlinked = await start(idp.public_id)
  check((await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${unlinked.state}`, 'GET', undefined, undefined, unlinked.cookie)).status === 403, 'provider email cannot auto-link existing native account')
  await query('UPDATE users SET email_verified_at = ? WHERE email = ?', [new Date().toISOString(), 'agent@example.test'])
  const accepted = await request(`/support/invitations/${membership!.id}/accept`, 'POST', {}, agent)
  check(accepted.status === 200, `native account accepts scoped invitation ${accepted.status} ${JSON.stringify(accepted.data)}`)
  const link = await start(idp.public_id, agent)
  check((await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${link.state}`, 'GET', undefined, undefined, '')).status === 401, 'browser binding rejects missing cookie')
  const linked = await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${link.state}`, 'GET', undefined, undefined, link.cookie)
  check(linked.status === 200 && linked.data.linked, `authenticated native user links verified provider subject ${JSON.stringify(linked.data)}`)
  check((await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${link.state}`, 'GET', undefined, undefined, link.cookie)).status === 401, 'SSO state cannot replay')
  const managedLoginPath = `/_enterprise/providers/${idp.public_id}/login`
  const configuredClients = process.env.SUPPORT_ENTERPRISE_OIDC_CLIENTS!
  try {
    process.env.SUPPORT_ENTERPRISE_OIDC_CLIENTS = 'null'
    const invalidClients = await request(managedLoginPath)
    check(invalidClients.status === 503 && invalidClients.data.error?.code === 'identity_provider_unavailable', `invalid client mapping refuses login with HTTP 503, received ${invalidClients.status}`)
  }
  finally {
    process.env.SUPPORT_ENTERPRISE_OIDC_CLIENTS = configuredClients
  }
  oidcEndpoints = splitOidcEndpoints
  const initialTokenRequests = tokenRequests
  process.env.SUPPORT_ENTERPRISE_OIDC_ENDPOINTS = JSON.stringify({ [crypto.randomUUID()]: splitOidcEndpoints })
  check((await request(managedLoginPath)).status === 503, 'another provider approval cannot authorize this login')
  process.env.SUPPORT_ENTERPRISE_OIDC_ENDPOINTS = JSON.stringify({ [idp.public_id]: { authorizationEndpoint: splitOidcEndpoints.authorizationEndpoint, tokenEndpoint: 23 } })
  check((await request(managedLoginPath)).data.error.code === 'identity_provider_unavailable', 'invalid operator endpoint configuration is refused')
  process.env.SUPPORT_ENTERPRISE_OIDC_ENDPOINTS = JSON.stringify({ [idp.public_id]: splitOidcEndpoints })
  const pinnedLogin = await start(idp.public_id)
  process.env.SUPPORT_ENTERPRISE_OIDC_ENDPOINTS = JSON.stringify({ [idp.public_id]: { ...splitOidcEndpoints, tokenEndpoint: splitOidcEndpoints.tokenEndpoint + '/other' } })
  check((await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${pinnedLogin.state}`, 'GET', undefined, undefined, pinnedLogin.cookie)).status === 401, 'callback rejects a mismatched approved URL')
  check(tokenRequests === initialTokenRequests, 'unapproved endpoint receives no token requests')
  process.env.SUPPORT_ENTERPRISE_OIDC_ENDPOINTS = JSON.stringify({ [idp.public_id]: splitOidcEndpoints })
  const managedLogin = await start(idp.public_id)
  const managedCallback = await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${managedLogin.state}`, 'GET', undefined, undefined, managedLogin.cookie)
  check(managedCallback.status === 302 && managedCallback.headers.get('set-cookie')?.includes('session_id='), 'the managed provider creates a native browser session')
  check(tokenRequests === initialTokenRequests + 1, 'success uses the approved token endpoint once')
  delete process.env.SUPPORT_ENTERPRISE_OIDC_ENDPOINTS
  oidcEndpoints = defaultOidcEndpoints
  const bad = await start(idp.public_id); assertionAudience = 'wrong-client'
  check((await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${bad.state}`, 'GET', undefined, undefined, bad.cookie)).status === 401, 'OIDC wrong audience refused over actual HTTP')
  assertionAudience = 'hq-support'
  const unsigned = await start(idp.public_id); assertionUnsigned = true
  check((await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${unsigned.state}`, 'GET', undefined, undefined, unsigned.cookie)).status === 401, 'unsigned assertion refused over HTTP')
  assertionUnsigned = false
  Storage.init({ default: 'local', disks: { local: { driver: 'local', root: process.env.SUPPORT_TEST_STORAGE! } } })
  const retained = (await createConversation(affectedProject, { externalId: 'retention-customer' }, { idempotencyKey: 'retention-one', subject: 'Old private subject', body: 'Old private message' })).conversation
  const held = (await createConversation(affectedProject, { externalId: 'retention-customer' }, { idempotencyKey: 'retention-held', subject: 'Held private subject', body: 'Held private message' })).conversation
  const open = (await createConversation(affectedProject, { externalId: 'retention-customer' }, { idempotencyKey: 'retention-open', subject: 'Open private subject', body: 'Open private message' })).conversation
  const foreign = (await createConversation(otherProject, { externalId: 'independent-retention' }, { idempotencyKey: 'foreign-retention', subject: 'Foreign old subject', body: 'Foreign old message' })).conversation
  const file = await upload(affectedProject, retained.id, new File(['private attachment contents'], 'private.txt', { type: 'text/plain' }), 'retention-file')
  const old = new Date(Date.now() - 100 * 86400000).toISOString()
  for (const thread of [retained, held, foreign]) await query("UPDATE support_conversations SET status = 'closed', updated_at = ? WHERE id = ?", [old, thread.id])
  await query('UPDATE support_conversations SET updated_at = ? WHERE id = ?', [old, open.id])
  check((await request(workspacePath + '/retention', 'PUT', { days: 1, enabled: true }, owner)).status === 422, 'retention refuses unsafe short window')
  check((await request(workspacePath + '/retention', 'PUT', { days: 30, enabled: true }, outsider)).status === 403, 'retention configuration requires workspace administrator')
  check((await request(workspacePath + '/retention', 'PUT', { days: 30, enabled: true }, owner)).status === 200, 'native opt-in retention policy configured')
  check((await request(workspacePath + `/retention/holds/${held.id}`, 'PUT', { active: true, reason: 'Customer legal hold' }, owner)).status === 200, 'workspace legal hold set')
  check((await request(workspacePath + `/retention/holds/${foreign.id}`, 'PUT', { active: true, reason: 'Invalid foreign hold' }, owner)).status === 404, 'retention hold cannot cross workspace')
  const preview = await request(workspacePath + '/retention/preview', 'GET', undefined, owner)
  check(preview.status === 200 && preview.data.conversations.length === 1 && String(preview.data.conversations[0].id) === retained.id, 'retention dry-run excludes open, held and foreign threads')
  const applied = await request(workspacePath + '/retention/run', 'POST', {}, owner)
  check(applied.status === 200 && applied.data.processed === 1, `retention applies through actual HTTP ${JSON.stringify(applied.data)}`)
  check((await one('SELECT body FROM support_messages WHERE conversation_id = ?', [retained.id]))?.body === retentionMarker, 'retention redacts eligible message content')
  check((await one('SELECT body FROM support_messages WHERE conversation_id = ?', [held.id]))?.body === 'Held private message', 'legal hold preserves closed thread content')
  check((await one('SELECT body FROM support_messages WHERE conversation_id = ?', [open.id]))?.body === 'Open private message', 'retention preserves open thread content')
  check((await one('SELECT body FROM support_messages WHERE conversation_id = ?', [foreign.id]))?.body === 'Foreign old message', 'retention preserves another workspace content')
  const attachment = await one('SELECT * FROM support_attachments WHERE id = ?', [file.attachment.id])
  check(attachment?.status === 'deleted' && !await Storage.disk(String(attachment.storage_disk)).fileExists(String(attachment.storage_key)), 'retention verifies native attachment deletion')
  check(Number((await one('SELECT storage_bytes FROM support_workspaces WHERE id = ?', [workspace.id]))?.storage_bytes) === 0, 'retention releases attachment byte accounting exactly')
  const replay = await createConversation(affectedProject, { externalId: 'retention-customer' }, { idempotencyKey: 'retention-one', subject: 'Old private subject', body: 'Old private message' })
  check(replay.conversation.subject === retentionMarker, 'idempotent replay does not recover retained conversation subject')
  check((await request(workspacePath + '/retention/run', 'POST', {}, owner)).data.processed === 0, 'retention retry is idempotent')
  process.env.SUPPORT_ENTERPRISE_LICENSE = license(workspace.public_id, Date.now() - 1000)
  check(inspectLicense(workspace.public_id).status === 'expired', 'expiry enforced')
  check((await request(workspacePath + '/scim-tokens', 'POST', {}, owner)).status === 402, 'expired license blocks new enterprise capability')
  const login = await start(idp.public_id)
  const signedIn = await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${login.state}`, 'GET', undefined, undefined, login.cookie)
  check(signedIn.status === 302 && signedIn.headers.get('set-cookie')?.includes('session_id='), 'existing linked SSO creates native browser session after expiry')
  const sessionCookie = signedIn.headers.getSetCookie().find(value => value.startsWith('session_id='))!.split(';')[0]!
  check((await request('/support/me', 'GET', undefined, undefined, sessionCookie)).status === 200, 'SSO session recognized by native auth')
  check((await request(workspacePath + '/audit', 'GET', undefined, owner)).status === 200, 'audit export preserved after expiry')
  // A native owner promotion must not exempt a directory-managed agent from deprovisioning.
  await query("UPDATE support_memberships SET role = 'admin' WHERE id = ? AND workspace_id = ?", [membership!.id, workspace.id])
  const deactivated = await request(scimPath + `/Users/${provisioned.data.id}`, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] }, scimToken)
  check(deactivated.status === 200 && !deactivated.data.active, `SCIM deactivation remains available on expired license ${JSON.stringify(deactivated.data)}`)
  check((await request(`/support/projects/${affectedProject.public_id}/inbox`, 'GET', undefined, undefined, sessionCookie)).status === 403, 'revoked membership immediately denies affected workspace through native browser session')
  check((await request(`/support/projects/${affectedProject.public_id}/inbox`, 'GET', undefined, agent)).status === 403, 'revoked membership immediately denies affected workspace through native bearer')
  check((await request(`/support/projects/${otherProject.public_id}/inbox`, 'GET', undefined, undefined, sessionCookie)).status === 200, 'directory revocation preserves native browser access to another workspace')
  check((await request(`/support/projects/${otherProject.public_id}/inbox`, 'GET', undefined, agent)).status === 200, 'directory revocation preserves native bearer access to another workspace')
  const revokedLogin = await start(idp.public_id)
  check((await request(`/_enterprise/providers/${idp.public_id}/callback?code=test&state=${revokedLogin.state}`, 'GET', undefined, undefined, revokedLogin.cookie)).status === 403, 'revoked directory identity cannot sign in again through OIDC')
  check((await request(workspacePath + '/audit', 'GET', undefined, owner)).status === 200, 'SCIM does not revoke owner credential')
  check((await request(scimPath + `/Users/${provisioned.data.id}`, 'PATCH', { Operations: [{ op: 'replace', path: 'active', value: true }] }, scimToken)).status === 402, 'expired license blocks reactivation')
  check((await request(scimPath + `/Groups/${group.data.id}`, 'DELETE', undefined, scimToken)).status === 204, 'directory group deletion remains available after expiry')
  check((await request(scimPath + `/Groups/${group.data.id}`, 'GET', undefined, scimToken)).status === 404, 'deleted SCIM group cannot be read')
  check((await lookup('Groups', 'externalId eq ' + JSON.stringify(groupExternalId))).data.totalResults === 0, 'external ID lookup excludes a deleted group')
  check((await request(scimPath + `/Users/${provisioned.data.id}`, 'DELETE', undefined, scimToken)).status === 204, 'SCIM user DELETE deprovisions after expiry')
  check((await request(scimPath + `/Users/${provisioned.data.id}`, 'GET', undefined, scimToken)).status === 404, 'deleted SCIM user cannot be read')
  check((await lookup('Users', 'externalId eq ' + JSON.stringify(userExternalId))).data.totalResults === 0, 'external ID lookup excludes a tombstoned user')
  check((await request(workspacePath + `/scim-tokens/${issued.data.id}`, 'DELETE', undefined, owner)).status === 200, 'token revocation allowed after expiry')
  check((await request(scimPath + '/Users', 'GET', undefined, scimToken)).status === 401, 'revoked SCIM token unusable')
  for (const path of ['/Schemas', '/Schemas/urn:ietf:params:scim:schemas:core:2.0:User', '/ResourceTypes', '/ResourceTypes/Group']) {
    const response = await request(scimPath + path, 'GET', undefined, scimToken)
    check(response.status === 401 && response.headers.get('content-type') === 'application/scim+json', 'revoked token refuses every discovery route using SCIM errors')
  }
  check((await request(`/enterprise/providers/${idp.public_id}/saml/acs`, 'POST', { SAMLResponse: 'unsigned' })).status === 503, 'SAML explicitly unavailable')
  process.env.SUPPORT_ENTERPRISE_LICENSE = license(otherWorkspace.public_id)
  const samlIssuer = 'https://saml.example.test/entity', entityId = 'https://support.example.test/saml/entity'
  const configuredSaml = await request(`/support/workspaces/${otherWorkspace.id}/enterprise/provider`, 'POST', { protocol: 'saml', issuer: samlIssuer, clientId: entityId }, agent)
  check(configuredSaml.status === 201, `SAML provider configuration ${JSON.stringify(configuredSaml.data)}`)
  const samlProvider = configuredSaml.data.provider.public_id
  process.env.SUPPORT_ENTERPRISE_SAML_ISSUERS = JSON.stringify([samlIssuer])
  process.env.SUPPORT_ENTERPRISE_SAML_PROVIDERS = JSON.stringify({ [samlProvider]: { entryPoint: 'https://saml.example.test/sso', idpCert: samlTestCert, privateKey: samlTestKey, publicCert: samlTestCert } })
  const callback = `https://support.example.test/api/enterprise/providers/${samlProvider}/saml/acs`
  async function samlStart(linking = false) {
    const result = await request(`/enterprise/providers/${samlProvider}/saml/${linking ? 'link' : 'login'}`, linking ? 'POST' : 'GET', linking ? {} : undefined, linking ? agent : undefined)
    check(result.status === 302, `native SAML authorization ${result.status} ${JSON.stringify(result.data)}`)
    const location = result.headers.get('location')!
    return { state: new URL(location).searchParams.get('RelayState')!, requestId: samlRequestId(location), cookie: result.headers.get('set-cookie')!.split(';')[0]! }
  }
  async function samlFinish(flow: { state: string, requestId: string, cookie: string }, mode = 'signed', cookies = flow.cookie) {
    return await request(`/enterprise/providers/${samlProvider}/saml/acs`, 'POST', { RelayState: flow.state, SAMLResponse: signedSamlResponse(flow.requestId, samlIssuer, entityId, callback, mode) }, undefined, cookies)
  }
  const samlLink = await samlStart(true)
  check((await samlFinish(samlLink, 'signed', '')).status === 401, 'SAML POST requires bound browser cookie')
  check((await samlFinish(samlLink)).status === 200, 'real signed SAML assertion links only native authenticated account')
  check((await samlFinish(samlLink)).status === 401, 'SAML RelayState cannot replay')
  for (const mode of ['unsigned', 'audience', 'recipient']) {
    const flow = await samlStart()
    check((await samlFinish(flow, mode)).status === 401, `actual HTTP rejects ${mode} SAML assertion`)
  }
  process.env.SUPPORT_ENTERPRISE_LICENSE = license(otherWorkspace.public_id, Date.now() - 1000)
  const samlLogin = await samlStart()
  const [samlFirst, samlReplay] = await Promise.all([samlFinish(samlLogin), samlFinish(samlLogin)])
  check([samlFirst.status, samlReplay.status].sort().join(',') === '302,401', 'concurrent SAML replay has exactly one native session winner')
  const samlCookie = [samlFirst, samlReplay].find(value => value.status === 302)!.headers.getSetCookie().find(value => value.startsWith('session_id='))!.split(';')[0]!
  check((await request(`/support/projects/${otherProject.public_id}/inbox`, 'GET', undefined, undefined, samlCookie)).status === 200, 'SAML sign-in uses native session and survives license expiry')
  const local = await request('/login', 'POST', { email: 'owner@example.test', password: 'SecureSupport2026!' })
  check(local.status === 200, 'native login preserved after license expiry')
  console.log(`PASS enterprise HTTP (${checks} checks)`)
}
finally { server.stop(true) }
