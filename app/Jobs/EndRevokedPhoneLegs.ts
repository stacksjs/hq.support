import { Job } from '@stacksjs/queue'
import { processPhoneRevocation, recoverPhoneRevocations } from '../Support/phone-agents'

export default new Job({
  name: 'EndRevokedPhoneLegs',
  description: 'End provider voice legs after workspace membership revocation.',
  queue: 'support-workflows',
  tries: 3,
  timeout: 60,
  async handle(payload?: { dialId?: number }) {
    if (payload?.dialId) await processPhoneRevocation(payload.dialId)
    else await recoverPhoneRevocations()
  },
})
