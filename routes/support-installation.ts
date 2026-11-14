import { route } from '@stacksjs/router'
import { installationAction } from '../app/Actions/Support/InstallationAction'
route.get('/v1/projects/{project}/installation', installationAction(false)).rateLimit(60, 'minute')
route.post('/v1/projects/{project}/installation', installationAction(true)).skipCsrf().rateLimit(20, 'hour')
