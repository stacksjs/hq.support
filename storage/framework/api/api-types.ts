/** Generated from OpenAPI. Do not edit; run buddy generate:openapi. */

export interface paths {
  "/.well-known/oauth-authorization-server": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/_stacks/mail/preview": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/_stacks/mail/preview/{name}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "name": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/_stacks/mail/preview/{name}/raw": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "name": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/billing/stripe/webhook": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/channels/media/{delivery}/{attachment}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "delivery": string; "attachment": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/channels/{channel}/deliveries/{delivery}/status": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "channel": string; "delivery": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/channels/{channel}/incoming": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/cli/connect": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/cli/connect/{code}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "code": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/csrf-token": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/email/channels/{channel}/incoming": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/enterprise/providers/{provider}/callback": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "provider": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/enterprise/providers/{provider}/link": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "provider": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/enterprise/providers/{provider}/login": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "provider": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/enterprise/providers/{provider}/saml/acs": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "provider": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/enterprise/providers/{provider}/saml/link": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "provider": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/enterprise/providers/{provider}/saml/login": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "provider": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/help/projects/{project}/articles": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/help/projects/{project}/articles/{slug}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "slug": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/login": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "email": string; "password": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/logout": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/phone/calls/{call}/agent": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/phone/calls/{call}/consent": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/phone/calls/{call}/dial-complete": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/phone/calls/{call}/instructions": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/phone/calls/{call}/status": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/phone/calls/{call}/wait": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/phone/channels/{channel}/incoming": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/register": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "email": string; "password": string; "name": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/scim/v2/{workspace}/Groups": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/scim/v2/{workspace}/Groups/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    post?: never
    delete: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/scim/v2/{workspace}/ServiceProviderConfig": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/scim/v2/{workspace}/Users": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/scim/v2/{workspace}/Users/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    post?: never
    delete: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/support/connect/{code}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "code": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/connect/{code}/approve": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "code": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/invitations/{id}/accept": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/me": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}": {
    get?: never
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/support/projects/{project}/agents": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/ai/capabilities": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/articles": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/articles/{id}": {
    get?: never
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/support/projects/{project}/attachments/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/automation-runs": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/automation-runs/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/automations": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/automations/{id}/draft": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/automations/{id}/pause": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/automations/{id}/publish": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/billing": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channel-conversations/{conversation}/messages": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "conversation": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channel-deliveries": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channel-deliveries/{delivery}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "delivery": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channel-deliveries/{delivery}/reconcile": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "delivery": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channels": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channels/{channel}": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channels/{channel}/disable": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channels/{channel}/poll": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/channels/{channel}/verify": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/conversations/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/support/projects/{project}/conversations/{id}/attachments": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/conversations/{id}/copilot": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/conversations/{id}/messages": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/conversations/{id}/read": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/email-receipts": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/imports": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/imports/intercom": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/imports/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/imports/{id}/pause": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/imports/{id}/resume": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/inbox": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/keys": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/knowledge": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/knowledge/import": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/knowledge/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/support/projects/{project}/knowledge/{id}/index": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/knowledge/{id}/permissions": {
    get?: never
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/support/projects/{project}/knowledge/{id}/revisions": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/calls": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/calls/{call}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/calls/{call}/end": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/calls/{call}/reconcile": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/calls/{call}/takeover": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "call": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/capabilities": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/channels/{channel}/verify": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "channel": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/phone/token": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/reports": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/ticket-calendars": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/ticket-configuration": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/ticket-sla-policies": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/ticket-types": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/tickets": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/tickets/{id}": {
    get?: never
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/api/support/projects/{project}/tickets/{id}/relations": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/verification": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/verification/challenges": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/verification/challenges/{id}/confirm": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/projects/{project}/workflows": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/audit": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/provider": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/retention": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/retention/holds/{id}": {
    get?: never
    put: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/retention/preview": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/retention/run": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/scim-tokens": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/enterprise/scim-tokens/{id}": {
    get?: never
    put?: never
    post?: never
    delete: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/invitations": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/projects": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/subscription": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/subscription/checkout": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/subscription/portal": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/wallet": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/wallet/checkout": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/support/workspaces/{workspace}/wallet/limits": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "workspace": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/conversations": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/conversations/{id}/messages": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/events": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/imports/intercom": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/imports/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/imports/{id}/resume": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/installation": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/knowledge/sync": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/sessions": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/verification": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/verification/challenges": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/projects/{project}/verification/challenges/{id}/confirm": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/v1/usage": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/verify-two-factor-login": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "challenge_token": string; "code": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/*": {
    get?: never
    put?: never
    post?: never
    delete?: never
    options: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/articles": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/attachments/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/conversations": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/conversations/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/conversations/{id}/ai": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/conversations/{id}/attachments": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/conversations/{id}/messages": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/events": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/knowledge": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/session": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/ticket-types": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/tickets": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/api/widget/projects/{project}/tickets/{id}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "project": string; "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/abilities": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/magic-link": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "email": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/magic-link/consume": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "token": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/oauth/clients": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/oauth/clients/{id}": {
    get?: never
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch: {
    parameters: {
      query?: never
      header?: never
      path: { "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    trace?: never
  }
  "/auth/oauth/clients/{id}/disable": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/oauth/clients/{id}/rotate-secret": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/oauth/connections": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/oauth/connections/{id}/disconnect": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path: { "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/passkeys": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/passkeys/authentication": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/passkeys/authentication/options": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/passkeys/registration": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/passkeys/registration/options": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/passkeys/{id}": {
    get?: never
    put?: never
    post?: never
    delete: {
    parameters: {
      query?: never
      header?: never
      path: { "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/refresh": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/token": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/tokens": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/auth/tokens/{id}": {
    get?: never
    put?: never
    post?: never
    delete: {
    parameters: {
      query?: never
      header?: never
      path: { "id": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/disable-two-factor": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "password": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/enable-two-factor": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "code": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/generate-authentication-options": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/generate-registration-options": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/generate-two-factor-secret": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/locale/{locale}": {
    get: {
    parameters: {
      query?: never
      header?: never
      path: { "locale": string }
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/login": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "email": string; "password": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/logout": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/logout-all": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/me": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/me/data-export": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/oauth/authorize": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/oauth/introspect": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/oauth/revoke": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/oauth/token": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/password/forgot": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "email": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/password/reset": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "email": string; "token": string; "password": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/password/verify-token": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/referrals": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/referrals/code": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/register": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "email": string; "password": string; "name": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/robots.txt": {
    get: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    put?: never
    post?: never
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/verify-authentication": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/verify-registration": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody?: never
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
  "/verify-two-factor-login": {
    get?: never
    put?: never
    post: {
    parameters: {
      query?: never
      header?: never
      path?: never
      cookie?: never
    }
    requestBody: { content: { "application/json": { "challenge_token": string; "code": string } } }
    responses: {
      "200": { content: { "application/json": Record<string, unknown> } }
      "422": { content: never }
      "500": { content: never }
    }
  }
    delete?: never
    options?: never
    head?: never
    patch?: never
    trace?: never
  }
}

export interface components {
  schemas: {

  }
  requestSchemas: {

  }
}
