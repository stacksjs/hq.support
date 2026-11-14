import assert from 'node:assert/strict'
import { createSupportSettings } from '../../resources/functions/support/settings'

/** The production controller over real native auth/HTTP/SQL, with delayed transport responses. */
export async function qualifyCredentialSettingsBoundary(input: { api: string, project: string, otherProject: string, signIn: () => Promise<string> }) {
  const originalFetch = globalThis.fetch
  let checks = 0
  const check = (value: unknown, message: string) => { assert.ok(value, message); checks++ }
  type Kind = 'rotate' | 'issue' | 'list'
  type Boundary = 'logout' | 'logout-failure' | 'project' | 'destroy'
  const scenarios = [...(['logout', 'logout-failure', 'project', 'destroy'] as Boundary[]).map(boundary => ({ boundary, lateFailure: false })), { boundary: 'logout' as const, lateFailure: true }]
  for (const kind of ['rotate', 'issue', 'list'] as Kind[]) for (const { boundary, lateFailure } of scenarios) {
    const browserCookie = await input.signIn(), jar = new Map<string, string>()
    for (const item of browserCookie.split(';')) { const at = item.indexOf('='); if (at >= 0) jar.set(item.slice(0, at).trim(), item.slice(at + 1)) }
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), logoutEntered = Promise.withResolvers<void>(), logoutRelease = Promise.withResolvers<void>()
    let hold = false, failLogout = boundary === 'logout-failure', holdLogout = boundary === 'logout', sent = 0
    const settings = createSupportSettings()
    globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
      if (typeof resource !== 'string' || !resource.startsWith('/api/')) return await originalFetch(resource, init)
      sent++
      if (resource === '/api/logout' && failLogout) throw new TypeError('Fixture disconnect before logout reaches native HTTP')
      const headers = new Headers(init?.headers); headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
      const response = await originalFetch(new URL(resource, input.api), { ...init, headers })
      for (const cookie of response.headers.getSetCookie()) { const value = cookie.split(';')[0]!, at = value.indexOf('='); jar.set(value.slice(0, at), value.slice(at + 1)) }
      const method = init?.method || 'GET', target = `/api/support/projects/${input.project}/keys`
      if (hold && (kind === 'rotate' ? resource.endsWith('/rotate') : resource === target && method === (kind === 'issue' ? 'POST' : 'GET'))) {
        hold = false; entered.resolve(); await release.promise
        if (lateFailure) throw new TypeError('Fixture late response disconnect after native commit')
      }
      if (resource === '/api/logout' && holdLogout) { holdLogout = false; logoutEntered.resolve(); await logoutRelease.promise }
      return response
    }) as typeof fetch
    try {
      await settings.load(); await settings.loadKeys()
      await settings.issueKeys()
      const key = settings.keyList().find(row => row.status === 'active' && row.scope === 'write')!
      check(key && settings.keys().ingestKey, `${kind}/${boundary}: actual native owner starts with a secret-bearing response`)
      hold = true
      const active = kind === 'rotate' ? settings.rotateKey(key.id) : kind === 'issue' ? settings.issueKeys() : settings.loadKeys()
      await entered.promise
      let logout: Promise<void> | undefined
      if (boundary.startsWith('logout')) {
        logout = settings.signOut()
        if (boundary === 'logout-failure') await assert.rejects(logout, /Fixture disconnect/)
        else await logoutEntered.promise
        check(!Object.keys(settings.keys()).length && !settings.keyList().length && !settings.keyRetry() && settings.keyCursor() === null, `${kind}/${boundary}: logout clears credentials synchronously before its response`)
      }
      else if (boundary === 'project') { settings.project.set(input.otherProject); settings.select(); await settings.loadKeys() }
      else settings.destroy()
      const newerMetadata = JSON.stringify(settings.keyList()), newerError = settings.error()
      release.resolve(); await active
      check(!Object.keys(settings.keys()).length && !settings.keyRetry(), `${kind}/${boundary}: a delayed response cannot restore a revealed secret or retry context`)
      check(JSON.stringify(settings.keyList()) === newerMetadata && settings.error() === newerError, `${kind}/${boundary}: a delayed response cannot replace current metadata or error state`)
      if (boundary === 'project') {
        await settings.issueKeys()
        check(settings.project() === input.otherProject && settings.pending() === false && settings.keys().ingestKey?.length === 64 && settings.keyList().some(row => row.status === 'active'), `${kind}/${boundary}: a new project can issue real keys after old work settles`)
      }
      else {
        const before = sent
        await settings.issueKeys(); await settings.rotateKey(key.id); await settings.revokeKey(key.id); await settings.loadKeys(); await settings.load(); await settings.save(); await settings.retryKeys(); settings.discardRetry(); settings.select()
        check(sent === before && !Object.keys(settings.keys()).length && !settings.keyRetry(), `${kind}/${boundary}: credential work cannot restart after logout or destruction`)
      }
      if (boundary === 'logout') { const beforeDuplicate = sent, duplicateLogout = settings.signOut(); check(sent === beforeDuplicate, `${kind}/${boundary}: concurrent logout is deduplicated`); logoutRelease.resolve(); await Promise.all([logout, duplicateLogout]); const before = sent; await settings.issueKeys(); await settings.loadKeys(); check(sent === before, `${kind}/${boundary}: credentials stay blocked while navigation is pending`) }
      if (boundary === 'logout-failure') { check((await originalFetch(input.api + '/api/support/me', { headers: { cookie: browserCookie } })).status === 200, `${kind}/${boundary}: UI stays closed even when the native session is still valid`); failLogout = false; await settings.signOut(); check(!Object.keys(settings.keys()).length, `${kind}/${boundary}: failed logout remains retryable without reopening credentials`) }
    }
    finally { release.resolve(); logoutRelease.resolve(); settings.destroy(); globalThis.fetch = originalFetch }
  }
  // A request still waiting for CSRF has not acquired authority to dispatch
  // after its controller context ends. The logout's own CSRF path stays usable.
  for (const kind of ['rotate', 'issue'] as const) for (const boundary of ['logout', 'destroy'] as const) {
    const browserCookie = await input.signIn(), jar = new Map<string, string>([browserCookie.split('=') as [string, string]])
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let holdCsrf = true, mutations = 0
    const settings = createSupportSettings()
    globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
      if (typeof resource !== 'string' || !resource.startsWith('/api/')) return await originalFetch(resource, init)
      if (resource.includes('/keys') && init?.method === 'POST') mutations++
      const headers = new Headers(init?.headers); headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
      const response = await originalFetch(new URL(resource, input.api), { ...init, headers })
      for (const cookie of response.headers.getSetCookie()) { const value = cookie.split(';')[0]!, at = value.indexOf('='); jar.set(value.slice(0, at), value.slice(at + 1)) }
      if (resource === '/api/csrf-token' && holdCsrf) { holdCsrf = false; entered.resolve(); await release.promise }
      return response
    }) as typeof fetch
    try {
      await settings.load(); await settings.loadKeys()
      const key = settings.keyList().find(row => row.status === 'active')!
      check(key, `${kind}/${boundary}/CSRF: native metadata supplies a real active key`)
      const active = kind === 'rotate' ? settings.rotateKey(key.id) : settings.issueKeys()
      await entered.promise
      if (boundary === 'logout') await settings.signOut()
      else settings.destroy()
      release.resolve(); await active
      check(mutations === 0 && !Object.keys(settings.keys()).length && !settings.keyRetry(), `${kind}/${boundary}/CSRF: ended authority never dispatches a queued key mutation`)
    }
    finally { release.resolve(); settings.destroy(); globalThis.fetch = originalFetch }
  }
  console.info(`PASS credential Settings response boundaries (${checks} checks)`)

}
