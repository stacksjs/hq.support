import { Job } from '@stacksjs/queue'
import { processEmailReceipt, recoverEmailReceipts } from '../Support/email-receipts'
import { registerSupportEmail } from '../Support/support-email'
registerSupportEmail()
export default new Job({
  name: 'RunSupportEmail', description: 'Archive signed SES receipts and recover private MIME ingestion.',
  queue: 'support-email', tries: 5, timeout: 120, backoff: [10, 30, 60], rate: '* * * * *', enabled: true,
  async handle(payload?: { receiptId?: number }) { return payload?.receiptId ? await processEmailReceipt(payload.receiptId) : await recoverEmailReceipts() },
})
