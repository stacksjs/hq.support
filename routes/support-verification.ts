import { route } from '@stacksjs/router'
import { verificationActions as actions } from '../app/Actions/Support/VerificationAction'

route.get('/support/projects/{project}/verification', actions.status).middleware('auth')
route.post('/support/projects/{project}/verification/challenges', actions.start).middleware('auth').rateLimit(10, 'minute')
route.post('/support/projects/{project}/verification/challenges/{id}/confirm', actions.confirm).middleware('auth').rateLimit(10, 'minute')
route.get('/v1/projects/{project}/verification', actions.integrationStatus).rateLimit(60, 'minute')
route.post('/v1/projects/{project}/verification/challenges', actions.integrationStart).skipCsrf().rateLimit(10, 'minute')
route.post('/v1/projects/{project}/verification/challenges/{id}/confirm', actions.integrationConfirm).skipCsrf().rateLimit(10, 'minute')
