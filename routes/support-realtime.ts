import { route } from '@stacksjs/router'
import { realtimeAction, typingStreamAction } from '../app/Actions/Support/RealtimeAction'

if (process.env.SUPPORT_REALTIME_HTTP_ENABLED !== 'false') {
  for (const operation of ['snapshot', 'replay', 'stream'] as const) {
    route.post(`/support/projects/{project}/realtime/${operation}`, realtimeAction(false, operation)).parseBody(false)
    route.post(`/widget/projects/{project}/realtime/${operation}`, realtimeAction(true, operation)).parseBody(false)
  }
  route.post('/support/projects/{project}/conversations/{id}/typing/stream', typingStreamAction(false)).parseBody(false).rateLimit(120, 'minute')
  route.post('/widget/projects/{project}/conversations/{id}/typing/stream', typingStreamAction(true)).parseBody(false).skipCsrf().rateLimit(120, 'minute')
}
