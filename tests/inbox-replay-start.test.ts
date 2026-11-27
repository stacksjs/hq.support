import { expect, test } from 'bun:test'
import { createInboxReplay } from '../resources/functions/support/inbox-replay'

test('connects promptly after the initial inbox refresh was busy', async () => {
  const checkpoint = { incarnation: 'first-snapshot', seq: 3 }
  const streamOpened = Promise.withResolvers<unknown>()
  let snapshots = 0
  let refreshes = 0
  const inbox = createInboxReplay(async (path, init) => {
    if (path.endsWith('/snapshot')) {
      snapshots++
      return Response.json({ checkpoint })
    }
    if (path.endsWith('/stream')) {
      streamOpened.resolve(JSON.parse(String(init?.body)).checkpoint)
      return new Response(': connected\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json({ cursor: checkpoint })
  }, async () => ++refreshes > 1, () => undefined)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    inbox.start('draft-project')
    const opened = await Promise.race([
      streamOpened.promise,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Inbox stream waited for the periodic poll.')), 3_000) }),
    ])
    expect(opened).toEqual(checkpoint)
    expect(snapshots).toBe(1)
    expect(refreshes).toBe(2)
  }
  finally {
    clearTimeout(deadline)
    inbox.stop()
  }
})
