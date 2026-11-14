/* eslint-disable */
/**
 * Stacks API client, generated from OpenAPI.
 * Do not edit; run buddy generate:openapi.
 * No imports or dependencies.
 */


export type ApiResult<T> =
  | { ok: true, status: number, data: T, headers: Headers }
  | { ok: false, status: number, error: unknown, headers: Headers }

export interface ClientConfig {
  baseUrl: string
  token?: string
  headers?: Record<string, string>
  fetch?: typeof fetch
}
export interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /** Select one of the operation's declared request media types. */
  contentType?: string
}
interface Parameter {
  name: string
  in: string
  required: boolean
  group?: string
  style?: string
  explode?: boolean
}
interface BodyDescription { required: boolean, content: string[] }

function parameterValue(input: Record<string, unknown>, parameter: Parameter): unknown {
  const fields = parameter.group ? input[parameter.group] : input
  if (parameter.in === 'header' && fields && typeof fields === 'object') {
    const entries = Object.entries(fields).filter(([key]) => key.toLowerCase() === parameter.name.toLowerCase())
    return entries.at(-1)?.[1]
  }
  return fields && typeof fields === 'object' && Object.hasOwn(fields, parameter.name)
    ? (fields as Record<string, unknown>)[parameter.name] : undefined
}
function scalar(value: unknown): string {
  if (typeof value === 'object' && value !== null) throw new TypeError('Nested parameter values require an explicit supported serialization')
  return String(value)
}
function queryParameter(url: URL, parameter: Parameter, value: unknown): void {
  const style = parameter.style ?? 'form'
  const explode = parameter.explode ?? style === 'form'
  if (style === 'deepObject') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('deepObject requires an object')
    for (const [key, item] of Object.entries(value)) url.searchParams.append(parameter.name + '[' + key + ']', scalar(item))
  }
  else if (Array.isArray(value)) {
    if (style === 'form' && explode) {
      for (const item of value) url.searchParams.append(parameter.name, scalar(item))
    }
    else url.searchParams.append(parameter.name, value.map(scalar).join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','))
  }
  else if (value && typeof value === 'object') {
    if (style !== 'form') throw new TypeError('Object queries require form or deepObject style')
    if (explode) for (const [key, item] of Object.entries(value)) url.searchParams.append(key, scalar(item))
    else url.searchParams.append(parameter.name, Object.entries(value).flatMap(([key, item]) => [key, scalar(item)]).join(','))
  }
  else url.searchParams.append(parameter.name, scalar(value))
}
function simpleParameter(value: unknown, explode: boolean, encode: (value: string) => string): string {
  if (Array.isArray(value)) return value.map(item => encode(scalar(item))).join(',')
  if (value && typeof value === 'object') return Object.entries(value).map(([key, item]) => encode(key) + (explode ? '=' : ',') + encode(scalar(item))).join(',')
  return encode(scalar(value))
}
function buildUrl(config: ClientConfig, route: string, input: Record<string, unknown>, parameters: Parameter[], headers: Headers): string {
  const path = new Map<string, string>()
  for (const parameter of parameters) {
    const value = parameterValue(input, parameter)
    if (value === undefined || value === null) {
      if (parameter.required) throw new TypeError('Missing required ' + parameter.in + ' parameter: ' + parameter.name)
      continue
    }
    if (parameter.in === 'path') {
      const segment = simpleParameter(value, parameter.explode ?? false, encodeURIComponent)
      if (segment === '.' || segment === '..') throw new TypeError('Dot-only path parameters are not allowed')
      path.set(parameter.name, segment)
    }
    else if (parameter.in === 'header') headers.set(parameter.name, simpleParameter(value, parameter.explode ?? false, value => value))
  }
  const filled = route.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    const value = path.get(key)
    if (value === undefined) throw new TypeError('Missing path parameter: ' + key)
    return value
  })
  const url = new URL(filled.replace(/^\/+/, '/'), config.baseUrl.endsWith('/') ? config.baseUrl : config.baseUrl + '/')
  for (const parameter of parameters) {
    const value = parameterValue(input, parameter)
    if (parameter.in === 'query' && value !== undefined && value !== null) queryParameter(url, parameter, value)
  }
  return url.toString()
}
function isJson(type: string): boolean { return type === 'application/json' || type.endsWith('+json') }
function mediaType(type: string): string { return type.split(';')[0]!.trim().toLowerCase() }
function requestBody(value: unknown, description: BodyDescription | null, headers: Headers, options?: RequestOptions): BodyInit | undefined {
  if (!description) return undefined
  if (value === undefined) {
    if (description.required) throw new TypeError('Missing required request body')
    return undefined
  }
  const declared = description.content
  const selected = options?.contentType ?? headers.get('content-type') ?? declared.find(isJson) ?? declared[0]
  if (!selected || !declared.some(type => mediaType(type) === mediaType(selected))) throw new TypeError('Request media type is not declared by this operation')
  const type = mediaType(selected)
  headers.set('content-type', selected)
  if (isJson(type)) return JSON.stringify(value)
  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    if (type === 'multipart/form-data' && value instanceof FormData) { headers.delete('content-type'); return value }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Form bodies require an object')
    if (type === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams()
      for (const [name, field] of Object.entries(value)) {
        for (const item of Array.isArray(field) ? field : [field]) if (item != null) form.append(name, scalar(item))
      }
      return form.toString()
    }
    const form = new FormData()
    for (const [name, field] of Object.entries(value)) {
      for (const item of Array.isArray(field) ? field : [field]) {
        if (item == null) continue
        form.append(name, item instanceof Blob ? item : typeof item === 'object' ? JSON.stringify(item) : String(item))
      }
    }
    headers.delete('content-type')
    return form
  }
  if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value as BodyInit
  if (typeof value === 'string') return value
  throw new TypeError('Non-JSON request bodies require text or binary data')
}
async function request<T>(config: ClientConfig, method: string, route: string, input: Record<string, unknown>, parameters: Parameter[], description: BodyDescription | null, accept: string, binary: string[], options?: RequestOptions): Promise<ApiResult<T>> {
  const headers = new Headers({ Accept: accept })
  for (const [name, value] of Object.entries(config.headers ?? {})) headers.set(name, value)
  if (config.token) headers.set('authorization', 'Bearer ' + config.token)
  for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value)
  const url = buildUrl(config, route, input, parameters, headers)
  const body = requestBody(input.body, description, headers, options)
  const response = await (config.fetch ?? fetch)(url, { method, headers, body, signal: options?.signal })
  const type = mediaType(response.headers.get('content-type') ?? '')
  let parsed: unknown
  if (method === 'HEAD' || response.status === 204 || response.status === 205) parsed = null
  else if (binary.includes(type)) parsed = await response.blob()
  else {
    const text = await response.text()
    // Keep malformed JSON available as evidence, without parsing other media as JSON.
    if (!text.length) parsed = type.startsWith('text/') ? '' : null
    else if (isJson(type)) { try { parsed = JSON.parse(text) } catch { parsed = text } }
    else parsed = text
  }
  return response.ok
    ? { ok: true, status: response.status, data: parsed as T, headers: response.headers }
    : { ok: false, status: response.status, error: parsed, headers: response.headers }
}

export interface components {
  schemas: {

  }
  requestSchemas: {

  }
}

export function createClient(config: ClientConfig) {
  return {
    config,
  /**
   * GET /.well-known/oauth-authorization-server
   */
  getWellKnownOauthAuthorizationServer(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/.well-known/oauth-authorization-server", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /_stacks/mail/preview
   */
  getStacksMailPreview(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /_stacks/mail/preview/{name}
   */
  getStacksMailPreviewName(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview/{name}", input ?? {}, [{"name":"name","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /_stacks/mail/preview/{name}/raw
   */
  getStacksMailPreviewNameRaw(input: { "name": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/_stacks/mail/preview/{name}/raw", input ?? {}, [{"name":"name","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/billing/stripe/webhook
   */
  postBillingStripeWebhook(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/billing/stripe/webhook", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/channels/media/{delivery}/{attachment}
   */
  getChannelsMediaDeliveryAttachment(input: { "delivery": string; "attachment": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/channels/media/{delivery}/{attachment}", input ?? {}, [{"name":"delivery","in":"path","required":true},{"name":"attachment","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/channels/{channel}/deliveries/{delivery}/status
   */
  postChannelsChannelDeliveriesDeliveryStatus(input: { "channel": string; "delivery": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/channels/{channel}/deliveries/{delivery}/status", input ?? {}, [{"name":"channel","in":"path","required":true},{"name":"delivery","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/channels/{channel}/incoming
   */
  getChannelsChannelIncoming(input: { "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/channels/{channel}/incoming", input ?? {}, [{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/channels/{channel}/incoming
   */
  postChannelsChannelIncoming(input: { "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/channels/{channel}/incoming", input ?? {}, [{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/cli/connect
   */
  postCliConnect(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/cli/connect", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/cli/connect/{code}
   */
  getCliConnectCode(input: { "code": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/cli/connect/{code}", input ?? {}, [{"name":"code","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/csrf-token
   */
  getCsrfToken(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/csrf-token", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/email/channels/{channel}/incoming
   */
  postEmailChannelsChannelIncoming(input: { "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/email/channels/{channel}/incoming", input ?? {}, [{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/enterprise/providers/{provider}/callback
   */
  getEnterpriseProvidersProviderCallback(input: { "provider": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/enterprise/providers/{provider}/callback", input ?? {}, [{"name":"provider","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/enterprise/providers/{provider}/link
   */
  postEnterpriseProvidersProviderLink(input: { "provider": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/enterprise/providers/{provider}/link", input ?? {}, [{"name":"provider","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/enterprise/providers/{provider}/login
   */
  getEnterpriseProvidersProviderLogin(input: { "provider": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/enterprise/providers/{provider}/login", input ?? {}, [{"name":"provider","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/enterprise/providers/{provider}/saml/acs
   */
  postEnterpriseProvidersProviderSamlAcs(input: { "provider": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/enterprise/providers/{provider}/saml/acs", input ?? {}, [{"name":"provider","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/enterprise/providers/{provider}/saml/link
   */
  postEnterpriseProvidersProviderSamlLink(input: { "provider": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/enterprise/providers/{provider}/saml/link", input ?? {}, [{"name":"provider","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/enterprise/providers/{provider}/saml/login
   */
  getEnterpriseProvidersProviderSamlLogin(input: { "provider": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/enterprise/providers/{provider}/saml/login", input ?? {}, [{"name":"provider","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/help/projects/{project}/articles
   */
  getHelpProjectsProjectArticles(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/help/projects/{project}/articles", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/help/projects/{project}/articles/{slug}
   */
  getHelpProjectsProjectArticlesSlug(input: { "project": string; "slug": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/help/projects/{project}/articles/{slug}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"slug","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/login
   */
  postLogin(input: { body: { "email": string; "password": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/login", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /api/logout
   */
  postLogout(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/logout", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/phone/calls/{call}/agent
   */
  postPhoneCallsCallAgent(input: { "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/phone/calls/{call}/agent", input ?? {}, [{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/phone/calls/{call}/consent
   */
  postPhoneCallsCallConsent(input: { "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/phone/calls/{call}/consent", input ?? {}, [{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/phone/calls/{call}/dial-complete
   */
  postPhoneCallsCallDialComplete(input: { "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/phone/calls/{call}/dial-complete", input ?? {}, [{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/phone/calls/{call}/instructions
   */
  postPhoneCallsCallInstructions(input: { "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/phone/calls/{call}/instructions", input ?? {}, [{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/phone/calls/{call}/status
   */
  postPhoneCallsCallStatus(input: { "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/phone/calls/{call}/status", input ?? {}, [{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/phone/calls/{call}/wait
   */
  postPhoneCallsCallWait(input: { "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/phone/calls/{call}/wait", input ?? {}, [{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/phone/channels/{channel}/incoming
   */
  postPhoneChannelsChannelIncoming(input: { "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/phone/channels/{channel}/incoming", input ?? {}, [{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/register
   */
  postRegister(input: { body: { "email": string; "password": string; "name": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/register", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /api/scim/v2/{workspace}/Groups
   */
  getScimV2WorkspaceGroups(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/scim/v2/{workspace}/Groups", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/scim/v2/{workspace}/Groups
   */
  postScimV2WorkspaceGroups(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/scim/v2/{workspace}/Groups", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/scim/v2/{workspace}/Groups/{id}
   */
  getScimV2WorkspaceGroupsId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/scim/v2/{workspace}/Groups/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PUT /api/scim/v2/{workspace}/Groups/{id}
   */
  putScimV2WorkspaceGroupsId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/scim/v2/{workspace}/Groups/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * DELETE /api/scim/v2/{workspace}/Groups/{id}
   */
  deleteScimV2WorkspaceGroupsId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/scim/v2/{workspace}/Groups/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PATCH /api/scim/v2/{workspace}/Groups/{id}
   */
  patchScimV2WorkspaceGroupsId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/scim/v2/{workspace}/Groups/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/scim/v2/{workspace}/ServiceProviderConfig
   */
  getScimV2WorkspaceServiceProviderConfig(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/scim/v2/{workspace}/ServiceProviderConfig", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/scim/v2/{workspace}/Users
   */
  getScimV2WorkspaceUsers(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/scim/v2/{workspace}/Users", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/scim/v2/{workspace}/Users
   */
  postScimV2WorkspaceUsers(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/scim/v2/{workspace}/Users", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/scim/v2/{workspace}/Users/{id}
   */
  getScimV2WorkspaceUsersId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/scim/v2/{workspace}/Users/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PUT /api/scim/v2/{workspace}/Users/{id}
   */
  putScimV2WorkspaceUsersId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/scim/v2/{workspace}/Users/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * DELETE /api/scim/v2/{workspace}/Users/{id}
   */
  deleteScimV2WorkspaceUsersId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/scim/v2/{workspace}/Users/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PATCH /api/scim/v2/{workspace}/Users/{id}
   */
  patchScimV2WorkspaceUsersId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/scim/v2/{workspace}/Users/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/connect/{code}
   */
  getSupportConnectCode(input: { "code": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/connect/{code}", input ?? {}, [{"name":"code","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/connect/{code}/approve
   */
  postSupportConnectCodeApprove(input: { "code": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/connect/{code}/approve", input ?? {}, [{"name":"code","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/invitations/{id}/accept
   */
  postSupportInvitationsIdAccept(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/invitations/{id}/accept", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/me
   */
  getSupportMe(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/me", {}, [], null, "application/json", [], options)
  },

  /**
   * PATCH /api/support/projects/{project}
   */
  patchSupportProjectsProject(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/support/projects/{project}", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/agents
   */
  getSupportProjectsProjectAgents(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/agents", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/ai/capabilities
   */
  getSupportProjectsProjectAiCapabilities(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/ai/capabilities", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/articles
   */
  getSupportProjectsProjectArticles(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/articles", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/articles
   */
  postSupportProjectsProjectArticles(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/articles", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PATCH /api/support/projects/{project}/articles/{id}
   */
  patchSupportProjectsProjectArticlesId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/support/projects/{project}/articles/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/attachments/{id}
   */
  getSupportProjectsProjectAttachmentsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/attachments/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * DELETE /api/support/projects/{project}/attachments/{id}
   */
  deleteSupportProjectsProjectAttachmentsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/support/projects/{project}/attachments/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/automation-runs
   */
  getSupportProjectsProjectAutomationRuns(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/automation-runs", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/automation-runs/{id}
   */
  getSupportProjectsProjectAutomationRunsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/automation-runs/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/automations
   */
  getSupportProjectsProjectAutomations(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/automations", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/automations
   */
  postSupportProjectsProjectAutomations(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/automations", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/automations/{id}/draft
   */
  postSupportProjectsProjectAutomationsIdDraft(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/automations/{id}/draft", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/automations/{id}/pause
   */
  postSupportProjectsProjectAutomationsIdPause(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/automations/{id}/pause", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/automations/{id}/publish
   */
  postSupportProjectsProjectAutomationsIdPublish(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/automations/{id}/publish", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/billing
   */
  getSupportProjectsProjectBilling(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/billing", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/channel-conversations/{conversation}/messages
   */
  postSupportProjectsProjectChannelConversationsConversationMessages(input: { "project": string; "conversation": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/channel-conversations/{conversation}/messages", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"conversation","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/channel-deliveries
   */
  getSupportProjectsProjectChannelDeliveries(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/channel-deliveries", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/channel-deliveries/{delivery}
   */
  getSupportProjectsProjectChannelDeliveriesDelivery(input: { "project": string; "delivery": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/channel-deliveries/{delivery}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"delivery","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/channel-deliveries/{delivery}/reconcile
   */
  postSupportProjectsProjectChannelDeliveriesDeliveryReconcile(input: { "project": string; "delivery": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/channel-deliveries/{delivery}/reconcile", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"delivery","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/channels
   */
  getSupportProjectsProjectChannels(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/channels", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/channels
   */
  postSupportProjectsProjectChannels(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/channels", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/channels/{channel}
   */
  postSupportProjectsProjectChannelsChannel(input: { "project": string; "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/channels/{channel}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/channels/{channel}/disable
   */
  postSupportProjectsProjectChannelsChannelDisable(input: { "project": string; "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/channels/{channel}/disable", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/channels/{channel}/poll
   */
  postSupportProjectsProjectChannelsChannelPoll(input: { "project": string; "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/channels/{channel}/poll", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/channels/{channel}/verify
   */
  postSupportProjectsProjectChannelsChannelVerify(input: { "project": string; "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/channels/{channel}/verify", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/conversations/{id}
   */
  getSupportProjectsProjectConversationsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/conversations/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PATCH /api/support/projects/{project}/conversations/{id}
   */
  patchSupportProjectsProjectConversationsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/support/projects/{project}/conversations/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/conversations/{id}/attachments
   */
  postSupportProjectsProjectConversationsIdAttachments(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/conversations/{id}/attachments", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/conversations/{id}/copilot
   */
  postSupportProjectsProjectConversationsIdCopilot(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/conversations/{id}/copilot", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/conversations/{id}/messages
   */
  postSupportProjectsProjectConversationsIdMessages(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/conversations/{id}/messages", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/conversations/{id}/read
   */
  postSupportProjectsProjectConversationsIdRead(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/conversations/{id}/read", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/email-receipts
   */
  getSupportProjectsProjectEmailReceipts(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/email-receipts", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/imports
   */
  getSupportProjectsProjectImports(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/imports", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/imports/intercom
   */
  postSupportProjectsProjectImportsIntercom(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/imports/intercom", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/imports/{id}
   */
  getSupportProjectsProjectImportsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/imports/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/imports/{id}/pause
   */
  postSupportProjectsProjectImportsIdPause(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/imports/{id}/pause", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/imports/{id}/resume
   */
  postSupportProjectsProjectImportsIdResume(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/imports/{id}/resume", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/inbox
   */
  getSupportProjectsProjectInbox(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/inbox", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/keys
   */
  postSupportProjectsProjectKeys(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/keys", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/knowledge
   */
  getSupportProjectsProjectKnowledge(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/knowledge", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/knowledge
   */
  postSupportProjectsProjectKnowledge(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/knowledge", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/knowledge/import
   */
  postSupportProjectsProjectKnowledgeImport(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/knowledge/import", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/knowledge/{id}
   */
  getSupportProjectsProjectKnowledgeId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/knowledge/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * DELETE /api/support/projects/{project}/knowledge/{id}
   */
  deleteSupportProjectsProjectKnowledgeId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/support/projects/{project}/knowledge/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PATCH /api/support/projects/{project}/knowledge/{id}
   */
  patchSupportProjectsProjectKnowledgeId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/support/projects/{project}/knowledge/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/knowledge/{id}/index
   */
  getSupportProjectsProjectKnowledgeIdIndex(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/knowledge/{id}/index", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/knowledge/{id}/index
   */
  postSupportProjectsProjectKnowledgeIdIndex(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/knowledge/{id}/index", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PATCH /api/support/projects/{project}/knowledge/{id}/permissions
   */
  patchSupportProjectsProjectKnowledgeIdPermissions(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/support/projects/{project}/knowledge/{id}/permissions", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/knowledge/{id}/revisions
   */
  getSupportProjectsProjectKnowledgeIdRevisions(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/knowledge/{id}/revisions", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/phone/calls
   */
  getSupportProjectsProjectPhoneCalls(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/phone/calls", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/phone/calls
   */
  postSupportProjectsProjectPhoneCalls(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/phone/calls", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/phone/calls/{call}
   */
  getSupportProjectsProjectPhoneCallsCall(input: { "project": string; "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/phone/calls/{call}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/phone/calls/{call}/end
   */
  postSupportProjectsProjectPhoneCallsCallEnd(input: { "project": string; "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/phone/calls/{call}/end", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/phone/calls/{call}/reconcile
   */
  postSupportProjectsProjectPhoneCallsCallReconcile(input: { "project": string; "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/phone/calls/{call}/reconcile", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/phone/calls/{call}/takeover
   */
  postSupportProjectsProjectPhoneCallsCallTakeover(input: { "project": string; "call": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/phone/calls/{call}/takeover", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"call","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/phone/capabilities
   */
  getSupportProjectsProjectPhoneCapabilities(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/phone/capabilities", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/phone/channels/{channel}/verify
   */
  postSupportProjectsProjectPhoneChannelsChannelVerify(input: { "project": string; "channel": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/phone/channels/{channel}/verify", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"channel","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/phone/token
   */
  postSupportProjectsProjectPhoneToken(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/phone/token", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/reports
   */
  getSupportProjectsProjectReports(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/reports", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/ticket-calendars
   */
  postSupportProjectsProjectTicketCalendars(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/ticket-calendars", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/ticket-configuration
   */
  getSupportProjectsProjectTicketConfiguration(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/ticket-configuration", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/ticket-sla-policies
   */
  postSupportProjectsProjectTicketSlaPolicies(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/ticket-sla-policies", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/ticket-types
   */
  postSupportProjectsProjectTicketTypes(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/ticket-types", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/tickets
   */
  getSupportProjectsProjectTickets(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/tickets", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/tickets
   */
  postSupportProjectsProjectTickets(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/tickets", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PATCH /api/support/projects/{project}/tickets/{id}
   */
  patchSupportProjectsProjectTicketsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/api/support/projects/{project}/tickets/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/tickets/{id}/relations
   */
  getSupportProjectsProjectTicketsIdRelations(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/tickets/{id}/relations", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/tickets/{id}/relations
   */
  postSupportProjectsProjectTicketsIdRelations(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/tickets/{id}/relations", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/verification
   */
  getSupportProjectsProjectVerification(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/verification", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/verification/challenges
   */
  postSupportProjectsProjectVerificationChallenges(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/verification/challenges", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/verification/challenges/{id}/confirm
   */
  postSupportProjectsProjectVerificationChallengesIdConfirm(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/verification/challenges/{id}/confirm", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/projects/{project}/workflows
   */
  getSupportProjectsProjectWorkflows(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/projects/{project}/workflows", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/projects/{project}/workflows
   */
  postSupportProjectsProjectWorkflows(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/projects/{project}/workflows", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces
   */
  postSupportWorkspaces(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /api/support/workspaces/{workspace}/enterprise
   */
  getSupportWorkspacesWorkspaceEnterprise(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/workspaces/{workspace}/enterprise", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/workspaces/{workspace}/enterprise/audit
   */
  getSupportWorkspacesWorkspaceEnterpriseAudit(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/workspaces/{workspace}/enterprise/audit", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/enterprise/provider
   */
  postSupportWorkspacesWorkspaceEnterpriseProvider(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/enterprise/provider", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/workspaces/{workspace}/enterprise/retention
   */
  getSupportWorkspacesWorkspaceEnterpriseRetention(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/workspaces/{workspace}/enterprise/retention", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PUT /api/support/workspaces/{workspace}/enterprise/retention
   */
  putSupportWorkspacesWorkspaceEnterpriseRetention(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/support/workspaces/{workspace}/enterprise/retention", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * PUT /api/support/workspaces/{workspace}/enterprise/retention/holds/{id}
   */
  putSupportWorkspacesWorkspaceEnterpriseRetentionHoldsId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PUT", "/api/support/workspaces/{workspace}/enterprise/retention/holds/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/workspaces/{workspace}/enterprise/retention/preview
   */
  getSupportWorkspacesWorkspaceEnterpriseRetentionPreview(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/workspaces/{workspace}/enterprise/retention/preview", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/enterprise/retention/run
   */
  postSupportWorkspacesWorkspaceEnterpriseRetentionRun(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/enterprise/retention/run", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/enterprise/scim-tokens
   */
  postSupportWorkspacesWorkspaceEnterpriseScimTokens(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/enterprise/scim-tokens", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * DELETE /api/support/workspaces/{workspace}/enterprise/scim-tokens/{id}
   */
  deleteSupportWorkspacesWorkspaceEnterpriseScimTokensId(input: { "workspace": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/api/support/workspaces/{workspace}/enterprise/scim-tokens/{id}", input ?? {}, [{"name":"workspace","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/invitations
   */
  postSupportWorkspacesWorkspaceInvitations(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/invitations", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/projects
   */
  postSupportWorkspacesWorkspaceProjects(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/projects", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/workspaces/{workspace}/subscription
   */
  getSupportWorkspacesWorkspaceSubscription(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/workspaces/{workspace}/subscription", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/subscription/checkout
   */
  postSupportWorkspacesWorkspaceSubscriptionCheckout(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/subscription/checkout", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/subscription/portal
   */
  postSupportWorkspacesWorkspaceSubscriptionPortal(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/subscription/portal", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/support/workspaces/{workspace}/wallet
   */
  getSupportWorkspacesWorkspaceWallet(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/support/workspaces/{workspace}/wallet", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/wallet/checkout
   */
  postSupportWorkspacesWorkspaceWalletCheckout(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/wallet/checkout", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/support/workspaces/{workspace}/wallet/limits
   */
  postSupportWorkspacesWorkspaceWalletLimits(input: { "workspace": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/support/workspaces/{workspace}/wallet/limits", input ?? {}, [{"name":"workspace","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/v1/projects/{project}/conversations
   */
  getV1ProjectsProjectConversations(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/v1/projects/{project}/conversations", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/conversations
   */
  postV1ProjectsProjectConversations(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/conversations", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/conversations/{id}/messages
   */
  postV1ProjectsProjectConversationsIdMessages(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/conversations/{id}/messages", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/events
   */
  postV1ProjectsProjectEvents(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/events", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/imports/intercom
   */
  postV1ProjectsProjectImportsIntercom(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/imports/intercom", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/v1/projects/{project}/imports/{id}
   */
  getV1ProjectsProjectImportsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/v1/projects/{project}/imports/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/imports/{id}/resume
   */
  postV1ProjectsProjectImportsIdResume(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/imports/{id}/resume", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/v1/projects/{project}/installation
   */
  getV1ProjectsProjectInstallation(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/v1/projects/{project}/installation", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/installation
   */
  postV1ProjectsProjectInstallation(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/installation", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/knowledge/sync
   */
  postV1ProjectsProjectKnowledgeSync(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/knowledge/sync", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/sessions
   */
  postV1ProjectsProjectSessions(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/sessions", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/v1/projects/{project}/verification
   */
  getV1ProjectsProjectVerification(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/v1/projects/{project}/verification", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/verification/challenges
   */
  postV1ProjectsProjectVerificationChallenges(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/verification/challenges", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/v1/projects/{project}/verification/challenges/{id}/confirm
   */
  postV1ProjectsProjectVerificationChallengesIdConfirm(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/v1/projects/{project}/verification/challenges/{id}/confirm", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/v1/usage
   */
  getV1Usage(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/v1/usage", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /api/verify-two-factor-login
   */
  postVerifyTwoFactorLogin(input: { body: { "challenge_token": string; "code": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/verify-two-factor-login", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * OPTIONS /api/widget/projects/{project}/*
   */
  optionsWidgetProjectsProject(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "OPTIONS", "/api/widget/projects/{project}/*", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/widget/projects/{project}/articles
   */
  getWidgetProjectsProjectArticles(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/widget/projects/{project}/articles", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/widget/projects/{project}/attachments/{id}
   */
  getWidgetProjectsProjectAttachmentsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/widget/projects/{project}/attachments/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/widget/projects/{project}/conversations
   */
  getWidgetProjectsProjectConversations(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/widget/projects/{project}/conversations", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/widget/projects/{project}/conversations
   */
  postWidgetProjectsProjectConversations(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/widget/projects/{project}/conversations", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/widget/projects/{project}/conversations/{id}
   */
  getWidgetProjectsProjectConversationsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/widget/projects/{project}/conversations/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/widget/projects/{project}/conversations/{id}/ai
   */
  postWidgetProjectsProjectConversationsIdAi(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/widget/projects/{project}/conversations/{id}/ai", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/widget/projects/{project}/conversations/{id}/attachments
   */
  postWidgetProjectsProjectConversationsIdAttachments(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/widget/projects/{project}/conversations/{id}/attachments", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/widget/projects/{project}/conversations/{id}/messages
   */
  postWidgetProjectsProjectConversationsIdMessages(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/widget/projects/{project}/conversations/{id}/messages", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/widget/projects/{project}/events
   */
  postWidgetProjectsProjectEvents(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/widget/projects/{project}/events", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/widget/projects/{project}/knowledge
   */
  getWidgetProjectsProjectKnowledge(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/widget/projects/{project}/knowledge", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/widget/projects/{project}/session
   */
  postWidgetProjectsProjectSession(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/widget/projects/{project}/session", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/widget/projects/{project}/ticket-types
   */
  getWidgetProjectsProjectTicketTypes(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/widget/projects/{project}/ticket-types", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /api/widget/projects/{project}/tickets
   */
  postWidgetProjectsProjectTickets(input: { "project": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/api/widget/projects/{project}/tickets", input ?? {}, [{"name":"project","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /api/widget/projects/{project}/tickets/{id}
   */
  getWidgetProjectsProjectTicketsId(input: { "project": string; "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/api/widget/projects/{project}/tickets/{id}", input ?? {}, [{"name":"project","in":"path","required":true},{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /auth/abilities
   */
  getAuthAbilities(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/auth/abilities", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/magic-link
   */
  postAuthMagicLink(input: { body: { "email": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/magic-link", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /auth/magic-link/consume
   */
  postAuthMagicLinkConsume(input: { body: { "token": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/magic-link/consume", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /auth/oauth/clients
   */
  getAuthOauthClients(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/auth/oauth/clients", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/oauth/clients
   */
  postAuthOauthClients(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/oauth/clients", {}, [], null, "application/json", [], options)
  },

  /**
   * PATCH /auth/oauth/clients/{id}
   */
  patchAuthOauthClientsId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "PATCH", "/auth/oauth/clients/{id}", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /auth/oauth/clients/{id}/disable
   */
  postAuthOauthClientsIdDisable(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/oauth/clients/{id}/disable", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /auth/oauth/clients/{id}/rotate-secret
   */
  postAuthOauthClientsIdRotateSecret(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/oauth/clients/{id}/rotate-secret", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /auth/oauth/connections
   */
  getAuthOauthConnections(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/auth/oauth/connections", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/oauth/connections/{id}/disconnect
   */
  postAuthOauthConnectionsIdDisconnect(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/oauth/connections/{id}/disconnect", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * GET /auth/passkeys
   */
  getAuthPasskeys(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/auth/passkeys", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/passkeys/authentication
   */
  postAuthPasskeysAuthentication(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/passkeys/authentication", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/passkeys/authentication/options
   */
  postAuthPasskeysAuthenticationOptions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/passkeys/authentication/options", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/passkeys/registration
   */
  postAuthPasskeysRegistration(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/passkeys/registration", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/passkeys/registration/options
   */
  postAuthPasskeysRegistrationOptions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/passkeys/registration/options", {}, [], null, "application/json", [], options)
  },

  /**
   * DELETE /auth/passkeys/{id}
   */
  deleteAuthPasskeysId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/auth/passkeys/{id}", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /auth/refresh
   */
  postAuthRefresh(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/refresh", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /auth/token
   */
  postAuthToken(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/auth/token", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /auth/tokens
   */
  getAuthTokens(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/auth/tokens", {}, [], null, "application/json", [], options)
  },

  /**
   * DELETE /auth/tokens/{id}
   */
  deleteAuthTokensId(input: { "id": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "DELETE", "/auth/tokens/{id}", input ?? {}, [{"name":"id","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /disable-two-factor
   */
  postDisableTwoFactor(input: { body: { "password": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/disable-two-factor", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /enable-two-factor
   */
  postEnableTwoFactor(input: { body: { "code": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/enable-two-factor", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /generate-authentication-options
   */
  getGenerateAuthenticationOptions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/generate-authentication-options", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /generate-registration-options
   */
  getGenerateRegistrationOptions(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/generate-registration-options", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /generate-two-factor-secret
   */
  postGenerateTwoFactorSecret(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/generate-two-factor-secret", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /locale/{locale}
   */
  getLocaleLocale(input: { "locale": string }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/locale/{locale}", input ?? {}, [{"name":"locale","in":"path","required":true}], null, "application/json", [], options)
  },

  /**
   * POST /login
   */
  postLogin2(input: { body: { "email": string; "password": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/login", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /logout
   */
  postLogout2(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/logout", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /logout-all
   */
  postLogoutAll(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/logout-all", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /me
   */
  getMe(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/me", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /me/data-export
   */
  getMeDataExport(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/me/data-export", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /oauth/authorize
   */
  getOauthAuthorize(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/oauth/authorize", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /oauth/authorize
   */
  postOauthAuthorize(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/oauth/authorize", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /oauth/introspect
   */
  postOauthIntrospect(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/oauth/introspect", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /oauth/revoke
   */
  postOauthRevoke(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/oauth/revoke", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /oauth/token
   */
  postOauthToken(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/oauth/token", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /password/forgot
   */
  postPasswordForgot(input: { body: { "email": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/password/forgot", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /password/reset
   */
  postPasswordReset(input: { body: { "email": string; "token": string; "password": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/password/reset", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * POST /password/verify-token
   */
  postPasswordVerifyToken(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/password/verify-token", {}, [], null, "application/json", [], options)
  },

  /**
   * GET /referrals
   */
  getReferrals(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/referrals", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /referrals/code
   */
  postReferralsCode(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/referrals/code", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /register
   */
  postRegister2(input: { body: { "email": string; "password": string; "name": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/register", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },

  /**
   * GET /robots.txt
   */
  getRobotsTxt(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "GET", "/robots.txt", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /verify-authentication
   */
  postVerifyAuthentication(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/verify-authentication", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /verify-registration
   */
  postVerifyRegistration(options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/verify-registration", {}, [], null, "application/json", [], options)
  },

  /**
   * POST /verify-two-factor-login
   */
  postVerifyTwoFactorLogin2(input: { body: { "challenge_token": string; "code": string } }, options?: RequestOptions): Promise<ApiResult<Record<string, unknown>>> {
    return request(config, "POST", "/verify-two-factor-login", input ?? {}, [], {"required":true,"content":["application/json"]}, "application/json", [], options)
  },
  }
}
export type Client = ReturnType<typeof createClient>
