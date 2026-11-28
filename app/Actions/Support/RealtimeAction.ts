import { Action } from '@stacksjs/actions/runtime'
import { handleTypingStream, handleRealtime } from '../../Support/realtime-http'
import type { RealtimeOperation } from '../../Support/realtime-http'

export function realtimeAction(widget: boolean, operation: RealtimeOperation) {
  return new Action({ name: `Support realtime ${widget ? 'customer' : 'agent'} ${operation}`, method: 'POST', apiResponse: false, handle: request => handleRealtime(request, widget, operation) })
}

export function typingStreamAction(widget: boolean) {
  return new Action({ name: `Support ${widget ? 'agent' : 'customer'} typing stream`, method: 'POST', apiResponse: false, handle: request => handleTypingStream(request, widget) })
}
