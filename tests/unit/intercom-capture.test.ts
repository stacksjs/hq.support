import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { captureIntercomBundle, writeIntercomCapture } from '../../app/Support/intercom-capture'

test('captures selected Intercom pages and private local attachments without following cursor or attachment hosts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intercom-capture-'))
  try {
    await writeFile(join(directory, 'first.txt'), 'initial bytes')
    const attachmentUrl = 'https://files.example.test/initial?private=signed'
    const capture = {
      region: 'eu', contacts: ['c1'], conversations: ['12345'],
      files: [{ conversationId: '12345', index: 0, path: 'first.txt' }],
    }
    const calls: URL[] = []
    const { archive, summary } = await captureIntercomBundle(capture, {
      token: 'controlled-key', directory,
      async transport(url, init) {
        calls.push(url)
        expect(url.origin).toBe('https://api.eu.intercom.io')
        expect(init.method).toBe('GET')
        expect(init.redirect).toBe('error')
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer controlled-key')
        expect(new Headers(init.headers).get('intercom-version')).toBe('2.18')
        if (url.pathname === '/contacts/c1') return Response.json({ type: 'contact', id: 'c1', name: 'Fixture Contact' })
        expect(url.pathname).toBe('/conversations/12345')
        expect([...url.searchParams.keys()]).toEqual(['page', 'per_page', 'display_as'])
        expect(url.searchParams.get('display_as')).toBe('plaintext')
        const page = Number(url.searchParams.get('page'))
        const source = { body: 'initial text', attachments: [{ url: attachmentUrl, filesize: 13 }] }
        const replies = page === 1 ? Array.from({ length: 100 }, (_, index) => ({ id: String(index), attachments: [] }))
          : [{ id: '100', body: 'later text', attachments: [{ url: 'https://files.example.test/any-note' }] }]
        const next = page === 1 ? 'https://untrusted.example.test/conversations/12345?page=2' : null
        return Response.json({ id: '12345', source, conversation_parts: { conversation_parts: replies, total_count: replies.length, pages: { page, per_page: 100, total_pages: 2, next } } })
      },
    })
    expect(calls.map(url => [url.pathname, url.searchParams.get('page')])).toEqual([
      ['/contacts/c1', null], ['/conversations/12345', '1'], ['/conversations/12345', '2'],
    ])
    const value = JSON.parse(archive)
    expect(value.conversations[0].pages[1].response.conversation_parts.conversation_parts[0].body).toBe('later text')
    expect(value.attachmentFiles).toEqual([{ url: attachmentUrl, data: Buffer.from('initial bytes').toString('base64'), sha256: createHash('sha256').update('initial bytes').digest('hex') }])
    expect(summary).toEqual({ contacts: 1, conversations: 1, files: 1, missingAttachments: [{ conversationId: '12345', partId: '100', index: 0 }] })
    expect(archive).not.toContain('controlled-key')
    const output = join(directory, 'archive.json')
    await writeIntercomCapture(output, archive)
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    await expect(writeIntercomCapture(output, '{}')).rejects.toThrow()
    expect(await readFile(output, 'utf8')).toBe(archive)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})

test('refuses a filtered, noncontiguous or truncated sequence and reports missing sources by ID', async () => {
  const plan = { conversations: ['12345'] }
  const parts = Array.from({ length: 100 }, (_, index) => ({ id: String(index) }))
  for (const next of ['https://api.intercom.io/conversations/12345?page=2&include_part_types=comment', 'https://api.intercom.io/conversations/12345?page=3', null]) {
    let calls = 0
    await expect(captureIntercomBundle(plan, { token: 'controlled-key', directory: tmpdir(), async transport() {
      calls++
      return Response.json({ id: '12345', source: {}, conversation_parts: { conversation_parts: parts, total_count: 100, pages: { page: 1, per_page: 100, total_pages: 2, next } } })
    } })).rejects.toThrow()
    expect(calls).toBe(1)
  }
  await expect(captureIntercomBundle(plan, {
    token: 'controlled-key', directory: tmpdir(), transport: async () => new Response('private body', { status: 404 }),
  })).rejects.toThrow('Intercom conversations/12345 returned HTTP 404.')
})
