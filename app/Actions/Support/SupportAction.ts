import { Action } from '@stacksjs/actions/runtime'
import type { Operation } from '../../Support/http'
import { handle } from '../../Support/http'

export function supportAction(operation: Operation, method: 'GET' | 'POST' | 'PATCH') {
  return new Action({ name: `Support ${operation}`, method, apiResponse: false, handle: request => handle(request, operation) })
}
