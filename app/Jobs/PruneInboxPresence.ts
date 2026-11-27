import { Job } from '@stacksjs/queue'
import { pruneInboxPresence } from '../Support/inbox-presence'

export default new Job({
  name: 'PruneInboxPresence',
  description: 'Remove expired inbox presence leases.',
  queue: 'support-retention',
  tries: 3,
  timeout: 30,
  async handle() { return await pruneInboxPresence() },
})
