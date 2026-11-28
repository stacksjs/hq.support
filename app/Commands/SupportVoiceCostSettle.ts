import { defineCommand } from '@stacksjs/cli'
import { settleVoiceCosts } from '../Support/voice-cost-settlement'

export default defineCommand({
  name: 'support:voice-cost-settle',
  description: 'Apply an approved reviewed Realtime cost or correction.',
  options: {
    '--file <path>': { description: 'Path to the normalized Realtime cost evidence JSON.' },
    '--approve <digest>': { description: 'Exact approval digest from the read-only voice cost preview.' },
    '--reason <text>': { description: 'Protected billing case reference and reason for this revision.' },
  },
  async handle(options) {
    if (typeof options.file !== 'string' || !options.file) throw new TypeError('Provide reviewed cost evidence with --file.')
    console.log(JSON.stringify(await settleVoiceCosts(await Bun.file(options.file).json(), options.approve, options.reason)))
  },
})
