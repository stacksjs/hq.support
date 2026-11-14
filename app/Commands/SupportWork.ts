import { defineCommand } from '@stacksjs/cli'
import { workflowWorkerTick } from '../Support/workflows'

export default defineCommand({
  name: 'support:work',
  description: 'Run one durable support workflow/outbox recovery batch. Schedule regularly beside native queue workers.',
  options: { '--limit <count>': { description: 'Maximum events and due runs in this batch (1 to 200).', default: 50, type: [Number] } },
  async handle(options) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new TypeError('limit must be 1 to 200')
    console.log(JSON.stringify(await workflowWorkerTick({ limit: options.limit })))
  },
})
