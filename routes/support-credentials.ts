import { credentialAction } from '../app/Actions/Support/CredentialAction'
route.get('/support/projects/{project}/keys', credentialAction('list', 'GET')).middleware('auth').rateLimit(60, 'minute')
route.post('/support/projects/{project}/keys/{key}/revoke', credentialAction('revoke', 'POST')).middleware('auth').rateLimit(30, 'minute')
route.post('/support/projects/{project}/keys/{key}/rotate', credentialAction('rotate', 'POST')).middleware('auth').rateLimit(10, 'hour')
route.post('/support/projects/{project}/customers/{contact}/sessions/revoke', credentialAction('sessions.revoke', 'POST')).middleware('auth').rateLimit(30, 'minute')
