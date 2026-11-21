type SupportController = ReturnType<typeof import('./loader').createSupport>

/** Load the same hosted Messenger that customers embed on their own sites. */
export async function connectSiteMessenger(pageSignal: AbortSignal, launcher: HTMLElement): Promise<SupportController> {
  const signal = AbortSignal.any([pageSignal, AbortSignal.timeout(15000)])
  const response = await fetch('/api/support/site-messenger', { cache: 'no-store', credentials: 'omit', signal })
  if (!response.ok) throw new Error('Support chat could not connect.')
  const { project } = await response.json() as { project: string | null }
  if (!project) throw new Error('Support chat is unavailable.')

  const entrypoint = new URL('/support.js', location.origin).href
  const { createSupport } = await import(entrypoint) as typeof import('./loader')
  signal.throwIfAborted()
  const support = createSupport()
  const shutdown = () => support.shutdown()
  signal.addEventListener('abort', shutdown, { once: true })
  try {
    await support.boot({ project, externalLauncher: launcher, resumeAnonymousSession: true })
    signal.throwIfAborted()
    return support
  }
  catch (error) {
    shutdown()
    throw error
  }
  finally {
    signal.removeEventListener('abort', shutdown)
  }
}
