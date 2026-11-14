# HQ.support browser elements

The five standalone custom elements are authored in stx and compiled with the
native `buddy build:web-components` pipeline. Their internal styles live in
isolated open shadow roots. The application pages use ts-css utilities.

Run `bun scripts/build-support-elements.ts` before serving or deploying the app.
It copies the generated ESM bundle and manifest into ignored `public/widgets/`.
Load that module from your host or install the generated library. A remote module
URL requires `Access-Control-Allow-Origin: *` on the public asset response;
customer API CORS separately requires an exact origin allowed by the project.

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
