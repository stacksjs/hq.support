import { defineCommand } from '@stacksjs/cli'
import { loadOpenAiVoiceCostExport } from '../Support/openai-voice-costs'
import { settleVoiceCosts } from '../Support/voice-cost-settlement'

export default defineCommand({
  name: 'support:voice-cost-settle',
  description: 'Apply an approved reviewed Realtime cost or correction.',
  options: {
    '--file <path>': { description: 'Path to the reviewed Realtime billing scope JSON.' },
    '--source <path>': { description: 'Path to the original OpenAI Costs JSON response.' },
    '--approve <digest>': { description: 'Exact approval digest from the read-only voice cost preview.' },
    '--reason <text>': { description: 'Protected billing case reference and reason for this revision.' },
  },
  async handle(options) {
    if (typeof options.file !== 'string' || !options.file) throw new TypeError('Provide reviewed cost evidence with --file.')
    if (typeof options.source !== 'string' || !options.source) throw new TypeError('Provide the original OpenAI Costs response with --source.')
    console.log(JSON.stringify(await settleVoiceCosts(await Bun.file(options.file).json(), await loadOpenAiVoiceCostExport(options.source), options.approve, options.reason)))
  },
})
