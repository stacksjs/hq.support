import { createHash } from 'node:crypto'
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { intercomBundleLimits as limits, intercomNextPage } from './intercom-bundle'

const hosts = { us: 'https://api.intercom.io', eu: 'https://api.eu.intercom.io', au: 'https://api.au.intercom.io' }
const pageSize = 100
const maximumPages = limits.maximumPaginatedParts / pageSize
const sourceId = /^[a-z\d_.:-]{1,200}$/i
type RecordValue = Record<string, unknown>
type Transport = (url: URL, init: RequestInit) => Promise<Response>
type Location = { conversationId: string, partId: string | null, index: number }

function record(value: unknown): RecordValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as RecordValue
  throw new Error('Expected an Intercom object.')
}

function ids(value: unknown, pattern: RegExp, label: string): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id === '.' || id === '..' || !pattern.test(id)) || new Set(value).size !== value.length)
    throw new Error(`${label} must contain unique Intercom ID strings.`)
  return value
}

function attachmentKey(location: Location) {
  return JSON.stringify([location.conversationId, location.partId, location.index])
}

function capturePlan(input: unknown) {
  const { region = 'us', conversations, contacts = [], files = [] } = record(input)
  if (typeof region !== 'string' || !Object.hasOwn(hosts, region)) throw new Error('Intercom region must be us, eu, or au.')
  const conversationIds = ids(conversations, /^\d{1,200}$/, 'conversations')
  const contactIds = ids(contacts, sourceId, 'contacts')
  if (!conversationIds.length || conversationIds.length + contactIds.length > limits.records)
    throw new Error(`Select at least one conversation and at most ${limits.records} total records per capture.`)
  if (!Array.isArray(files) || files.length > limits.attachmentFiles)
    throw new Error(`Select at most ${limits.attachmentFiles} local attachment files per capture.`)
  const selections = new Map<string, string>()
  for (const value of files) {
    const { conversationId, partId = null, index, path } = record(value)
    if (typeof conversationId !== 'string' || !conversationIds.includes(conversationId)
      || (partId !== null && (typeof partId !== 'string' || !sourceId.test(partId)))
      || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0
      || typeof path !== 'string' || !path.trim()) throw new Error('Each file must identify a selected conversation, part, index and local path.')
    const key = attachmentKey({ conversationId, partId, index })
    if (selections.has(key)) throw new Error('A source attachment position may appear only once in a capture plan.')
    selections.set(key, path)
  }
  return { host: hosts[region as keyof typeof hosts], conversationIds, contactIds, selections }
}

async function readIntercomObject(response: Response) {
  if (!response.body) throw new Error('Intercom returned no response body.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limits.bytes) throw new Error('An Intercom response exceeds the migration bundle size limit.')
      chunks.push(value)
    }
  }
  finally { await reader.cancel() }
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
  catch { throw new Error('Intercom returned an invalid JSON object.') }
}

export async function captureIntercomBundle(input: unknown, { token, directory, transport }: {
  token: string, directory: string, transport?: Transport,
}) {
  const plan = capturePlan(input)
  if (!token || !/^\S+$/.test(token)) throw new Error('Supply the Intercom access token through INTERCOM_ACCESS_TOKEN.')
  const request = transport ?? globalThis.fetch
  let retainedBytes = 0
  function reserveBytes(value: unknown) {
    retainedBytes += Buffer.byteLength(JSON.stringify(value))
    if (retainedBytes > limits.bytes) throw new Error('Split the selection into smaller migration bundles.')
  }
  async function retrieve(path: string, id: string, query: Record<string, string>) {
    const url = new URL(`/${path}/${encodeURIComponent(id)}`, plan.host)
    url.search = new URLSearchParams(query).toString()
    const response = await request(url, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'Intercom-Version': '2.18' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Intercom ${path}/${id} returned HTTP ${response.status}.`)
    }
    const result = await readIntercomObject(response)
    if (String(result.id) !== id) throw new Error(`Intercom returned a different record for ${path}/${id}.`)
    reserveBytes(result)
    return result
  }

  const locations = new Map<string, { location: Location, url: string, size: unknown }>()
  function rememberAttachments(message: unknown, conversationId: string, partId: string | null) {
    if (!message || typeof message !== 'object' || !('attachments' in message) || !Array.isArray(message.attachments)) return
    for (const [index, attachment] of message.attachments.entries()) {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) continue
      const metadata = attachment as RecordValue
      if (typeof metadata.url !== 'string' || !/^https?:\/\//i.test(metadata.url) || metadata.url.length > 4096) continue
      const location = { conversationId, partId, index }
      locations.set(attachmentKey(location), { location, url: metadata.url, size: metadata.filesize })
    }
  }

  const contacts = []
  for (const id of plan.contactIds) contacts.push(await retrieve('contacts', id, { escape_identity: 'false' }))
  const conversations = []
  for (const id of plan.conversationIds) {
    const pages: { page: number, response: RecordValue }[] = []
    let page = 1
    let totalPages: number | undefined
    while (true) {
      const response = await retrieve('conversations', id, { page: String(page), per_page: String(pageSize), display_as: 'plaintext' })
      const container = record(response.conversation_parts)
      const paging = record(container.pages)
      if (Number(paging.page) !== page || !Array.isArray(container.conversation_parts))
        throw new Error(`Intercom conversations/${id} returned unexpected page metadata.`)
      const parts = container.conversation_parts
      const next = intercomNextPage(paging.next)
      const last = next === null
      const declaredPages = Number(paging.total_pages)
      const empty = page === 1 && parts.length === 0 && declaredPages === 0
      const completeParts = Number(paging.per_page) === pageSize && Number(container.total_count) === parts.length
        && (last ? parts.length <= pageSize : parts.length === pageSize)
      const stablePageCount = Number.isSafeInteger(declaredPages) && declaredPages <= maximumPages
        && (empty || declaredPages >= page) && (totalPages === undefined || totalPages === declaredPages)
      const completeCursor = last ? empty || page === declaredPages : next === page + 1 && next <= declaredPages
      if (!completeParts || !stablePageCount || !completeCursor)
        throw new Error(`Intercom conversations/${id} did not provide a complete bounded page sequence.`)
      totalPages = declaredPages
      pages.push({ page, response })
      if (page === 1) rememberAttachments(response.source, id, null)
      for (const item of parts) {
        const part = record(item)
        rememberAttachments(part, id, String(part.id))
      }
      if (last) break
      // Build the next request on the chosen Intercom host. Provider cursors
      // are retained as evidence, and cannot redirect the bearer token.
      page = next
    }
    conversations.push({ pages })
  }

  const attachmentFiles = new Map<string, { url: string, data: string, sha256: string }>()
  for (const [key, filename] of plan.selections) {
    const source = locations.get(key)
    if (!source) throw new Error(`No source attachment matches position ${key}.`)
    const file = Bun.file(resolve(directory, filename))
    if (file.size < 1 || file.size > limits.bytes || (source.size != null && source.size !== file.size))
      throw new Error(`The local file at position ${key} is missing or its size disagrees with the source.`)
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.length !== file.size) throw new Error(`The local file at position ${key} changed during capture.`)
    const supplied = { url: source.url, data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
    const previous = attachmentFiles.get(source.url)
    if (previous && previous.sha256 !== supplied.sha256) throw new Error('One source attachment URL was supplied with conflicting bytes.')
    if (!previous) reserveBytes(supplied)
    attachmentFiles.set(source.url, supplied)
  }

  const archive = JSON.stringify({ version: 1, provider: 'intercom', format: 'plaintext', contacts, conversations, attachmentFiles: [...attachmentFiles.values()] })
  if (Buffer.byteLength(archive) > limits.bytes) throw new Error('Split the selection into smaller migration bundles.')
  const missingAttachments = [...locations.values()].filter(item => !attachmentFiles.has(item.url)).map(item => item.location)
  return { archive, summary: { contacts: contacts.length, conversations: conversations.length, files: attachmentFiles.size, missingAttachments } }
}

export async function writeIntercomCapture(output: string, archive: string) {
  const destination = resolve(output)
  const directory = await mkdtemp(join(dirname(destination), '.intercom-capture-'))
  try {
    const temporary = join(directory, 'archive.json')
    await writeFile(temporary, archive, { mode: 0o600, flag: 'wx' })
    await link(temporary, destination)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}
