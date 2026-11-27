import frameworkCors from '@stacksjs/defaults/app/Middleware/Cors.ts'
import { Middleware } from '@stacksjs/router'

export { applyCorsHeaders, buildPreflightResponse, getResolvedCorsConfig } from '@stacksjs/defaults/app/Middleware/Cors.ts'

export default new Middleware({
  name: frameworkCors.name,
  priority: frameworkCors.priority,
  handle(request) {
    // Widget routes and preflights use the project's current origin allowlist.
    // The global policy would answer OPTIONS early and rewrite response headers.
    if (new URL(request.url).pathname.startsWith('/api/widget/projects/')) return
    return frameworkCors.handle(request)
  },
})
