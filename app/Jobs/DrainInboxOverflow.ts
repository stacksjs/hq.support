import { Job } from '@stacksjs/queue'
import { drainInboxOverflow } from '../Support/routing'

export default new Job({
  name: 'DrainInboxOverflow',
  description: 'Assign eligible conversations left in round-robin inbox overflow.',
  queue: 'support-workflows',
  tries: 3,
  timeout: 60,
  async handle() { return await drainInboxOverflow() },
})
