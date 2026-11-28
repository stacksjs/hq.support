import { defineCommand } from '@stacksjs/cli'
import { loadOpenAiVoiceCostExport } from '../Support/openai-voice-costs'
import { previewVoiceCosts } from '../Support/voice-cost-preview'

export default defineCommand({
  name: 'support:voice-cost-preview',
  description: 'Compare reviewed Realtime cost evidence with a scoped voice wallet hold.',
  options: {
    '--file <path>': { description: 'Path to the reviewed Realtime billing scope JSON.' },
    '--source <path>': { description: 'Path to the original OpenAI Costs JSON response.' },
  },
  async handle(options) {
    if (typeof options.file !== 'string' || !options.file) throw new TypeError('Provide a reviewed cost file with --file.')
    if (typeof options.source !== 'string' || !options.source) throw new TypeError('Provide the original OpenAI Costs response with --source.')
    const preview = await previewVoiceCosts(await Bun.file(options.file).json(), await loadOpenAiVoiceCostExport(options.source))
    console.log(JSON.stringify(preview))
    if (preview.state !== 'matched') process.exitCode = 1
  },
})
