# Native SDK and authenticated session contract

The application is tested through the actual `@stacksjs/support/server` client
and the framework's default Support/SessionAction, with native authentication,
real HTTP routes and disposable SQLite/PostgreSQL databases. These are wire
contract tests, not substitutes for browser rendering or live-provider tests.

## Session expiry and identity

`POST /api/v1/projects/{project}/sessions` requires the project's write key and
returns `{ token, expiresAt, contact }`, where `expiresAt` is an ISO UTC string.
The native SDK validates this string. The database still stores epoch
milliseconds, and widget `POST /api/widget/projects/{project}/session` preserves
its existing numeric-millisecond `expiresAt` response. The same opaque,
hashed-at-rest token works across the server SDK and scoped widget APIs.

A consumer's native authenticated session action calls
`createAuthenticatedSupportSession`. It reads `request.user()` and derives
`user:{id}`; submitted `externalId`, `userId` or profile fields do not choose
another customer. Only explicitly configured email/name fields are exposed.
The response is private/no-store and contains the customer token/expiry only,
never the server key. Anonymous requests fail native authentication, disabled
integration refuses provisioning, and upstream key failure does not produce a
fabricated customer session.

Consumers must install the published native support package and configure the
server-only `services.supporthq` integration (`enabled`, `url`, `project`,
`key`, optional `expose`). The native default route registry mounts
`/api/support/session` when enabled; the fixture mounts that exact default
Action under a test-only path. HQ.support's existing v1/widget routes need no
new registration for these fixes. Keep the write/read keys off the browser.

The typed SDK company `{ id, name? }` is retained without new schema: the
contact's company label is stored in `company`, and the stable company identity
is stored as `attributes._hqSupportCompany`. That namespace is reserved for the
typed company field; arbitrary custom attributes cannot overwrite it. Unrelated
profile updates preserve it. Existing string company input remains supported.

## Conversation queries

`GET /api/v1/projects/{project}/conversations` accepts one of each:

- `status`: `open`, `closed` or `snoozed`, the actual conversation transition
  states. Ticket state names such as `resolved` are not conversation states.
- `limit`: a whole number from 1 to 100; default 50.
- `cursor`: the opaque positive-ID cursor returned by the previous page.

The authenticated inbox and contact-scoped widget list use the same validated
query. Filters are SQL predicates and limits are applied before serialization.
Results descend by ID; the extra lookahead row determines `nextCursor`.
Continue with the same filter and returned cursor. Empty, fractional,
exponential, out-of-range or duplicate query values fail validation.

A read key can retrieve summaries. It cannot mint sessions, track events,
create conversations or reply. Summaries contain no transcripts, internal
notes or customer emails. Widget reads remain contact-scoped, and customers
cannot write internal notes. Changed writes under the same idempotency key
conflict; manual replay after a lost acknowledgement returns the original
committed effect. The SDK never automatically repeats an uncertain write.

## Retained evidence

`tests/feature/native-support-sdk.test.ts` runs the native SDK and default
session action against actual app HTTP/SQL on both databases. It covers expiry
serialization, authenticated identity instead of browser identity, widget/server
roundtrips, optional company persistence, key scope/revocation, cross-project
isolation, public/internal messages, filtered pagination, input bounds and a
real committed request with simulated acknowledgement loss. It also caught and
fixed the PostgreSQL `assignee_id = '0'` truthiness issue during status changes.

Initial qualification used reviewed native source aliases while publication was
pending. The complete application suite subsequently passed with registry-installed
native 0.75.581 on both databases, including this SDK fixture, in
[CI for the integrated application](https://github.com/stacksjs/hq.support/actions/runs/43567673314).
Later dependency or contract changes require fresh evidence. Run the focused
fixture with an owned PostgreSQL service:

```sh
STACKS_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55439/postgres \
  ./buddy test tests/feature/native-support-sdk.test.ts
```

Use an owned disposable vector-capable PostgreSQL server for the application's
current generated schema. No shared server extension installation is performed
by this fixture.
