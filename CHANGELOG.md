# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1]

No code changes. This is the first release published by the release workflow
rather than from a laptop, so it is the first to carry a
[provenance attestation](https://docs.npmjs.com/generating-provenance-statements):
the build that produced this tarball is publicly verifiable, and it was
published through OIDC with no npm token existing anywhere in this repository.

0.2.0 had to be published locally, because trusted publishing is configured on
a package settings page that does not exist until the package does.

## [0.2.0]

First release from this repository. Earlier versions were published from a
private monorepo, which is why the 0.1.0 page on npm links to a repository
nobody can open. That is what this release fixes, along with everything below.

### Added

- `fromOpenRouter()` maps an OpenRouter `usage` object to MarginFuse fields,
  including the gateway's own `cost`, so figures from a gateway are exact
  rather than estimated. It exists because mapping the fields by hand gets two
  things silently wrong: `prompt_tokens` already contains cached reads and
  cache writes, which MarginFuse prices separately, and small costs stringify
  to exponent notation, which the API rejects.
- `openrouter` in the `provider` union.
- Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  so the build that produced this package is publicly verifiable.

### Fixed

- **A `block` verdict with no decision id no longer runs the provider call.**
  Enforcement checked the action and the id together, so a decision that
  arrived without an id fell through and the call went out. A missing id costs
  an acknowledgment; it must never turn a block into a provider call. The same
  applied to `topup_required`.
- **`track()` no longer throws on Node 18.** The auto-generated event id used
  `crypto.randomUUID()`, and `globalThis.crypto` only became a global in Node
  19, so on Node 18 (which this package supports) omitting `eventId` threw a
  `ReferenceError` synchronously into application code. The id now comes from
  whatever the runtime offers and degrades rather than throwing, so it also
  works on edge runtimes with no `node:crypto`.

### Changed

- Verified against [marginfuse/sdk-contract](https://github.com/marginfuse/sdk-contract),
  the shared conformance suite every MarginFuse SDK is held to. Fifteen
  behavioral scenarios and thirteen gateway vectors run in CI against the packed
  artifact, not against the source tree.

## [0.1.0]

Initial release. Published from a private monorepo.
