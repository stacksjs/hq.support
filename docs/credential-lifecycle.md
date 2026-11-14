# Project keys and customer sessions

Workspace owners and admins manage project API keys from Settings or the
routes below. A native signed-in account is required; project read/write keys,
agents and other workspaces cannot administer keys. IDs in request paths are
always checked against both the project and its workspace. Mutations recheck
active owner/admin membership inside the existing workspace transaction.

All credential responses use `Cache-Control: no-store`. Cookie-authenticated
mutations require native CSRF protection; server bearer authentication uses the
native CSRF exemption. Native route rate limits use the framework request identity (the
configured shared cache provides a shared budget across workers). In the pinned
release, route limits can run before auth and use the client address; they are
not a separate per-account authorization check.

| Method and `/api` path | Behavior | Base limit |
| --- | --- | --- |
| `GET /support/projects/{project}/keys?cursor={id}` | Newest-first metadata, 200 rows, `nextCursor` for older keys | 60/minute |
| `POST /support/projects/{project}/keys` | Issue a read/write pair | 10/hour |
| `POST /support/projects/{project}/keys/{key}/rotate` | Atomically revoke and replace one key, retaining scope | 10/hour |
| `POST /support/projects/{project}/keys/{key}/revoke` | Revoke one key; repeated requests retain the first timestamp | 30/minute |
| `POST /support/projects/{project}/customers/{contact}/sessions/revoke` | Expire every currently active session for this exact project contact | 30/minute |
| `POST /widget/projects/{project}/session/revoke` | Expire only the customer bearer token presented by this request | 30/minute |

`{project}` is the public project ID. Key/contact IDs come from scoped API
responses. Key metadata contains only ID, read/write scope, creation time and
revocation state/time. No key digest, secret or last characters are listed.
Key and session writes produce metadata-only audit intents in the existing SQL
outbox; the intent does not claim that an external notification was delivered.

## Secrets, retries and lost responses

Send `{ "idempotencyKey": "a-stable-operation-id" }` when creating a pair or
rotating a key. Rotation requires this field and rejects additional fields,
including a requested scope. Keep the same ID for a retry of that operation.

The first committed pair response includes `ingestKey` and `readKey`; the first
rotation response includes `secret` and the replacement's `key` metadata.
`revealed: true` marks that response. Store secrets in your server's secret
manager. Keys are SHA-256 digests in `support_api_keys`; generic idempotency
receipts contain only the key IDs. Raw secrets are never recoverable from
those records and are never replayed, even when the first response is lost.

A retry returns `replayed: true`, `revealed: false`, the current state of the
created replacement(s), and a recovery instruction. Concurrent retries create
one replacement and only one secret-bearing response. A new operation cannot
rotate an already revoked key. To recover a lost secret, explicitly rotate the
active replacement ID using a new operation ID; this revokes that lost secret
and reveals the next one once. Until that step succeeds, update no dependent
server deployment to an unknown secret. There is no overlap window: a rotation
revokes the old key at the same commit that creates its replacement.

Pair creation without an operation ID remains compatible with existing clients:
each request is a separate issuance. Such clients must list/revoke unwanted
keys after a lost response; they cannot safely retry a request as if it were the
same issuance. Settings supplies an operation ID and retains it in memory for
an explicit retry. Navigating away loses that in-memory retry ID; the metadata
list remains available for explicit recovery. Neither keys nor retry responses
are stored in browser persistence.

Native Buddy/HQ grant issuance and its encrypted, one-use collection protocol
are unchanged. An admin can revoke grant-issued keys before the grant is
collected. A late poll can still collect the sealed grant once, but those
revoked keys fail authentication on new requests and do not become active
again. This lifecycle changes project credentials, not the admin's native
account tokens or membership in other workspaces.

## Customer logout

Customer sessions remain opaque random 24-hour credentials stored as hashes.
Self-logout requires the presented bearer credential and an exact allowed
`Origin`. Body-supplied token/contact IDs confer no authority. It expires only
that credential, preserves other sessions/contacts, and is idempotent for a
previously valid expired credential. An unknown or another project's token
returns 401. Admin revocation expires all sessions currently active for the
scoped contact. A later trusted server issuance can create a new session; this
endpoint does not suspend the contact or its account.

Every new authenticated request/poll checks the SQL revocation/expiry state.
A response already authorized and in flight cannot be withdrawn. Key revocation
does not expire already issued customer sessions: revoke the contact's sessions
separately when required. Existing SDK disconnect/identity-forget operations do
not implicitly perform server logout; integrations must invoke the endpoint
before discarding the credential when server invalidation is intended.

## Qualification

`tests/feature/credentials.test.ts` exercises real native HTTP routing, native
auth and generated schemas against disposable SQLite and PostgreSQL databases.
It covers two workspaces, forged IDs, roles/read keys, native browser CSRF,
same/different-operation concurrency, a committed-but-aborted HTTP response,
post-check role demotion, pagination, new-request revocation, scoped customer
logout, late encrypted HQ grant collection and absence of issued secrets in
key/session/idempotency/outbox records. No schema change or provider call is
required. These tests qualify the backend behavior; they do not simulate an
external server deployment rotating its own environment variables.

Settings includes metadata pagination, immediate revoke and same-scope rotation.
It keeps a failed operation ID in memory for an explicit retry and explains
metadata-only recovery. Secrets clear on hide, another mutation, project change
or controller destruction. Customer widget shutdown is unchanged: removing one
messenger instance must not invalidate another instance sharing its token.

The opt-in production STX/browser proof is:

```bash
CHROME_PATH=/path/to/chrome bun --no-env-file scripts/qualify-credential-browser.ts
```

On the pinned STX `0.2.872`, the actual Chromium journey passes all nine key
semantics checks, but qualification remains **partial**: the final zero-runtime-
errors gate fails because the native composable loader selects the unrelated
hosted `support` ESM export from static `hq.support` markup and emits its
`import.meta.url` inside a classic script. The proof retains that failure; it
does not patch or suppress native output. The native owner must fix selection/
module emission, publish it, and rerun this proof with the normal installed
release before claiming complete browser qualification. A screenshot with all
secrets hidden is written under
`storage/framework/runtime/credential-browser/settings.png` during the proof.
