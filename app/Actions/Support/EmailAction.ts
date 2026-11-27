import { Action } from '@stacksjs/actions/runtime'
import type { EmailDependencies } from '../../Support/support-email'
import { SupportError, fail } from '../../Support/errors'
import { channelByPublicId } from '../../Support/channels'
import { agentProject, object } from '../../Support/service'
import { query } from '../../Support/database'
import { emailReceiptView, retainEmailNotification } from '../../Support/email-receipts'
import { acceptEmailSendNotification } from '../../Support/email-outbound-receipts'

export function emailAction(operation: 'incoming' | 'outbound' | 'receipts', method: 'GET' | 'POST', dependencies: EmailDependencies = {}) {
  return new Action({ name: `Support email ${operation}`, method, apiResponse: false,
    async handle(request) {
      try {
        let body: unknown
        if (operation !== 'receipts') {
          if (!request.rawBody) fail(400, 'email_raw_body_required', 'Original SNS notification bytes are required.')
          const raw = await request.rawBody()
          if (Buffer.byteLength(raw) > 262144) fail(413, 'email_notification_bound', 'SNS notification exceeds the receipt bound.')
          let envelope: unknown
          try { envelope = JSON.parse(raw) } catch { fail(400, 'email_notification_invalid', 'SNS notification must be JSON.') }
          const channel = await channelByPublicId(request.getParam('channel'))
          body = operation === 'incoming' ? await retainEmailNotification(channel, object(envelope), dependencies) : await acceptEmailSendNotification(channel, object(envelope), dependencies)
        }
        else {
          const account = await request.user()
          if (!account) fail(401, 'unauthorized', 'Sign in to continue.')
          const project = await agentProject(Number(account.id), request.getParam('project'), ['owner', 'admin'])
          body = { receipts: (await query('SELECT * FROM support_email_receipts WHERE project_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 100', [project.id, project.workspace_id])).map(emailReceiptView) }
        }
        return Response.json(body, { status: operation === 'receipts' ? 200 : 202, headers: { 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        if (!(error instanceof SupportError) && process.env.APP_ENV === 'test') console.error(error)
        return Response.json({ error: { code: error instanceof SupportError ? error.code : 'email_unavailable', message: error instanceof SupportError ? error.message : 'Email intake is unavailable. Signed source has not been acknowledged.' } }, { status: error instanceof SupportError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } })
      }
    },
  })
}
