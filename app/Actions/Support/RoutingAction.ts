import { Action } from '@stacksjs/actions/runtime'
import { agentProject, idempotent, member, object } from '../../Support/service'
import { identifier, SupportError } from '../../Support/errors'
import * as routing from '../../Support/routing'

export function routingAction(operation: 'teams' | 'team.save' | 'team.member' | 'agents' | 'agent.save' | 'inboxes' | 'inbox.save' | 'route' | 'audit') {
  return new Action({
    name: `Support routing ${operation}`, apiResponse: false, method: ['teams', 'agents', 'inboxes', 'audit'].includes(operation) ? 'GET' : 'POST',
    async handle(request) {
      try {
        const userId = identifier((await request.user())?.id), input = object(request.all())
        if (JSON.stringify(input).length > 10000) return Response.json({ error: { code: 'body_too_large' } }, { status: 413 })
        const projectRef = request.getParam('project'), id = request.getParam('id')
        let data: unknown
        if (!projectRef) {
          const workspaceId = identifier(request.getParam('workspace'))
          await member(userId, workspaceId)
          if (operation === 'teams') data = await routing.listTeams(workspaceId, userId)
          else if (operation === 'team.save') data = { team: await routing.saveTeam(workspaceId, input, userId, id) }
          else if (operation === 'team.member') data = { member: await routing.saveTeamMember(workspaceId, id, input, userId) }
          else if (operation === 'agents') data = await routing.listAgents(workspaceId, userId)
          else data = { agent: await routing.saveAgent(workspaceId, input, userId) }
        }
        else {
          const project = await agentProject(userId, projectRef)
          if (operation === 'inboxes') data = await routing.listInboxes(project, userId)
          else if (operation === 'inbox.save') data = { inbox: await routing.saveInbox(project, input, userId, id) }
          else if (operation === 'audit') data = await routing.assignmentHistory(project, id, userId)
          else { const assign = () => routing.routeConversation(project, id, input, { userId, source: 'manual' }); data = input.idempotencyKey === undefined ? await assign() : await idempotent(project, `routing:${identifier(id)}:${userId}`, input.idempotencyKey, input, assign) }
        }
        return Response.json(data, { status: ['team.save', 'inbox.save'].includes(operation) && !id ? 201 : 200, headers: { 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        throw error
      }
    },
  })
}
