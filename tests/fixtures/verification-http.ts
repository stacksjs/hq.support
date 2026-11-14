import assert from 'node:assert/strict'
import { migrateAuthTables, runDatabaseMigration } from '@stacksjs/database'
import { config, overridesReady } from '@stacksjs/config'
import { route } from '@stacksjs/router'
import { fetchPublicUrl, OutboundUrlError } from '@stacksjs/security'
import { injectGlobalAutoImports } from '@stacksjs/server'
import { verificationActions } from '../../app/Actions/Support/VerificationAction'
import { digest } from '../../app/Support/service'
import { one, query } from '../../app/Support/database'

await overridesReady
config.database.queryLogging.enabled = false
assert.equal((await migrateAuthTables()).success, true)
assert.equal((await runDatabaseMigration()).isOk, true)
assert.equal((await migrateAuthTables()).success, true)
await injectGlobalAutoImports()
await route.importRoutes()
const server = await route.serve({ port: 0, hostname: '127.0.0.1' })
const base = `http://127.0.0.1:${server.port}/api`
let csrf = '', cookie = '', checks = 0, probeCalls = 0
const documents = new Map<string, unknown>()
let probeHook: ((url: string) => Promise<void>) | undefined
let responseOverride: (() => Response) | undefined
const externalProbe = async (url: string) => {
  probeCalls++
  await probeHook?.(url)
  if (responseOverride) return responseOverride()
  return documents.has(url) ? Response.json(documents.get(url)) : Response.json({ missing: true }, { status: 404 })
}
// Only the external deployment probe is injected. Authentication, routing, all rows and transactions are real.
verificationActions.confirm.overrideDependencies({ probe: externalProbe })
verificationActions.integrationConfirm.overrideDependencies({ probe: externalProbe })
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
async function http(path: string, method = 'GET', body?: unknown, bearer?: string) {
  const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, data: await response.json() as any, headers: response.headers }
}
async function account(index: number) {
  const email = `verification${index}@example.test`, password = 'VerifiedDeployment2026!'
  const created = await http('/register', 'POST', { name: `Deployment Owner ${index}`, email, password, password_confirmation: password })
  check(created.status < 300, 'native account created')
  const logged = await http('/login', 'POST', { email, password })
  return { token: String(logged.data.access_token), id: Number(logged.data.user.id) }
}
async function workspace(owner: { token: string }, name: string) {
  const row = await http('/support/workspaces', 'POST', { name }, owner.token)
  check(row.status === 201, `native workspace created ${JSON.stringify(row.data)}`)
  const selected = await http(`/support/workspaces/${row.data.workspace.id}/projects`, 'POST', { name }, owner.token)
  check(selected.status === 201, 'native project created')
  return { workspace: row.data.workspace, project: selected.data.project }
}
async function connect(owner: { token: string }, target: { workspace: any, project: any }) {
  const started = await http('/cli/connect', 'POST', { app: target.project.name })
  const approved = await http(`/support/connect/${started.data.code}/approve`, 'POST', { confirmCode: started.data.confirmCode, workspaceId: Number(target.workspace.id) }, owner.token)
  check(approved.status === 200 && approved.data.ok === true, `real confirmed Buddy project connection ${JSON.stringify(approved.data)}`)
  const grant = await http(`/cli/connect/${started.data.code}`)
  check(grant.status === 200 && grant.data.project.id === target.project.public_id, 'Buddy grant bound to selected workspace project')
  return grant.data
}
const sdk = (project: any) => `/v1/projects/${project.public_id}/verification`
const agent = (project: any) => `/support/projects/${project.public_id}/verification`
async function challenge(target: any, key: string, origin: string) {
  const result = await http(`${sdk(target.project)}/challenges`, 'POST', { origin, frameworkVersion: '0.75.574' }, key)
  check(result.status === 201, `deployment challenge issued ${JSON.stringify(result.data)}`)
  documents.set(result.data.challenge.url, result.data.document)
  return result.data
}
async function confirm(target: any, key: string, started: any) {
  return await http(`${sdk(target.project)}/challenges/${started.challenge.id}/confirm`, 'POST', { nonce: started.challenge.nonce }, key)
}
try {
  const seed = await http('/csrf-token'); csrf = seed.data.token; cookie = seed.headers.get('set-cookie')!.split(';')[0]!
  const owner = await account(1), first = await workspace(owner, 'First verified app')
  const manual = (await http(`/support/projects/${first.project.public_id}/keys`, 'POST', {}, owner.token)).data
  check((await http(`${sdk(first.project)}/challenges`, 'POST', { origin: 'https://owned-one.example', frameworkVersion: '0.75.574' }, manual.ingestKey)).status === 409, 'ordinary API key and self-reported version are insufficient without Buddy confirmation')
  const keys = await connect(owner, first)
  check(Number((await one('SELECT buddy_connected_at FROM support_projects WHERE id = ?', [first.project.id]))?.buddy_connected_at) > 0, 'Buddy approval marker persisted')
  check((await http(`${sdk(first.project)}/challenges`, 'POST', { origin: 'https://owned-one.example', frameworkVersion: '0.75.574' }, keys.readKey)).status === 401, 'summary read key cannot start a free eligibility challenge')
  for (const origin of ['http://owned-one.example', 'https://127.0.0.1', 'https://[::1]', 'https://169.254.169.254', 'https://localhost', 'https://service.internal', 'https://owned-one.example:8443', 'https://user:pass@owned-one.example', 'https://owned-one.example/path', 'https://owned-one.example/?query=1']) {
    check((await http(`${sdk(first.project)}/challenges`, 'POST', { origin, frameworkVersion: '0.75.574' }, keys.ingestKey)).status === 422, `unsafe/non-origin target rejected: ${origin}`)
  }
  check(probeCalls === 0, 'unsafe target syntax is rejected before any external probe')
  check((await http(`${sdk(first.project)}/challenges`, 'POST', { origin: 'https://owned-one.example', frameworkVersion: '0.74.0' }, keys.ingestKey)).status === 422, 'unsupported framework eligibility metadata refused')
  const started = await challenge(first, keys.ingestKey, 'https://owned-one.example')
  const saved = await one('SELECT * FROM support_challenges WHERE id = ?', [Number(started.challenge.id)])
  check(saved?.digest === digest(started.challenge.nonce) && !JSON.stringify(saved).includes(started.challenge.nonce), 'only the random nonce digest persists')
  const wrong = await http(`${sdk(first.project)}/challenges/${started.challenge.id}/confirm`, 'POST', { nonce: '0'.repeat(64) }, keys.ingestKey)
  check(wrong.status === 422 && Number((await one('SELECT attempts FROM support_challenges WHERE id = ?', [saved!.id]))?.attempts) === 1, 'wrong nonce refused and failed attempt commits durably')
  documents.set(started.challenge.url, { ...started.document, nonce: 'f'.repeat(64) })
  check((await confirm(first, keys.ingestKey, started)).status === 422, 'deployment document must prove the exact nonce')
  documents.set(started.challenge.url, { ...started.document, project: 'another-project' })
  check((await confirm(first, keys.ingestKey, started)).status === 422, 'deployment proof cannot move to another project')
  responseOverride = () => new Response(null, { status: 302, headers: { location: 'https://other.example' } })
  check((await confirm(first, keys.ingestKey, started)).status === 422, 'verification refuses a redirect rather than following it')
  check((await one('SELECT plan FROM support_workspaces WHERE id = ?', [first.workspace.id]))?.plan === 'trial', 'failed probes and runtime metadata alone never grant Free')
  responseOverride = () => new Response(JSON.stringify(started.document), { headers: { 'content-type': 'application/octet-stream' } }); documents.set(started.challenge.url, started.document)
  const verified = await confirm(first, keys.ingestKey, started)
  responseOverride = undefined
  check(verified.status === 200 && verified.data.verified && verified.data.plan === 'free' && verified.data.proof.frameworkAttestation === 'self_reported', `fifth valid proof grants native Free plan ${JSON.stringify(verified.data)}`)
  check(Number((await one('SELECT support_free_workspace_id FROM users WHERE id = ?', [owner.id]))?.support_free_workspace_id) === Number(first.workspace.id), 'free grant ledger belongs to the owning account')
  const beforeReplay = probeCalls
  check((await confirm(first, keys.ingestKey, started)).status === 200 && probeCalls === beforeReplay, 'successful proof replay is idempotent without another network probe')
  const status = await http(agent(first.project), 'GET', undefined, owner.token)
  check(status.status === 200 && status.data.buddyConnected && status.data.deploymentVerified && status.data.plan === 'free', 'native verification status exposes actual persisted proof')
  const second = await workspace(owner, 'Second trial app'), secondKeys = await connect(owner, second)
  const secondChallenge = await challenge(second, secondKeys.ingestKey, 'https://owned-two.example')
  check((await confirm(second, secondKeys.ingestKey, secondChallenge)).status === 409 && (await one('SELECT plan FROM support_workspaces WHERE id = ?', [second.workspace.id]))?.plan === 'trial', 'one owner cannot claim a second Free workspace')
  check((await http(`${agent(second.project)}/challenges`, 'POST', { origin: 'https://owned-two.example', frameworkVersion: '0.75.574' }, owner.token)).status === 201, 'owner/admin browser endpoint starts the same bound challenge')
  const oversized = await challenge(second, secondKeys.ingestKey, 'https://oversized.example')
  responseOverride = () => new Response(new Uint8Array(4097), { headers: { 'content-type': 'application/octet-stream' } })
  const tooLarge = await confirm(second, secondKeys.ingestKey, oversized)
  check(tooLarge.status === 422 && tooLarge.data.error.code === 'deployment_document_large', 'bounded static proof cannot exceed 4096 bytes')
  responseOverride = () => new Response(JSON.stringify(oversized.document), { headers: { 'content-type': 'text/html' } })
  check((await confirm(second, secondKeys.ingestKey, oversized)).data.error.code === 'deployment_document_missing', 'HTML content type is refused even if bytes look like JSON')
  responseOverride = undefined
  const expired = await challenge(second, secondKeys.ingestKey, 'https://expired.example')
  await query('UPDATE support_challenges SET expires_at = 1 WHERE id = ?', [Number(expired.challenge.id)])
  check((await confirm(second, secondKeys.ingestKey, expired)).status === 422, 'expired nonce cannot qualify a deployment')
  const exhausted = await challenge(second, secondKeys.ingestKey, 'https://exhausted.example')
  documents.set(exhausted.challenge.url, {})
  for (let index = 0; index < 5; index++) check((await confirm(second, secondKeys.ingestKey, exhausted)).status === 422, 'bad deployment document consumes bounded attempt')
  documents.set(exhausted.challenge.url, exhausted.document)
  check((await confirm(second, secondKeys.ingestKey, exhausted)).status === 429, 'sixth confirmation is refused even with later matching metadata')
  // The same owner qualifies two separate workspaces concurrently before either has a Free grant.
  const competingOwner = await account(2), a = await workspace(competingOwner, 'Concurrent A'), b = await workspace(competingOwner, 'Concurrent B')
  const aKeys = await connect(competingOwner, a), bKeys = await connect(competingOwner, b)
  const aProof = await challenge(a, aKeys.ingestKey, 'https://concurrent-a.example'), bProof = await challenge(b, bKeys.ingestKey, 'https://concurrent-b.example')
  const race = await Promise.all([confirm(a, aKeys.ingestKey, aProof), confirm(b, bKeys.ingestKey, bProof)])
  check(race.filter(result => result.status === 200).length === 1 && race.filter(result => result.status === 409).length === 1, `owner row serialization grants exactly one of two workspaces ${race.map(result => result.status)}`)
  check(Number((await one("SELECT COUNT(*) AS count FROM support_workspaces WHERE owner_id = ? AND plan = 'free'", [competingOwner.id]))?.count) === 1, 'database has exactly one Free workspace per owner')
  const thirdOwner = await account(3), third = await workspace(thirdOwner, 'Revocation test'), thirdKeys = await connect(thirdOwner, third)
  const revoked = await challenge(third, thirdKeys.ingestKey, 'https://revoked.example')
  probeHook = async () => { await query('UPDATE support_api_keys SET revoked_at = ? WHERE digest = ?', [Date.now(), digest(thirdKeys.ingestKey)]) }
  check((await confirm(third, thirdKeys.ingestKey, revoked)).status === 401 && (await one('SELECT plan FROM support_workspaces WHERE id = ?', [third.workspace.id]))?.plan === 'trial', 'integration key revocation during external probe prevents the final grant')
  probeHook = undefined
  check((await http(agent(first.project), 'GET', undefined, thirdOwner.token)).status === 403, 'verification status refuses another workspace user')
  check((await http(`${sdk(first.project)}/challenges`, 'POST', { origin: 'https://other-key.example', frameworkVersion: '0.75.574' }, bKeys.ingestKey)).status === 401, 'another project integration key cannot qualify a deployment')
  // Exercise the actual installed native DNS guard without making any network connection.
  for (const addresses of [['127.0.0.1'], ['169.254.169.254'], ['::1'], ['8.8.8.8', '10.0.0.1']]) {
    let denied = false
    try { await fetchPublicUrl('https://dns-rebinding.example/.well-known/hq-support', {}, { maxRedirects: 0, timeoutMs: 1000, resolve: async () => addresses }) }
    catch (error) { denied = error instanceof OutboundUrlError && error.reason === 'private' }
    check(denied, 'native guarded fetch refuses private or mixed DNS answers before connecting')
  }
  console.log(`PASS deployment verification HTTP ${checks} checks`)
}
finally { verificationActions.confirm.resetDependencies(); verificationActions.integrationConfirm.resetDependencies(); await server.stop(true) }
