import { Action } from '@stacksjs/actions/runtime'
import type { RequestInstance } from '@stacksjs/types'
import { SupportError, fail } from '../../Support/errors'
import { agentProject, digest, keyProject, object } from '../../Support/service'
import { confirmChallenge, probeDeployment, startChallenge, verificationStatus } from '../../Support/verification'
import type { DeploymentProbe, VerificationPrincipal } from '../../Support/verification'

async function handle(request: RequestInstance, operation: 'start' | 'confirm' | 'status', authentication: 'user' | 'integration', probe: DeploymentProbe): Promise<Response> {
  try {
    const reference = request.getParam('project'), input = object(request.all())
    let principal: VerificationPrincipal
    let project
    if (authentication === 'integration') {
      const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '')?.[1] || ''
      project = await keyProject(reference, key, 'write')
      principal = { kind: 'key', digest: digest(key) }
    }
    else {
      const account = await request.user()
      if (!account) fail(401, 'unauthorized', 'Sign in to continue.')
      project = await agentProject(Number(account.id), reference, ['owner', 'admin'])
      principal = { kind: 'user', userId: Number(account.id) }
    }
    const result = operation === 'start' ? await startChallenge(project, principal, input) : operation === 'confirm' ? await confirmChallenge(project, principal, request.getParam('id'), input.nonce, probe) : await verificationStatus(project, principal)
    return Response.json(result, { status: operation === 'start' ? 201 : 200, headers: { 'Cache-Control': 'no-store' } })
  }
  catch (error) {
    if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } })
    console.error('[support-verification]', error instanceof Error ? error.name : 'UnknownError')
    if (process.env.APP_ENV === 'test') console.error(error)
    return Response.json({ error: { code: 'verification_unavailable', message: 'Deployment verification is unavailable. No Free plan has been granted.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
function verificationAction(operation: 'start' | 'confirm' | 'status', authentication: 'user' | 'integration') {
  const action = new Action({
    name: `Support deployment verification ${authentication} ${operation}`,
    method: operation === 'status' ? 'GET' : 'POST',
    dependencies: () => ({ probe: probeDeployment }),
    handle(request): Promise<Response> { return handle(request, operation, authentication, action.deps.probe as DeploymentProbe) },
  })
  return action
}
export const verificationActions = {
  start: verificationAction('start', 'user'),
  confirm: verificationAction('confirm', 'user'),
  status: verificationAction('status', 'user'),
  integrationStart: verificationAction('start', 'integration'),
  integrationConfirm: verificationAction('confirm', 'integration'),
  integrationStatus: verificationAction('status', 'integration'),
}
