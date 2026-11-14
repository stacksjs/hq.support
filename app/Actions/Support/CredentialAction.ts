import { Action } from '@stacksjs/actions/runtime'
import type { RequestInstance } from '@stacksjs/types'
import { agentProject, object } from '../../Support/service'
import { listProjectKeys, revokeContactSessions, revokeProjectKey, rotateProjectKey } from '../../Support/credentials'
import { SupportError, fail } from '../../Support/errors'
export type CredentialOperation = 'list' | 'revoke' | 'rotate' | 'sessions.revoke'
export async function handleCredentialRequest(request: RequestInstance, operation: CredentialOperation): Promise<Response> {
  try {
    const user = await request.user()
    if (!user) fail(401, 'unauthorized', 'Sign in to manage credentials.')
    const project = await agentProject(Number(user.id), request.getParam('project'), ['owner', 'admin'])
    const input = { ...object(request.all()) }
    // Native all() includes path parameters; authority always comes from getParam.
    delete input.project; delete input.key; delete input.contact
    if (JSON.stringify(input).length > 1024) fail(413, 'credential_input_large', 'Credential input exceeds the request bound.')
    const parameters = new URL(request.url).searchParams
    if (parameters.getAll('cursor').length > 1) fail(422, 'duplicate_cursor', 'Supply cursor once.')
    const body = operation === 'list' ? await listProjectKeys(project, Number(user.id), parameters.get('cursor')) : operation === 'revoke' ? await revokeProjectKey(project, request.getParam('key'), Number(user.id)) : operation === 'rotate' ? await rotateProjectKey(project, request.getParam('key'), Number(user.id), input) : await revokeContactSessions(project, request.getParam('contact'), Number(user.id))
    return Response.json(body, { headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } })
  }
  catch (error) {
    return Response.json({ error: { code: error instanceof SupportError ? error.code : 'credential_unavailable', message: error instanceof SupportError ? error.message : 'Credential operation is unavailable. Retry with the same operation ID; secrets are never replayed.' } }, { status: error instanceof SupportError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
export function credentialAction(operation: CredentialOperation, method: 'GET' | 'POST') { return new Action({ name: `Support credentials ${operation}`, method, apiResponse: false, handle: request => handleCredentialRequest(request, operation) }) }
