import { Job } from '@stacksjs/queue'
import { applyRetention, retentionTick } from '../../enterprise/retention'

export default new Job({
  name: 'ApplyEnterpriseRetention',
  description: 'Apply opted-in closed conversation content retention with legal holds.',
  queue: 'support-retention',
  tries: 5,
  timeout: 120,
  backoff: [30, 60, 300],
  rate: '0 * * * *',
  async handle(payload?: { workspaceId?: number }) {
    return payload?.workspaceId ? await applyRetention(payload.workspaceId) : await retentionTick()
  },
})
