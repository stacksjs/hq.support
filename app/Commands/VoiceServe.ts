import { defineCommand } from '@stacksjs/cli'

export default defineCommand({
  name: 'voice:serve',
  description: 'Serve authenticated provider voice Media Streams.',
  async handle() {
    const { startVoiceServer } = await import('../Support/voice-server')
    const server = await startVoiceServer({ hostname: process.env.SUPPORT_VOICE_HOST || '0.0.0.0' })
    console.log(`Voice media server listening on port ${server.port}`)
  },
})
