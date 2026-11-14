# Support element npm publication

The minimal npm distribution is `@stacksjs/support-elements`: five native stx custom elements, per-element ESM/declarations/CSS, the self-registering bundle, SSR helpers and Custom Elements Manifest. The hosted `createSupport` lazy loader remains a separate public asset. The publication checks require its native bundle to match the npm bundle exactly. No new loader facade is invented inside this npm package.

The reviewed initial proposal is `0.1.0-alpha.0`, pinned on this package's entry in `config/library.ts`, independently of the application's `0.0.0` version. A package README should explain browser module imports and the alpha qualification limits. The root task owns those configuration/readme/build changes and the final artifact review. The workflow is manually dispatched, defaults to verification/dry-run, and publishes only when its `publish` input is selected. This is release coordination within the existing authorized task, not an additional user approval requirement.

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
    SUPPORT_ELEMENTS_VERSION: 0.1.0-alpha.0
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

With the publish input selected, a separate job rechecks CI ownership, downloads/restores the same artifact and runs the native publisher with the same explicit selector/tag. Tokens are provided through masked environment variables, never command-line arguments or logs. The workflow has no automatic branch/tag publication trigger and no force-republish flag.

After acceptance, `scripts/support-elements-release.ts registry` reads the exact version from the public npm registry, validates its SHA-512 integrity and canonical archive SHA-256 against CI, verifies all file hashes, and requires the actual alpha tag. It then installs that exact registry version in a clean consumer, repeats strict declarations and six real-browser imports, and verifies the separate hosted loader against the identical bundle. Existing versions are never overwritten; public readback still must match the candidate before qualification succeeds.

`release.json`, `consumer-report.json`, `registry-report.json` and hosted Chromium reports/screenshots are the evidence. A successful upload alone is not a successful published consumer check. Registry propagation failures or mismatched bytes fail qualification and preserve the reports; rerunning does not authorize changing an immutable version.

## Current evidence and remaining qualification

The installed package was not present on public npm when inspected (registry returned 404 on 2026-11-14). Native export/publisher fixes have focused upstream tests. App artifact/provenance guards have negative tests for missing exports, changed versions, lifecycle scripts, private/server files, server imports, unsafe archive paths and mismatched CI ownership.

A temporary source-built native export candidate passed strict artifact validation, canonical Bun archive restoration, clean real-directory installation, strict TypeScript and six actual Chromium imports. It used the upstream framework fix from an isolated worktree and unmodified stx-generated elements; it is explicitly source qualification. No source alias, candidate tarball or package workaround is committed to application dependency configuration.

Released-native candidate preparation, successful same-SHA Linux CI, actual npm publication and public installed-package/browser readback remain required before Stage 1 npm qualification is complete. No npm account, credential, tag or external publication was mutated while implementing these scripts.
