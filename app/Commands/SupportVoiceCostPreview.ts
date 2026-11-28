import { defineCommand } from '@stacksjs/cli'
import { previewVoiceCosts } from '../Support/voice-cost-preview'

export default defineCommand({
  name: 'support:voice-cost-preview',
  description: 'Compare reviewed Realtime cost evidence with a scoped voice wallet hold.',
  options: { '--file <path>': { description: 'Path to the normalized Realtime cost evidence JSON.' } },
  async handle(options) {
    if (typeof options.file !== 'string' || !options.file) throw new TypeError('Provide a reviewed cost file with --file.')
    const preview = await previewVoiceCosts(await Bun.file(options.file).json())
    console.log(JSON.stringify(preview))
    if (preview.state !== 'matched') process.exitCode = 1
  },
})
