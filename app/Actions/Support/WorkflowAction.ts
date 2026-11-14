import { Action } from '@stacksjs/actions/runtime'
import { one, query } from '../../Support/database'
import { agentProject, member, object } from '../../Support/service'
import { identifier, SupportError, fail } from '../../Support/errors'
import { createWorkflow, listWorkflows, pauseWorkflow, publishWorkflow, saveDraft } from '../../Support/workflows'

export function workflowAction(operation: 'list' | 'create' | 'draft' | 'publish' | 'pause' | 'runs' | 'run') {
  return new Action({
    name: `Support workflow ${operation}`, apiResponse: false, method: ['list', 'runs', 'run'].includes(operation) ? 'GET' : 'POST',
    async handle(request) {
      try {
        const userId = Number((await request.user())?.id), project = await agentProject(userId, request.getParam('project'))
        const input = object(request.all()), id = request.getParam('id')
        if (operation === 'list') return { ...await listWorkflows(project) }
        if (operation === 'create') return Response.json({ workflow: await createWorkflow(project, input, userId) }, { status: 201 })
        if (operation === 'draft') return { workflow: await saveDraft(project, id, input, userId) }
        if (operation === 'publish') return await publishWorkflow(project, id, userId)
        if (operation === 'pause') return await pauseWorkflow(project, id, userId)
        await member(userId, Number(project.workspace_id), ['owner', 'admin'])
        if (operation === 'runs') return { runs: await query('SELECT id, workflow_id, workflow_version_id, event_id, status, cursor, step_count, attempts, available_at, last_error, created_at, updated_at FROM support_workflow_runs WHERE project_id = ? AND workspace_id = ? ORDER BY id DESC LIMIT 100', [project.id, project.workspace_id]) }
        const run = await one('SELECT * FROM support_workflow_runs WHERE id = ? AND project_id = ? AND workspace_id = ?', [identifier(id), project.id, project.workspace_id])
        if (!run) fail(404, 'not_found', 'Workflow run not found.')
        return { run, steps: await query('SELECT step_id, type, result, created_at FROM support_workflow_steps WHERE workflow_run_id = ? AND project_id = ? ORDER BY id ASC', [run.id, project.id]) }
      }
      catch (error) {
        if (error instanceof SupportError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
        throw error
      }
    },
  })
}
