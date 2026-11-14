# HQ.support enterprise modules

This directory is governed by [LICENSE.txt](LICENSE.txt). Its source is visible in the public repository and is excluded from the root MIT grant. The private package metadata prevents accidental standalone registry publication under the core application's MIT metadata.

The server application imports these modules directly. A source or server release that contains them must retain this directory's license. The independently compiled customer component library includes only `resources/components/support/*.stx` and does not distribute these server modules.

Identity and governance operations validate signed installation entitlements on the server. An expired entitlement prevents new commercial configuration while preserving core login continuity, existing support conversations and exports. Reusable OIDC and SAML protocol primitives live in the MIT Stacks framework; this directory implements the application's commercial policy.

See [enterprise administration](../docs/enterprise.md) for configuration, retained test evidence and qualification limits.
