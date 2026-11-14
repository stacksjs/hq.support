import { Action } from '@stacksjs/actions/runtime'
import type { PhoneDependencies } from '../../Support/phone-config'
import type { RequestInstance } from '@stacksjs/types'
import { SupportError, fail } from '../../Support/errors'
import { agentProject, object } from '../../Support/service'
import { query } from '../../Support/database'

export type PhoneOperation = 'capabilities' | 'list' | 'detail' | 'verify' | 'create' | 'end' | 'reconcile' | 'token' | 'takeover' | 'incoming' | 'instructions' | 'status' | 'consent' | 'agent' | 'dial-complete' | 'wait'
async function handle(request: RequestInstance, operation: PhoneOperation, dependencies: PhoneDependencies) {
  try {
    if (['incoming', 'instructions', 'status', 'consent', 'agent', 'dial-complete', 'wait'].includes(operation)) {
      const { phoneWebhook } = await import('../../Support/phone-webhooks')
      return await phoneWebhook(request, operation as 'incoming' | 'instructions' | 'status' | 'consent' | 'agent' | 'dial-complete' | 'wait', dependencies)
    }
    const account = await request.user()
    if (!account) fail(401, 'unauthorized', 'Sign in to continue.')
    const project = await agentProject(Number(account.id), request.getParam('project'))
    const input = object(request.all())
    if (JSON.stringify(input).length > 32768) fail(413, 'body_too_large', 'Phone input exceeds the request bound.')
    const phone = await import('../../Support/phone'), { callView } = await import('../../Support/phone-config')
    let body: unknown
    if (operation === 'capabilities') body = await phone.phoneCapabilities(project)
    else if (operation === 'list') body = { calls: (await query('SELECT * FROM support_phone_calls WHERE workspace_id = ? AND project_id = ? ORDER BY id DESC LIMIT 100', [project.workspace_id, project.id])).map(callView) }
    else if (operation === 'detail') body = { call: callView(await phone.phoneCall(project, request.getParam('call'))) }
    else if (operation === 'verify') {
      const { publicChannel } = await import('../../Support/channels')
      body = { channel: publicChannel(await phone.verifyPhoneChannel(project, request.getParam('channel'), Number(account.id), dependencies)) }
    }
    else if (operation === 'create') body = await phone.createOutboundCall(project, input, Number(account.id), dependencies)
    else if (operation === 'end') body = await phone.endPhoneCall(project, request.getParam('call'), dependencies)
    else if (operation === 'reconcile') body = await phone.reconcilePhoneCall(project, request.getParam('call'), dependencies)
    else if (operation === 'token') body = await phone.browserPhoneToken(project, input.channelId, Number(account.id))
    else if (operation === 'takeover') body = await phone.takeOverPhoneCall(project, request.getParam('call'), Number(account.id), dependencies)
    return Response.json(body, { status: operation === 'create' ? 201 : 200, headers: { 'Cache-Control': 'no-store' } })
  }
  catch (error) {
    if (!(error instanceof SupportError) && process.env.APP_ENV === 'test') console.error(error)
    return Response.json({ error: { code: error instanceof SupportError ? error.code : 'phone_unavailable', message: error instanceof SupportError ? error.message : 'Phone is unavailable. Retry with the same operation key.' } }, { status: error instanceof SupportError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
  }
}
export function phoneAction(operation: PhoneOperation, method: 'GET' | 'POST', dependencies: PhoneDependencies = {}) {
  return new Action({ name: `Support phone ${operation}`, method, apiResponse: false, handle: request => handle(request, operation, dependencies) })
}
