import { defineCommand } from '@stacksjs/cli'
import { previewSesOutboundCosts } from '../Support/ses-cost-preview'

export default defineCommand({
  name: 'support:ses-cost-preview',
  description: 'Compare a reviewed AWS SES outbound invoice pool with signed local send evidence.',
  options: { '--file <path>': { description: 'Path to the normalized AWS CUR 2.0 pool JSON.' } },
  async handle(options) {
    if (typeof options.file !== 'string' || !options.file) throw new TypeError('Provide a normalized AWS SES invoice pool with --file.')
    const preview = await previewSesOutboundCosts(await Bun.file(options.file).json())
    console.log(JSON.stringify(preview))
    if (preview.state !== 'matched') process.exitCode = 1
  },
})
