# Support element npm publication

The minimal npm distribution is `@stacksjs/support-elements`: five native stx custom elements, per-element ESM/declarations/CSS, the self-registering bundle, SSR helpers and Custom Elements Manifest. The hosted `createSupport` lazy loader remains a separate public asset. The publication checks require its native bundle to match the npm bundle exactly. No new loader facade is invented inside this npm package.

The `alpha` tag currently points to `0.1.0-alpha.1`, pinned in `config/library.ts` independently of the application's `0.0.0` version. The package README explains browser module imports and the alpha qualification limits. The publication workflow is manually dispatched, defaults to verification/dry-run, and publishes when its `publish` input is selected.

## Native fixes and publisher choice

The original native manifest advertised a nonexistent `dist/bundle.css`, invented declarations for an internal runtime, and mapped explicit `.js` imports through a suffix-doubling wildcard. The owning fix is in Stacks actions `library/manifest.ts` and `library/build.ts`: component exports are derived from emitted files; CSS aliases are only advertised when they exist. Both suffixless and explicit `.js` module imports have exact declaration targets. The bundled root already exported the component classes correctly. No stx emitter or app compiler patch was needed.

Stacks `buddy libs:publish` now accepts validated `--tag alpha` and explicit `--publisher bun|npm|pantry`. The selector requires that binary and the configured registry compatibility; omission preserves previous publisher discovery. The workflow requires the released native fixes, not a source alias, local package patch or file dependency. Native framework release 0.75.581 is the expected first version containing them.

Pantry 0.11.206 separately rejects valid `0.1.0-alpha.0` with `InvalidVersion`, reproducible with a tiny standalone package. Its owner is `pantry-pm/pantry`, `packages/zig/src/packages/publish.zig`, whose `validateVersion` currently accepts numeric X.Y.Z only. This remains an upstream follow-up. The workflow explicitly selects Bun's existing production npm publisher and uses official `bun pm pack`; it never changes the alpha into a false stable version. Bun's [publish documentation](https://bun.com/docs/pm/cli/publish) describes tarball packing, explicit tags and token configuration. It also states that Bun does not generate npm provenance. This workflow therefore requires a configured npm publishing token and does not claim an OIDC/provenance attestation.

A first npm publication can receive the registry's initial `latest` tag in addition to the requested `alpha` tag. The verifier records actual tags and requires `alpha` to identify the exact version; it does not silently promote, remove tags or claim a stable release. Consumers in these checks pin the exact alpha version.

## Candidate preparation in main CI

After the native element build and Chromium compiler proof, main CI runs:

```yaml
- name: Prepare reviewed component publication artifact
  env:
    SUPPORT_ELEMENTS_VERSION: 0.1.0-alpha.1
  run: bun --no-env-file scripts/support-elements-release.ts prepare
- uses: actions/upload-artifact@v7
  with:
    name: support-elements-${{ github.sha }}
    path: storage/framework/runtime/support-elements-release
    if-no-files-found: error
    retention-days: 14
```

The root task owns `.github/workflows/ci.yml`; these are integration instructions, not a second CI definition. The prepare command only replaces its dedicated generated release directory. It requires a real installed native actions package at least 0.75.581, with no workspace link. It also requires exactly one reviewed npm library, the pinned version and current Git SHA, all concrete export targets, standalone runtime imports, strict declarations, CEM tags, and no application/server/private files or known server-secret access markers. Lifecycle scripts and server/framework dependencies are refused.

Bun 1.4.4 produces `package.tgz`. `release.json` records source SHA, version, canonical archive SHA-256, every package file hash, every hosted file hash and the packer version. The four passing compiler/browser journeys and hosted assets are retained with the candidate. Hosted asset hashes are checked against the native manifest, and the hosted immutable bundle must equal npm `dist/bundle.js`.

Before uploading, a clean disposable consumer installs the archive with scripts disabled and no app dependency aliases. It must be a real installed directory. Bun's installer-only `.bun-tag` marker is excluded from installation comparison; that filename is never allowed inside the reviewed archive. Strict TypeScript compilation uses the declarations with no ambient stubs and `skipLibCheck: false`, importing root, suffixless/explicit per-element modules and SSR. Actual Chromium imports the bundle and each of the five individual ESM modules in fresh contexts on a plain host, under strict script/style CSP. Exported constructors must match native registrations, create shadow roots and avoid customer-token reflection. External requests are blocked. Source and temporary consumer files are removed after verification.

## Same-commit publication and public readback

`.github/workflows/publish-elements.yml` accepts a successful main `ci_run_id`, the reviewed version and a boolean publish choice. `verify-elements-ci.ts` checks the GitHub API for the exact current SHA, repository, main push, CI workflow path, completed success, and unexpired `support-elements-{SHA}` artifact. A successful check for another branch, fork, workflow or commit cannot authorize publication.

The workflow downloads that candidate from the verified run. It checks hashes and restores only the generated package directory from the archive. It does not build the components or hosted loader again. It reruns the clean consumer and the existing hosted browser proof against the artifact directory using `SUPPORT_BROWSER_ASSETS` and `--skip-build`, then executes:

```sh
./buddy libs:publish --publisher bun --tag alpha --dry-run
```

With the publish input selected, a separate job rechecks CI ownership, downloads/restores the same artifact and runs the native publisher with the same explicit selector/tag. Tokens are provided through masked environment variables, never command-line arguments or logs. Bun 1.4.4 requires npm authentication even with `--dry-run`, so the final native dry-run step also receives the repository's `NPM_TOKEN`; the preceding artifact and browser checks do not receive that token. Without the credential, those checks can pass while native publisher qualification remains blocked. The workflow has no automatic branch/tag publication trigger and no force-republish flag.

After acceptance, `scripts/support-elements-release.ts registry` reads the exact version from the public npm registry, validates its SHA-512 integrity and canonical archive SHA-256 against CI, verifies all file hashes, and requires the actual alpha tag. It then installs that exact registry version in a clean consumer and repeats strict declarations and six real-browser imports. The workflow's next step verifies the separate hosted loader against the identical bundle. Existing versions are never overwritten; public readback still must match the candidate before qualification succeeds.

Registry processing can briefly return metadata 404 after a successful upload. Public reads share a five-minute monotonic deadline covering version metadata, archive bodies and package/tag metadata. Each request, including body consumption, has a 15-second timeout. Only metadata 404, network/timeout failures, 429 and 5xx responses are retried, with a five-second minimum delay. Numeric Retry-After values can increase that delay within the remaining budget. Archive 404, authentication/authorization failures, redirects, malformed metadata, wrong package/version/origin, integrity or payload mismatches and incorrect alpha tags fail immediately. Validation never runs inside the transport retry loop. A deadline failure means public verification remains incomplete; it never authorizes another upload or tag change.

`release.json`, `consumer-report.json`, `registry-report.json` and hosted Chromium reports/screenshots are the evidence. A successful upload alone is not a successful published consumer check. Registry propagation failures or mismatched bytes fail qualification and preserve available reports; rerunning readback does not authorize changing an immutable version.

## Read-only verification of an existing publication

Dispatch `.github/workflows/verify-elements-registry.yml` on current reviewed `main` with an explicit historical `source_sha`, successful source `ci_run_id`, and exact published `version`. For the initial alpha these are:

```text
source_sha: f2faf6f414e257b80d0a648dbe723572fe17a51b
ci_run_id: 43623581540
version: 0.1.0-alpha.0
```

The checkout is the dispatch's `github.sha`, so historical source cannot select executable verifier code. `verify-elements-registry-source.ts` imports the existing `assertElementsCiRun` and validates the original same-repository main push, exact source SHA, workflow path, completed success, and unique unexpired candidate. The candidate's own workflow-run ID, repository IDs, branch and source SHA must match. The workflow downloads that checked artifact ID from the original run and uses its original `release.json`, archive and hosted assets directly. It neither restores a publication directory nor rebuilds a candidate. The existing publisher's current-main/current-SHA gate remains unchanged.

The workflow uses only `contents: read` and `actions: read`. Its GitHub token is scoped to CI/artifact reads; public npm verification needs no npm credential. No publication, version/tag rewrite, provider request, DNS mutation or host deployment is involved. Runner-provided Chrome executes all six public package imports and the four existing hosted-loader journeys against the retained original bundle.

`source-report.json` records source CI, artifact ID, immutable `sourceSha` and current `verifierSha` separately. A completed registry report also records both revisions and the canonical archive hash. The artifact archive and release provenance keep the historical source SHA. Reports and browser evidence are retained even when a later step fails. A green source gate alone does not establish a green registry/browser result. Native CI runs the registry boundary and workflow ownership tests through `./buddy test`, and `bun run typecheck:elements` checks the verifier scripts and their tests.

## Current evidence and remaining qualification

The earlier source `6fb11394806ce659abec5c7c806b99e01f2864dd` was held after focused-control and disabled-binding compiler defects were found. It was not the published candidate. Released stx 0.2.880 and Stacks 0.75.585 are installed without source aliases, package patches or workspace dependency links. Source [main CI 43623581540](https://github.com/stacksjs/hq.support/actions/runs/43623581540) at `f2faf6f414e257b80d0a648dbe723572fe17a51b` passed the strengthened compiler proof, 75 tests and native application browser journeys, retaining the exact publication candidate. [Dry run 43624504199](https://github.com/stacksjs/hq.support/actions/runs/43624504199) also passed.

[Publication run 43625621495](https://github.com/stacksjs/hq.support/actions/runs/43625621495) uploaded `@stacksjs/support-elements@0.1.0-alpha.0` successfully after operator authentication at 2026-11-14 18:20:04 UTC. The native publisher warned that registry processing can take minutes. The immediate readback at 18:20:05 UTC received metadata 404, so the run failed its post-publication gate after upload acceptance. This is a transient read failure following a successful upload, not an unpublished package or permission to republish.

Subsequent public metadata returned HTTP 200. [The hosted readback workflow](https://github.com/stacksjs/hq.support/actions/runs/43630101975) verified the original archive, public registry installation, strict consumer types, all five component imports and the hosted-loader Chromium journeys.

The `0.1.0-alpha.1` upload used the original archive from [main CI run 44951740948](https://github.com/stacksjs/hq.support/actions/runs/44951740948) at `53d8a7528c273cf59e5d2cecccddc6f30a9e4d33`. The exact registry archive matches SHA-256 `50370c514fdd5e3bb1ab1b3e235e4011ca3ec0b02ca62ab22862e81c73251b9a`. The clean consumer verified strict types and all six browser imports. [Hosted readback run 44958200298](https://github.com/stacksjs/hq.support/actions/runs/44958200298) records the public registry and hosted asset checks for this candidate.
