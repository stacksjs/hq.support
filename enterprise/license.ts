// SPDX-License-Identifier: LicenseRef-HQ-Support-Enterprise
import { createPublicKey, verify } from 'node:crypto'
import { fail } from '../app/Support/errors'

export type EnterpriseFeature = 'oidc' | 'saml' | 'scim' | 'audit'
export interface EnterpriseLicense {
  version: 1
  licenseId: string
  installation: string
  workspace: string
  issuedAt: number
  expiresAt: number
  features: EnterpriseFeature[]
}
export interface LicenseEnvironment { token?: string, publicKey?: string, installation?: string }
export interface LicenseResult { status: 'missing' | 'invalid' | 'expired' | 'active', license: EnterpriseLicense | null }

/** A detached Ed25519 signature covers the exact base64url payload, including its encoding. */
export function inspectLicense(workspace: string, env: LicenseEnvironment = {
  token: process.env.SUPPORT_ENTERPRISE_LICENSE,
  publicKey: process.env.SUPPORT_ENTERPRISE_LICENSE_PUBLIC_KEY,
  installation: process.env.SUPPORT_INSTALLATION_ID,
}, now = Date.now()): LicenseResult {
  if (!env.token) return { status: 'missing', license: null }
  try {
    const parts = env.token.split('.')
    if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) || env.token.length > 16_384 || !env.publicKey || !env.installation) throw new Error('Invalid license encoding')
    const [payload, signature] = parts as [string, string]
    const key = createPublicKey(env.publicKey.replace(/\\n/g, '\n'))
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'))) throw new Error('Invalid license signature')
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as EnterpriseLicense
    if (data.version !== 1 || typeof data.licenseId !== 'string' || !data.licenseId || data.installation !== env.installation || data.workspace !== workspace || !Number.isSafeInteger(data.issuedAt) || !Number.isSafeInteger(data.expiresAt) || data.issuedAt > now || data.expiresAt <= data.issuedAt || !Array.isArray(data.features) || !data.features.every(feature => ['oidc', 'saml', 'scim', 'audit'].includes(feature))) throw new Error('Invalid license claims')
    return { status: data.expiresAt <= now ? 'expired' : 'active', license: data }
  }
  catch { return { status: 'invalid', license: null } }
}
export function requireEnterprise(workspace: { public_id?: unknown, plan?: unknown }, feature: EnterpriseFeature) {
  // Hosted plan changes are owned by the verified billing webhook path.
  if (process.env.SUPPORT_DEPLOYMENT_MODE === 'hosted' && workspace.plan === 'enterprise') return
  const result = inspectLicense(String(workspace.public_id))
  if (result.status !== 'active' || !result.license?.features.includes(feature)) fail(402, 'enterprise_license_required', 'An active Enterprise entitlement is required for this operation.')
}
