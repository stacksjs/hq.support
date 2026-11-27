import { defineCommand } from '@stacksjs/cli'
import { settleSesInvoice } from '../Support/ses-cost-settlement'

export default defineCommand({
  name: 'support:ses-cost-settle',
  description: 'Apply an approved finalized SES billing pool or correction to the scoped wallet holds.',
  options: {
    '--file <path>': { description: 'Path to the reviewed normalized AWS CUR 2.0 pool JSON.' },
    '--approve <digest>': { description: 'Exact approval digest from the read-only cost preview.' },
    '--reason <text>': { description: 'Protected case reference and reason for this invoice revision.' },
  },
  async handle(options) {
    if (typeof options.file !== 'string' || !options.file) throw new TypeError('Provide a reviewed invoice pool with --file.')
    const result = await settleSesInvoice(await Bun.file(options.file).json(), options.approve, options.reason)
    console.log(JSON.stringify(result))
  },
})
