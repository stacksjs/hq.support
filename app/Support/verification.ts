import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { fetchPublicUrl, outboundUrlProblem, OutboundUrlError } from '@stacksjs/security'
import type { Row } from './database'
import { db, insert, one, query, workspaceTransaction } from './database'
import { fail, identifier, text } from './errors'
import { plans } from './limits'
import { digest, member, secret, usage, workspace } from './service'

export type VerificationPrincipal = { kind: 'user', userId: number } | { kind: 'key', digest: string }
export type DeploymentProbe = (url: string) => Promise<Response>
export const probeDeployment: DeploymentProbe = url => fetchPublicUrl(url, { method: 'GET', headers: { accept: 'application/json' } }, { maxRedirects: 0, maxBytes: 4096, timeoutMs: 5000 })
export const verificationPolicy = { ttlMs: 600000, maximumAttempts: 5, proofPath: '/.well-known/hq-support', minimumFrameworkVersion: '0.75.0' } as const

export function deploymentOrigin(value: unknown): string {
  const source = text(value, 'origin', 255)
  let parsed: URL
  try { parsed = new URL(source) }
  catch { fail(422, 'invalid_origin', 'Enter a public HTTPS origin.') }
  const problem = outboundUrlProblem(source)
  if (problem || parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || isIP(parsed.hostname.replace(/^\[|\]$/g, '')) || parsed.hostname.endsWith('.')) fail(422, 'invalid_origin', 'Use a public HTTPS domain on port 443, without a path or credentials.')
  return parsed.origin
}
export function frameworkVersion(value: unknown): string {
  const version = text(value, 'frameworkVersion', 80)
  const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][a-zA-Z0-9.-]+)?$/.exec(version)
  if (!parts || (Number(parts[1]) === 0 && Number(parts[2]) < 75)) fail(422, 'unsupported_framework', 'A Stacks framework version of at least 0.75.0 is required.')
  return version
}
async function authorize(project: Row, principal: VerificationPrincipal) {
  if (principal.kind === 'user') await member(principal.userId, Number(project.workspace_id), ['owner', 'admin'])
  else if (!await one("SELECT id FROM support_api_keys WHERE project_id = ? AND workspace_id = ? AND digest = ? AND scope = 'write' AND revoked_at = 0", [project.id, project.workspace_id, principal.digest])) fail(401, 'unauthorized', 'A valid project integration key is required.')
}
async function freshProject(project: Row) {
  const selected = await one('SELECT * FROM support_projects WHERE id = ? AND workspace_id = ?', [project.id, project.workspace_id])
  if (!selected) fail(404, 'not_found', 'Project not found.')
  return selected
}
function matchingNonce(value: unknown, stored: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return false
  const left = Buffer.from(digest(value), 'hex'), right = Buffer.from(String(stored), 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}
export async function startChallenge(project: Row, principal: VerificationPrincipal, input: Row, now = Date.now()) {
  await authorize(project, principal)
  const origin = deploymentOrigin(input.origin), version = frameworkVersion(input.frameworkVersion), nonce = secret()
  return await workspaceTransaction(Number(project.workspace_id), async () => {
    const current = await freshProject(project), owner = await workspace(Number(project.workspace_id))
    await authorize(current, principal)
    if (!Number(current.buddy_connected_at)) fail(409, 'buddy_connection_required', 'Approve this project through Buddy hq:connect supporthq first.')
    await query("UPDATE support_challenges SET consumed_at = ? WHERE project_id = ? AND kind = 'deployment' AND consumed_at = 0", [now, current.id])
    const challenge = await insert('support_challenges', { workspace_id: current.workspace_id, project_id: current.id, owner_id: owner.owner_id, digest: digest(nonce), kind: 'deployment', origin, framework_version: version, attempts: 0, expires_at: now + verificationPolicy.ttlMs, consumed_at: 0 })
    return { challenge: { id: String(challenge.id), nonce, project: String(current.public_id), origin, url: origin + verificationPolicy.proofPath, expiresAt: now + verificationPolicy.ttlMs }, document: { service: 'supporthq', project: String(current.public_id), nonce, framework: 'stacks', frameworkVersion: version } }
  })
}
async function result(project: Row, alreadyVerified = false) {
  const current = await freshProject(project), owner = await workspace(Number(project.workspace_id))
  return { verified: true, plan: String(owner.plan), workspaceId: String(owner.id), origin: String(current.verified_origin), alreadyVerified, proof: { deployment: true, buddyConnection: Boolean(Number(current.buddy_connected_at)), frameworkAttestation: 'self_reported' as const } }
}
export async function confirmChallenge(project: Row, principal: VerificationPrincipal, id: unknown, nonce: unknown, probe: DeploymentProbe = probeDeployment, now = Date.now()) {
  await authorize(project, principal)
  const challengeId = identifier(id)
  const attempted = await workspaceTransaction(Number(project.workspace_id), async () => {
    await authorize(project, principal)
    const row = await one("SELECT * FROM support_challenges WHERE id = ? AND workspace_id = ? AND project_id = ? AND kind = 'deployment'", [challengeId, project.workspace_id, project.id])
    if (!row) return { error: 'not_found' as const }
    if (matchingNonce(nonce, row.digest) && Number(row.consumed_at)) {
      const current = await freshProject(project)
      if (current.verified_origin === row.origin && Number(current.deployment_verified_at)) return { row, alreadyVerified: true }
    }
    if (Number(row.attempts) >= verificationPolicy.maximumAttempts) return { error: 'attempts_exceeded' as const }
    if (!matchingNonce(nonce, row.digest)) {
      await query('UPDATE support_challenges SET attempts = attempts + 1 WHERE id = ?', [row.id])
      return { error: 'nonce_mismatch' as const }
    }
    if (Number(row.consumed_at)) {
      const current = await freshProject(project)
      if (current.verified_origin === row.origin && Number(current.deployment_verified_at)) return { row, alreadyVerified: true }
      return { error: 'consumed' as const }
    }
    if (Number(row.expires_at) <= now) return { error: 'expired' as const }
    await query('UPDATE support_challenges SET attempts = attempts + 1 WHERE id = ?', [row.id])
    return { row, alreadyVerified: false }
  })
  if ('error' in attempted) fail(attempted.error === 'not_found' ? 404 : attempted.error === 'attempts_exceeded' ? 429 : 422, attempted.error!, 'Deployment challenge is invalid, expired, consumed, or exhausted. Start a new challenge if needed.')
  if (attempted.alreadyVerified) return await result(project, true)
  const challenge = attempted.row
  // Revalidate syntax even for persisted input before passing it to the native guarded fetch.
  const origin = deploymentOrigin(challenge.origin)
  let response: Response
  try { response = await probe(origin + verificationPolicy.proofPath) }
  catch (error) {
    if (error instanceof OutboundUrlError) fail(422, 'unsafe_deployment_target', 'Deployment URL could not be safely verified. Private addresses and redirects are refused.')
    fail(503, 'deployment_unreachable', 'The public deployment could not be reached. The Free plan has not been granted.')
  }
  if (response.status >= 300 && response.status < 400) fail(422, 'deployment_redirect', 'Serve the challenge directly. Redirects are not accepted.')
  if (!response.ok || !['application/json', 'application/octet-stream'].includes((response.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase())) fail(422, 'deployment_document_missing', 'Serve the JSON challenge at the exact well-known path.')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > 4096) fail(422, 'deployment_document_large', 'Deployment challenge document must be at most 4096 bytes.')
  let proof: Row
  try { proof = JSON.parse(new TextDecoder().decode(bytes)) as Row }
  catch { fail(422, 'deployment_document_invalid', 'Deployment challenge is not valid JSON.') }
  if (!proof || typeof proof !== 'object' || proof.service !== 'supporthq' || proof.project !== project.public_id || !matchingNonce(proof.nonce, challenge.digest) || proof.framework !== 'stacks' || proof.frameworkVersion !== challenge.framework_version) fail(422, 'deployment_document_mismatch', 'The public deployment does not serve this project and challenge document.')
  frameworkVersion(proof.frameworkVersion)
  // Account ownership is the serialization point across ALL workspaces, before the workspace lock.
  return await db.transaction(async () => {
    await query('UPDATE users SET id = id WHERE id = ?', [challenge.owner_id])
    await query('UPDATE support_workspaces SET id = id WHERE id = ?', [project.workspace_id])
    const current = await freshProject(project), owner = await workspace(Number(project.workspace_id))
    await authorize(current, principal)
    const account = await one('SELECT support_free_workspace_id FROM users WHERE id = ?', [owner.owner_id])
    const live = await one('SELECT * FROM support_challenges WHERE id = ? AND project_id = ?', [challenge.id, project.id])
    if (!live || Number(live.expires_at) <= Date.now() || Number(owner.owner_id) !== Number(challenge.owner_id) || !Number(current.buddy_connected_at)) fail(422, 'challenge_expired', 'Start a new challenge for the current project owner.')
    if (Number(live.consumed_at)) {
      if (current.verified_origin === origin && Number(current.deployment_verified_at)) return await result(project, true)
      fail(422, 'challenge_consumed', 'This challenge was already consumed.')
    }
    if (!account) fail(404, 'owner_not_found', 'Workspace owner no longer exists.')
    if (Number(account.support_free_workspace_id) && Number(account.support_free_workspace_id) !== Number(owner.id)) fail(409, 'free_already_claimed', 'The workspace owner has already claimed their one Free workspace.')
    const another = await one("SELECT id FROM support_workspaces WHERE owner_id = ? AND plan = 'free' AND id <> ?", [owner.owner_id, owner.id])
    if (another) fail(409, 'free_already_claimed', 'The workspace owner already has a Free workspace.')
    if (!['trial', 'free'].includes(String(owner.plan))) fail(409, 'paid_workspace', 'Manage the paid subscription before changing this workspace to Free.')
    const projectCount = Number((await one('SELECT COUNT(*) AS count FROM support_projects WHERE workspace_id = ?', [owner.id]))?.count)
    const seats = Number((await one("SELECT COUNT(*) AS count FROM support_memberships WHERE workspace_id = ? AND status IN ('active', 'pending')", [owner.id]))?.count)
    if (projectCount > plans.free.projects || seats > plans.free.seats || Number(owner.storage_bytes) > plans.free.storageBytes || await usage(Number(owner.id), 'conversations') > plans.free.conversationCeiling || await usage(Number(owner.id), 'ai') > plans.free.ai) fail(409, 'free_capacity_exceeded', 'This workspace currently exceeds a Free allowance. Reduce usage or select a paid plan.')
    const verifiedAt = Date.now()
    await query('UPDATE users SET support_free_workspace_id = ? WHERE id = ?', [owner.id, owner.owner_id])
    await query("UPDATE support_workspaces SET plan = 'free', stacks_verified = ?, deployment_verified = ?, free_qualified_at = ?, trial_ends_at = 0, updated_at = ? WHERE id = ?", [true, true, verifiedAt, new Date(verifiedAt).toISOString(), owner.id])
    await query('UPDATE support_projects SET verified_origin = ?, deployment_verified_at = ?, updated_at = ? WHERE id = ?', [origin, verifiedAt, new Date(verifiedAt).toISOString(), current.id])
    await query('UPDATE support_challenges SET consumed_at = ? WHERE id = ? AND consumed_at = 0', [verifiedAt, live.id])
    return await result(current)
  })
}
export async function verificationStatus(project: Row, principal: VerificationPrincipal) {
  await authorize(project, principal)
  const current = await freshProject(project), owner = await workspace(Number(project.workspace_id))
  return { buddyConnected: Boolean(Number(current.buddy_connected_at)), deploymentVerified: Boolean(Number(current.deployment_verified_at)), origin: String(current.verified_origin), plan: String(owner.plan), freeQualifiedAt: Number(owner.free_qualified_at), frameworkAttestation: 'self_reported', policy: verificationPolicy }
}
