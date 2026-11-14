# Compiled widget browser qualification

Run the native compiler and actual headless Chromium journeys:

```sh
bun --no-env-file scripts/qualify-support-browser.ts
```

The default command builds through the existing native `scripts/build-support-elements.ts` publication flow. If the same job already ran that build, use `--skip-build`; artifact checksums and the direct/hosted bundle identity are still verified. There is no fallback to a simulated browser or a silent skip when Chrome is missing. Supply `CHROME_PATH` or `BROWSE_BROWSER` when the native browser helper cannot discover an executable.

The automation API is the published `@stacksjs/testing/browser` subpath. `@stacksjs/browser` supplies browser application helpers rather than this headless test driver. No Playwright, Puppeteer, ChromeDriver, source aliases or package patches are needed.

## What the runner checks

The runner snapshots the emitted public manifest and its checksum-verified artifacts into a private temporary directory. It serves the existing plain HTML element host and hosted loader proof using dynamic loopback ports. Each desktop (1280x900) and mobile (390x844) journey gets a fresh native Chromium context/process and an independent deterministic customer API fixture. No native authentication/API boot, database, customer workspace, payment account or provider credentials are used.

Both pages receive `default-src 'none'` and `script-src 'self'`, with native manifest CSS hashes, no `unsafe-inline` or `unsafe-eval`. The existing element host's test script is served as an external module, not exempted by a permissive CSP. A pre-navigation observer collects actual CSP violations while the emitted modules execute normally. Browser requests to other origins are refused and reported as failures. CDP evaluation only observes fixture outcomes; the compiled bundle is never evaluated through a privileged protocol bypass.

The direct proof checks all five custom elements, shadow roots/styles, missing ambient stx globals, pre-upgrade properties, scoped HTTP messages, text escaping, delivery-error draft retention and session cleanup. The hosted proof checks lazy import, two independent instances, caller-owned containers, supplied style nonce, token nonreflection, lifecycle/events and shutdown. The default four journeys render 78 PASS assertions. Console/runtime errors, unexpected failed requests, CSP violations, external requests, missing completion or missing Chrome fail the command. Only the exact explicit `body: 'FAIL'` draft-retention request is allowed to return 503; it must occur exactly once on each direct proof journey.

Native browser close and preview shutdown run in `finally`. Build subprocesses run in an owned process group with a 120-second deadline, bounded output capture and TERM/KILL cleanup on interruption/failure. Browser startup, protocol and page assertions also have deadlines. Temporary snapshots are removed; no fixed preview port or shared user profile is used. Old screenshots owned by this runner are cleared before a new run, preventing stale captures from being mistaken for current evidence.

Artifacts are written to `storage/framework/runtime/support-browser` (override with `SUPPORT_BROWSER_ARTIFACTS` pointing to a dedicated output directory): `report.json`, build log, and desktop/mobile screenshots for both pages. Failures retain available page diagnostics and a clearly named failure screenshot. These are test fixture artifacts without real session credentials or customer data.

## CI integration proposal

The existing verification job already builds the emitted widget. Add this immediately after `bun scripts/build-support-elements.ts`:

```yaml
- name: Qualify compiled widget in Chromium
  timeout-minutes: 5
  env:
    CHROME_PATH: /usr/bin/google-chrome
  run: bun --no-env-file scripts/qualify-support-browser.ts --skip-build
- name: Upload widget browser evidence
  if: always()
  uses: actions/upload-artifact@v7
  with:
    name: support-browser-${{ github.run_attempt }}
    path: storage/framework/runtime/support-browser
    if-no-files-found: error
    retention-days: 7
```

Alternatively run the default command in a dedicated job after checkout, Bun setup and frozen dependency installation; it does not require the database service or `buddy key:generate`. GitHub's [Ubuntu runner image installs Google Chrome at this path](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/install-google-chrome.sh). The runner records the actual browser version rather than assuming a fixed version. If the chosen runner lacks Chrome, configure an executable explicitly; do not suppress the failed check. The upload step uses the current [official artifact action](https://github.com/actions/upload-artifact/releases/tag/v7.0.2).

This change does not modify `.github/workflows/ci.yml`, package manifests or locks. CI integration is owned by the root implementation task. Local qualification used the installed published Stacks testing helper and an existing Chrome for Testing 157 executable on macOS, including a fresh native build and all four real-browser journeys. Execution on the Linux CI runner still needs its own recorded result after the workflow integration lands. This compiler proof does not qualify live providers, customer authentication, telephony audio or real customer delivery.
