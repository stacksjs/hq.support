import { Job } from '@stacksjs/queue'
import { knowledgeIndexTick } from '../Support/knowledge-index'

export default new Job({
  name: 'IndexSupportKnowledge',
  description: 'Activate revision-safe durable support knowledge generations.',
  queue: 'support-knowledge',
  tries: 5,
  timeout: 120,
  backoff: [10, 30, 60],
  rate: '* * * * *',
  async handle() { return await knowledgeIndexTick() },
})
