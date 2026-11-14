# Native phone browser proof

The actual `resources/views/app/phone.stx` page is compiled by native
`generateStaticSite`, with a temporary native `webModules` config replacing only
the official Twilio SDK entry for this test build. The config and symlinked build
root live under `/tmp/hq-support-phone-build-*`; no application config is edited.
The fixture refuses to serve if its SDK marker is missing from the compiled page. Production templates and controllers are
unchanged. The native authenticated API, SQL records, quotas, signed callbacks,
provider operation journal and reservations remain real. External phone and AI
providers and browser audio are deterministic test boundaries. No live calls are
placed.

Start `tests/fixtures/phone.ts` with `SUPPORT_PHONE_BROWSER_FIXTURE=1` and a private
`SUPPORT_PHONE_FIXTURE_STATE=/tmp/hq-support-phone-browser-state.json`. Its native
HTTP/media checks run first. It then seeds an active consented call, creates a
real native browser session, writes the private state file, and stays alive. Use
the same disposable database and environment setup as `tests/feature/phone.test.ts`.
The enterprise agent's temporary source-alias runner is only for qualification
before the native framework release; installed-package proof must follow.

Then run:

```sh
SUPPORT_PHONE_FIXTURE_STATE=/tmp/hq-support-phone-browser-state.json \
  bun --no-env-file tests/widget-phone-preview.ts
```

Open `http://127.0.0.1:4414/app/phone`. The proxy holds the native session cookie
server-side; no credential enters the page markup. Browser CSRF still goes
through the native token route and middleware. A visible fixture banner includes
controls for simulated microphone denial and an SDK event log. Enable the phone,
take over the active AI call, accept, mute/unmute, hang up or decline, and disable.
The fake Device observes actual native call-mode changes; it does not synthesize
call records. End/reconcile use the real API with deterministic external receipts.

## Observed browser results

Chrome exercised real native auth/CSRF and SQL capability/list/detail APIs, a
server-authorized AI-to-agent takeover, incoming accept, mute/unmute, browser
hang-up, decline and Device destruction. The test SDK event log confirmed
`registration-denied / destroyed` for initial registration failure and
`microphone-denied / destroyed` for a later call error. Disable remained available
after the later error.

A separate 60-second AI request created exactly one native call and reserved
230 cents. Ending it persisted `canceled`; reconciliation left the reservation
pending while the deterministic provider had no final receipt. No live phone
network or real microphone audio was used. Those remain provider qualification
work, separate from this deterministic UI proof.

The official SDK is downloaded only with the phone workspace, and initialized
after Enable. It is absent from the inbox and public customer widget bundles.

## Upstream rendering API follow-up

Owner: `stacksjs/stx`, `packages/stx/src/render.ts`, `renderTemplateString`'s call to
`injectRouterScript`. Reproduced with published `@stacksjs/stx@0.2.872`:

```ts
import { renderTemplate } from '@stacksjs/stx'
const html = await renderTemplate('resources/views/app/phone.stx', {
  injectCSS: true,
  options: {
    router: { enabled: false },
    partialsDir: 'resources/partials',
    layoutsDir: 'resources/views/layouts',
    componentsDir: 'resources/components',
  },
})
```

Serve that HTML in a browser. The rendering API still injects the SPA router,
and raw `</script>` strings in its inline payload terminate the script, leaving
router code visible as body text. `renderTemplateString` currently calls
`injectRouterScript(output)` without its `options`. Native SSG builds pass the
router options through, externalize the runtime, and do not show this failure.
The shipping application and this fixture use that native SSG path. No dependency
patch or emitted HTML escaping workaround is carried in the application.
