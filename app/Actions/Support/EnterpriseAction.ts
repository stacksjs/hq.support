import type { EnterpriseOperation } from '../../../enterprise/http'
import { enterpriseHttp } from '../../../enterprise/http'

export function enterpriseAction(operation: EnterpriseOperation, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', transport?: typeof fetch) {
  return new Action({ name: `Support enterprise ${operation}`, method, handle: request => enterpriseHttp(request, operation, transport) })
}
