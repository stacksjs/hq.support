import { Job } from '@stacksjs/queue'
import { executeWorkflowRun, workflowWorkerTick } from '../Support/workflows'

export default new Job({
  name: 'RunSupportWorkflows',
  description: 'Recover durable support workflow triggers, waits and steps.',
  queue: 'support-workflows',
  tries: 5,
  timeout: 60,
  backoff: [1, 5, 30, 60],
  rate: '* * * * *',
  enabled: true,
  async handle(payload?: { runId?: number }) {
    return payload?.runId ? await executeWorkflowRun(payload.runId) : await workflowWorkerTick()
  },
})
