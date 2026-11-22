# HQ.support browser elements

The five standalone custom elements are authored in stx and compiled with the
native `buddy build:web-components` pipeline. Their internal styles live in
isolated open shadow roots. The application pages use ts-css utilities.

## npm distribution

The first release candidate is `@stacksjs/support-elements@0.1.0-alpha.0`.
Publication remains gated on successful CI for the exact source commit and a
clean installed consumer; this candidate is not a general-availability claim.
The package contains the five elements, their declarations, custom-elements
metadata, per-element CSS and the native SSR entry. The hosted controller below
is a separate artifact built from the same native bundle.

After publication, a browser bundler can load one element explicitly:

```ts
import '@stacksjs/support-elements/hq-support-messenger.js'
import type { Messenger } from '@stacksjs/support-elements'

const messenger = document.createElement('hq-support-messenger') as Messenger
document.body.append(messenger)
await messenger.boot({
  url: 'https://api.hq.support',
  project: 'PUBLIC_PROJECT_ID',
  token: customerSessionToken,
})
messenger.open()
```

Importing the root module registers all five elements. Each element includes its
shadow styles; consumers do not need a global stylesheet. Use the explicit
`/ssr` entry for server rendering. The package contains no enterprise modules,
server integration keys or account-provisioning behavior.

Run `bun scripts/build-support-elements.ts` before serving or deploying the app.
It emits a content-addressed version under `public/widgets/<app-version>-<hash>/`,
plus the stable ESM entry `public/support.js` and a publication manifest at
`public/widgets/manifest.json`. Rebuilding a version may not alter its bytes.
The manifest records SHA-256, SHA-384 integrity, raw size and gzip size for each
file. These are publication checksums; browser dynamic imports do not enforce
Subresource Integrity automatically. Load the hosted entry or install the generated library. A remote module
URL requires `Access-Control-Allow-Origin: *` on the public asset response;
customer API CORS separately requires an exact origin allowed by the project.

## Hosted loader

Import the ESM entry in your own external module, then await boot before commands:

```ts
import support, { createSupport } from 'https://hq.support/support.js'
await support.boot({ project: 'PUBLIC_PROJECT_ID', sessionToken: customerSessionToken })
support.open()
await support.update({ sessionToken: nextCustomerSessionToken })
await support.track('project.viewed', { section: 'settings' })
support.close()
support.shutdown() // Sign-out: clears identity, stops work and removes its owned DOM.
```

The customer token must come from your server. Never use a project API key in a
browser. `endpoint` defaults to the hosted module origin; supply it for a separate API
origin. The loader imports the native bundle only when boot is called, mounts a
launcher and messenger, and forwards native events through `on(name, listener)`
(which returns an unsubscribe function) and `addEventListener`/`removeEventListener`.
On a trusted site with anonymous messaging enabled, set `resumeAnonymousSession`
to retain the conversation across reloads in the same tab. The anonymous token
is stored in the embedding site's session storage under the endpoint and project.
Explicit customer tokens remain in memory. Each embedded API request still
requires the site's exact origin on the project's allowlist.
It does not install globals. The current messenger supports English (`en`) only;
other locale requests fail explicitly. Use `createSupport({ container: HTMLElement, inline?: boolean })` for independent
instances owned by a component. A supplied container defaults to inline positioning.
Boot options `mount: HTMLElement` and `inline: boolean` can override those defaults.
Do not mount multiple fixed instances over one another. Reboot or shutdown while
an import/request is pending invalidates the previous operation.

For CSP, allow this asset origin in `script-src` and the API origin in `connect-src`.
The emitted code needs neither inline scripts nor eval. Native shadow styles need
the exact `csp.styleSrc` hashes in the publication manifest. The optional boot
`nonce` is applied as a property to the loader layout style. A strict host should
pin `immutableEntrypoint` from the manifest so a later stable-entry update cannot
change styles independently of its CSP hashes. The browser fixture `/loader-proof`
checks a policy with no unsafe-inline or unsafe-eval and verifies independent
instances, token handling, identity updates and complete shutdown.

## Messenger lifecycle

`hq-support-messenger` supports:

- `boot({ url, project, token? })`, where token is a server-issued customer session.
- `open()`, `close()`, `update({ token? })`, `track({ event, attributes? })`, and `shutdown()`.
- `ready`, `opened`, `closed`, `unread`, `delivery`, and `error` events.

API credentials are server only. Set a customer session token as a JavaScript
property or boot option, never as an HTML attribute. Session properties have
`attribute: false` and `reflect: false`. Anonymous sessions require a project
setting and an allowed host origin.

The messenger polls the scoped customer conversation every five seconds. It
preserves an unsent draft when a reply arrives, aborts stale work, and clears
polling and customer state on shutdown or disconnection. Its unread event counts
agent messages received while this connected instance is closed; it does not
claim a durable cross-device read cursor.

`hq-support-launcher` emits `opened`; the host connects that event to its
messenger's `open()` method. `hq-support-help-search`, `hq-support-ticket-form`,
and `hq-support-ticket-status` accept `apiUrl`, `projectId`, and the non-reflected
`sessionToken` property. The ticket status element also accepts `ticketId` and
loads on `refresh()`.

## Resolved-conversation feedback

Messenger reads the actual scoped CSAT endpoint after loading/refreshing its
conversation. Projects remain opted out until an owner/admin enables the
question. An eligible own resolved conversation receives a five-score native
radio group and optional comment, without an outbound survey message. The form
keeps its offered question/revision and draft through uncertain delivery, reuses
the operation key for an unchanged retry, and requires explicit review of a
changed question. Its own saved receipt remains an immutable snapshot.

Feedback values and receipts never reflect into host attributes. Switching
customer/project/API identity, shutdown, disconnection or a current revoked
session clears them; generation checks reject stale previous-session responses.
See `docs/customer-satisfaction.md` for the native API/browser proof and its
currently failing upstream production STX qualification gate.

## Compiler boundary

Standalone elements use native component metadata, reactive properties,
`onConnect`/`onDisconnect`, named event methods, and `this.emit`. They do not use
or install the page runtime's ambient `state`, `onMount`, or `window.stx` globals.
The native library compiler supports a different subset from the page compiler:
use bare method names in event directives and property paths in dynamic bindings.

This delivery is qualified for browser loading. The installed native library
SSR helper does not execute these conditional/loop templates or `this` property
expressions. Do not use its generated `ssr.js` as customer-facing rendered HTML.

## Verification

`bun test tests/widget-elements.test.ts` checks the emitted package boundary.
`bun tests/widget-preview.ts` serves `/proof` on port 4407. Its plain HTML host
loads the actual emitted module and reports browser assertions for registration,
shadow isolation, no ambient runtime, pre-upgrade properties, escaped content,
scoped HTTP delivery, failed-draft retention, and lifecycle cleanup.

For real native API browser QA, use a disposable SQLite database:

```sh
SUPPORT_NATIVE_UI=1 DB_DATABASE_PATH=/tmp/hq-support-ui-browser.sqlite \
  DB_CONNECTION=sqlite APP_ENV=test STACKS_DEFAULT_ROUTES=auth \
  bun --no-env-file tests/widget-preview.ts
```

This migrates only the explicitly named test database, captures outgoing mail,
and exposes the native APIs on port 4407 with a separate customer host on 4409.
Register a local test account, create a workspace and project, then allow
`http://127.0.0.1:4409` in its messenger settings. Open the customer host with
`?project=THE_PUBLIC_PROJECT_ID`. Add `&native=1` to load the ESM asset from a
separately running native frontend on port 4411 and verify public asset CORS.
