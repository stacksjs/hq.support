import { route } from '@stacksjs/router'
import DocumentationAction from '../app/Actions/Support/DocumentationAction'
route.post('/v1/projects/{project}/knowledge/sync', DocumentationAction).skipCsrf().rateLimit(30, 'minute')
