import { Job } from '@stacksjs/queue'
import { processImportBatch, recoverImportRuns } from '../Support/imports'

export default new Job({
  name: 'RunSupportImport', description: 'Resume private support migration records from durable checkpoints.',
  queue: 'support-imports', tries: 5, timeout: 60, backoff: [1, 5, 30, 60], rate: '* * * * *', enabled: true,
  async handle(payload?: { runId?: number, batchSize?: number }) {
    return payload?.runId ? await processImportBatch(payload.runId, { batchSize: payload.batchSize }) : await recoverImportRuns()
  },
})
