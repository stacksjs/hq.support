import { dirname, resolve } from 'node:path'
import { defineCommand } from '@stacksjs/cli'
import { intercomBundleLimits } from '../Support/intercom-bundle'
import { captureIntercomBundle, writeIntercomCapture } from '../Support/intercom-capture'
import { parseIntercomBundle } from '../Support/imports'

export default defineCommand({
  name: 'support:intercom-capture',
  description: 'Capture selected Intercom histories and local attachment bytes into a private migration archive.',
  options: {
    '--plan <path>': { description: 'Private JSON plan of source IDs and local attachment positions.' },
    '--output <path>': { description: 'New private archive file.' },
  },
  async handle({ plan, output }) {
    if (!plan || !output) throw new Error('Provide both --plan and --output.')
    const planPath = resolve(plan)
    const planFile = Bun.file(planPath)
    if (planFile.size < 1 || planFile.size > intercomBundleLimits.bytes) throw new Error('Provide a nonempty, bounded capture plan file.')
    const { archive, summary } = await captureIntercomBundle(await planFile.json(), {
      token: process.env.INTERCOM_ACCESS_TOKEN?.trim() ?? '', directory: dirname(planPath),
    })
    parseIntercomBundle(Buffer.from(archive))
    await writeIntercomCapture(output, archive)
    console.log(JSON.stringify(summary))
  },
})
