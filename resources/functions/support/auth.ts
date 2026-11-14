import { state } from '@stacksjs/stx'

export function createSupportAuth(mode: 'login' | 'register', done: () => void) {
  const email = state('')
  const password = state('')
  const name = state('')
  const remember = state(false)
  const code = state('')
  const step = state('credentials')
  const pending = state(false)
  const error = state('')
  let challenge = ''
  let csrf = ''

  async function post(path: string, body: Record<string, unknown>) {
    if (!csrf) {
      const response = await fetch('/api/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
      const result = await response.json()
      if (!response.ok || !result.token) throw new Error('Could not start a secure session. Refresh and try again.')
      csrf = result.token
    }
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const validation = data.errors && Object.values(data.errors).flat().join(' ')
      throw new Error(data.message || validation || 'Sign in could not be completed. Please try again.')
    }
    return data
  }

  async function submit() {
    if (pending()) return
    pending.set(true)
    error.set('')
    try {
      const secondFactor = step() === 'twofactor'
      const data = await post(secondFactor ? '/api/verify-two-factor-login' : `/api/${mode}`, secondFactor ? { challenge_token: challenge, code: code() } : { email: email().trim(), password: password(), ...(mode === 'register' ? { name: name().trim(), password_confirmation: password() } : {}), remember: remember() })
      password.set('')
      code.set('')
      if (data.requires_two_factor && data.challenge_token) {
        challenge = data.challenge_token
        step.set('twofactor')
        return
      }
      // Native Auth Actions set an HttpOnly session cookie. Keep tokens out of browser storage.
      if (!data.user || !(data.access_token || data.token)) throw new Error('The session could not be established. Please sign in again.')
      challenge = ''
      done()
    }
    catch (failure) {
      error.set(failure instanceof Error ? failure.message : 'The server could not be reached. Please retry.')
      if (step() === 'twofactor') {
        challenge = ''
        step.set('credentials')
        password.set('')
        code.set('')
      }
    }
    finally { pending.set(false) }
  }
  function restart() { challenge = ''; code.set(''); step.set('credentials'); error.set('') }
  return { email, password, name, remember, code, step, pending, error, submit, restart }
}
