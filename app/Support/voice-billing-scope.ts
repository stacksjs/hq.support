import { createHash } from 'node:crypto'

const providerId = /^[a-z\d][a-z\d_-]{0,127}$/i

export function realtimeBillingScope(value: unknown) {
  if (!value || typeof value !== 'object') throw new TypeError('A Realtime organization, project and API key identifier are required.')
  const { organizationId, projectId, apiKeyId } = value as Record<string, unknown>
  const parts = [organizationId, projectId, apiKeyId]
  if (!parts.every(part => typeof part === 'string' && providerId.test(part)))
    throw new TypeError('A Realtime organization, project and API key identifier are required.')
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function realtimeBillingCredential(env = process.env) {
  const apiKey = env.OPENAI_REALTIME_API_KEY
  const scope = env.SUPPORT_REALTIME_BILLING_SCOPE
  if (!apiKey && !scope)
    return { apiKey: env.OPENAI_API_KEY || '', billingScope: '' }
  if (!apiKey || apiKey === env.OPENAI_API_KEY || !scope)
    throw new TypeError('Configure the dedicated Realtime API key and its billing scope together.')
  let billingScope: string
  try { billingScope = realtimeBillingScope(JSON.parse(scope)) }
  catch { throw new TypeError('SUPPORT_REALTIME_BILLING_SCOPE must describe the dedicated Realtime API key.') }
  return { apiKey, billingScope }
}
