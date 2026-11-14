import { Action } from '@stacksjs/actions/runtime'
import { agentProject } from '../../Support/service'
import { markRead } from '../../Support/reads'
import { SupportError } from '../../Support/errors'

export default new Action({
  name: 'Mark support conversation read', method: 'POST',
  async handle(request) {
    try {
      const userId = Number((await request.user())?.id)
      const project = await agentProject(userId, request.getParam('project'))
      return Response.json(await markRead(project, request.getParam('id'), userId, request.get('lastMessageId')), { headers: { 'Cache-Control': 'no-store' } })
    }
    catch (error) {
      if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      throw error
    }
  },
})
