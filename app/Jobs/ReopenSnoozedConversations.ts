import { Job } from '@stacksjs/queue'
import { reopenSnoozedConversations } from '../Support/routing'

export default new Job({
  name: 'ReopenSnoozedConversations',
  description: 'Reopen snoozed conversations whose follow-up time has arrived.',
  queue: 'support-workflows',
  tries: 3,
  timeout: 60,
  async handle() { return await reopenSnoozedConversations() },
})
