import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { archivePayload, inspectPayload, packageName, payloadHashes, sha256 } from './support-elements-artifact'

const packageMetadataUrl = 'https://registry.npmjs.org/@stacksjs%2fsupport-elements'

interface RegistryOptions {
  deadlineMs?: number
  requestTimeoutMs?: number
  retryDelayMs?: number
  fetch?: (url: string | URL, init: RequestInit) => Promise<Response>
}

// One monotonic deadline covers metadata, archive and tags, including response bodies.
// Validation belongs outside this transport loop so corrupt public bytes fail at once.
export function createRegistryReader(options: RegistryOptions = {}) {
  const { deadlineMs = 300000, requestTimeoutMs = 15000, retryDelayMs = 5000 } = options
  for (const value of [deadlineMs, requestTimeoutMs, retryDelayMs]) assert.ok(Number.isFinite(value) && value > 0, 'Registry deadlines and retry delays must be finite positive numbers')
  const deadline = performance.now() + deadlineMs, request = options.fetch || fetch
  return async (url: string | URL, processingMetadata = false): Promise<Uint8Array> => {
    let reason = 'deadline reached'
    while (performance.now() < deadline) {
      const controller = new AbortController(), timeout = Math.min(requestTimeoutMs, deadline - performance.now())
      let timer: ReturnType<typeof setTimeout> | undefined
      let response: Response | undefined, bytes: Uint8Array | undefined
      try {
        const timedOut = Promise.withResolvers<never>()
        timer = setTimeout(() => { controller.abort(); timedOut.reject(new DOMException('Registry request timed out', 'TimeoutError')) }, Math.max(1, timeout))
        const result = await Promise.race([(async () => {
          const result = await request(url, { redirect: 'manual', signal: controller.signal })
          if (result.ok) return { response: result, bytes: new Uint8Array(await result.arrayBuffer()) }
          await result.body?.cancel()
          return { response: result, bytes: undefined }
        })(), timedOut.promise])
        response = result.response; bytes = result.bytes
      }
      catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))) throw error
        reason = 'transient network failure or request timeout'
      }
      finally { clearTimeout(timer); controller.abort() }
      if (performance.now() >= deadline) break
      if (response) {
        if (response.ok) return bytes!
        assert.ok(response.status === 429 || (response.status >= 500 && response.status < 600) || (processingMetadata && response.status === 404), `Public registry read failed: HTTP ${response.status}`)
        reason = `HTTP ${response.status}`
      }
      const remaining = deadline - performance.now()
      if (remaining <= 0) break
      // A timer may wake early. Only the absolute retry time permits another read.
      const retryAfter = response?.headers.get('retry-after')
      const requestedDelay = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryDelayMs
      const retryAt = performance.now() + Math.max(retryDelayMs, requestedDelay), wakeAt = Math.min(deadline, retryAt)
      while (performance.now() < wakeAt) await Bun.sleep(Math.max(1, Math.ceil(wakeAt - performance.now())))
      if (retryAt >= deadline) break
    }
    throw new Error(`Public registry readback deadline exceeded after ${deadlineMs}ms (${reason}); upload acceptance does not establish public consumer verification`)
  }
}

export async function assertAlphaTagCanAdvance(version: string, read = createRegistryReader()) {
  const metadata = JSON.parse(new TextDecoder().decode(await read(packageMetadataUrl)))
  assert.equal(metadata.name, packageName)
  const tags = metadata['dist-tags']
  assert.ok(tags && typeof tags === 'object' && !Array.isArray(tags), 'Invalid npm dist-tag metadata.')
  if (tags.alpha === undefined) return
  const alphaVersion = /^0\.1\.0-alpha\.(?:0|[1-9]\d*)$/
  assert.ok(typeof tags.alpha === 'string' && alphaVersion.test(tags.alpha), 'Invalid current npm alpha tag.')
  assert.match(version, alphaVersion)
  assert.ok(Bun.semver.order(version, tags.alpha) >= 0, 'Publishing this version would move the npm alpha tag backward.')
}

export async function readPublishedElements(release: { version: string, archiveSha256: string, files: Record<string, string> }, read = createRegistryReader()) {
  const metadata = JSON.parse(new TextDecoder().decode(await read(`${packageMetadataUrl}/${release.version}`, true)))
  assert.equal(metadata.name, packageName); assert.equal(metadata.version, release.version)
  const url = new URL(metadata.dist.tarball); assert.equal(url.origin, 'https://registry.npmjs.org'); assert.equal(url.username, ''); assert.equal(url.password, '')
  const bytes = await read(url)
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, metadata.dist.integrity)
  assert.equal(sha256(bytes), release.archiveSha256, 'Public npm archive bytes differ from the reviewed CI archive')
  const published = await archivePayload(bytes); inspectPayload(published, release.version); assert.deepEqual(payloadHashes(published), release.files, 'Public npm payload differs from the reviewed same-SHA CI artifact')
  const tags = JSON.parse(new TextDecoder().decode(await read(packageMetadataUrl, true)))['dist-tags']
  assert.equal(tags.alpha, release.version, 'The verified release must be tagged alpha')
  return { published, tags }
}
