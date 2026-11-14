# Backend API

All tenant APIs use project public UUIDs. Agent APIs under `/api/support` require native Stacks authentication and active workspace membership. Cookie-authenticated unsafe methods require the native `X-CSRF-Token` double-submit cookie/header. `GET /api/csrf-token` returns `{token}` and sets that cookie; native login/register/logout actions are also mounted under `/api` for the reverse proxy.

- `GET /api/support/me`: native user, active workspaces and their projects.
- `POST /api/support/workspaces {name}`: starts a 14-day trial and owner membership.
- `POST /api/support/workspaces/{workspace}/projects {name}`: owner/admin creates a project within allowance.
- `POST /api/support/workspaces/{workspace}/invitations {email,role?}`: owner/admin reserves an agent seat. Pending invitations count. Acceptance requires the matching signed-in email.
- `POST /api/support/projects/{project}/keys`: owner/admin issues write/read keys once; only hashes persist.
- `PATCH /api/support/projects/{project} {allowedOrigins,anonymousEnabled}`: explicit HTTPS origins, with localhost allowed for development.
- `GET /api/support/projects/{project}/inbox`: bounded summaries and opaque numeric cursor.
- `GET/PATCH /api/support/projects/{project}/conversations/{id}`: detail or status/assignment update.
- `POST /api/support/projects/{project}/conversations/{id}/messages {body,visibility,idempotencyKey}`: public message or internal note.

Server SDK routes under `/api/v1/projects/{project}` require `Authorization: Bearer <write key>` for sessions/events/writes. Conversation summaries accept the project read key or write key. Keys never belong in browser code.

- `POST /sessions {externalId,email?,name?,company?,attributes?}` returns `{token,expiresAt,contact}`. Derive identity from server auth.
- `POST /events {externalId,event,attributes?,idempotencyKey}` returns `{id,accepted:true}` once persisted.
- `POST /conversations {externalId,subject,body,idempotencyKey}` returns `{conversation}`.
- `GET /conversations?cursor=...` returns `{conversations,nextCursor}`; summaries contain `id,subject,status,customer_id,updated_at,unread_count`, no message bodies or contact email.
- `POST /conversations/{id}/messages {body,visibility,idempotencyKey}` returns `{message}`.

Customer routes under `/api/widget/projects/{project}` require the exact project allowed Origin. `POST /session {token?}` redeems a server session, or creates an anonymous identity only if project settings allow it. All other customer routes require that returned token as a bearer. A token only accesses its own contact rows and public messages. Use `/conversations`, `/conversations/{id}`, `/conversations/{id}/messages`, `/events`, `/articles?q=...`, `/tickets`, `/tickets/{id}`. Article search serves only published public articles. Customer ticket creation requires `{title,description?,conversationId?,idempotencyKey}`.

Every mutation requiring idempotency persists the request fingerprint and response in the same transaction as records, exact usage and outbox. Retrying the same key/input returns its original answer even after the quota is reached. Reusing a key with different input returns 409. A refused new conversation returns 402 and stores no phantom conversation. Provider inbound needs a separately qualified persisted overflow path before provider enablement.

HQ contract: `POST /api/cli/connect {app}`, `GET /api/cli/connect/{code}`, `GET /api/v1/usage` with the read key. Approval uses native authenticated `POST /api/support/connect/{code}/approve {confirmCode}`. The code printed by Buddy must be typed by the person; do not render its expected value on the approval page. Grants are sealed by native `@stacksjs/hq/service` and polled once.

Private attachments use native Stacks Storage. Agent upload: `POST /api/support/projects/{project}/conversations/{id}/attachments` with multipart `file` and `idempotencyKey`. Customer upload uses the corresponding `/api/widget` prefix and customer token/allowed origin. The response is `{attachment:{id,conversationId,fileName,mimeType,bytes,status}}`. Downloads at `/attachments/{id}` require the same tenant/customer authorization and always use attachment disposition. Agent `DELETE /api/support/projects/{project}/attachments/{id}` releases quota only after storage deletion succeeds. Actual bytes are reserved before writing, including recoverable uncertain uploads. A retry with the same content/key resumes without charging twice. Cross-contact downloads are 404.

`app/Support/delivery.ts` supplies durable outbox leases, provider receipts, exponential retry and retained inbound replay. Delivery adapters must pass the event ID to provider idempotency. Missing provider configuration leaves work pending and explicitly reports `unconfigured`; it never fabricates delivery. Inbound payloads persist before allowance decisions, and a failed handler leaves them recoverable. These primitives require a configured authenticated provider adapter and a running worker before a channel is enabled.

Agent read state is separate from a customer's message count: `POST /api/support/projects/{project}/conversations/{id}/read {lastMessageId}` persists a monotonic cursor for the authenticated human. The cursor must name a message in that project and conversation. The agent inbox then counts public customer messages after that human's cursor; reading a thread does not clear another agent's unread state.

Workflow automation and worker operation are documented in `docs/workflows.md`. Workspace invitations require a matching native account with verified email before acceptance; knowing an invitation ID is insufficient.
