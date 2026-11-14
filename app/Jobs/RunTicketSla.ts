import { Job } from '@stacksjs/queue'
import { ticketSlaTick } from '../Support/ticket-sla'

export default new Job({
  name: 'RunTicketSla',
  description: 'Persist due ticket SLA escalation work and transactional outbox intents.',
  queue: 'support-sla',
  tries: 5,
  timeout: 120,
  backoff: [10, 30, 60],
  rate: '* * * * *',
  async handle() { return await ticketSlaTick() },
})
