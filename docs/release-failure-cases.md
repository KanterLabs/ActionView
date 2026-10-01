# ActionView release failure cases

This list is the release test plan. Every failure below must stop the
candidate before publication and leave enough evidence to reproduce the
failure locally.

## Source and version identity

- The checked out revision cannot be resolved, is not the exact tag commit, or
  is not the trusted same-repository revision selected by the workflow.
- The semantic release version is missing, malformed, or differs between the
  release tag, `ci/release.json`, `metadata.json`, and the generated archive.
- The GNOME extension version is not an increasing integer when a GNOME shell
  package consumer requires one. The semantic version remains the release
  identity; the integer is derived metadata and must not replace the tag.
- The source SHA recorded in the artifact manifest does not match the exact
  revision used to build the ZIP, or a downloaded manifest names a different
  source SHA.

## Package creation and integrity

- `gnome-extensions pack` is unavailable, fails, or produces a file with the
  wrong UUID or filename.
- The ZIP is empty, truncated, corrupt, or contains unsafe paths, generated
  build output, private files, or the wrong top-level extension directory.
- Required extension files (`metadata.json`, schema XML, JavaScript modules,
  stylesheet, and icon) are missing; the metadata UUID, shell versions, or
  semantic version is wrong; or the schema cannot compile.
- The SHA-256 manifest is missing, malformed, hashes a different byte stream,
  omits the ZIP, or contains an unexpected artifact. A checksum mismatch must
  fail before installation.
- A package created from a dirty tree silently omits or includes untracked
  source. The source revision and package file list must make this visible.

## Downloaded artifact installation and runtime

- Artifact tests accidentally inspect the source checkout instead of the
  downloaded ZIP, or the download is replaced after its checksum is recorded.
- A clean temporary HOME cannot install the ZIP with `gnome-extensions`, the
  extension UUID is not discoverable, or the installed metadata is invalid.
- Schemas do not compile after installation, the extension cannot enable, or
  enable/disable leaves duplicate panel indicators, poll sources, or stale
  state behind.
- The headless GNOME smoke path fails on the pinned Ubuntu image. The full
  GNOME suite is a scheduled/release gate and is not hidden inside lightweight
  package checks.
- The Fedora hook has no pinned image/capability, runs on the wrong desktop or
  architecture, or reports success without installing and exercising the
  downloaded artifact. Until the parent supplies the image and capability,
  the hook must fail clearly or be an explicit scheduled skip.

## Forge connection and product behavior

- The release documentation points at a private production hostname, embeds a
  credential, or gives no public-safe setup path for a compatible Forge.
- The configured endpoint is empty, malformed, unreachable, times out, returns
  a non-2xx response, returns non-JSON, or returns JSON that is not a Forge
  `/api/operations` payload.
- A compatible endpoint reports an unsupported schema, stale collector data, a
  stale source, or an unavailable backend and ActionView incorrectly shows a
  healthy idle state.
- The disposable endpoint is not isolated from production, cannot exercise
  connected/configured, stale, and unreachable states, or is not documented
  well enough to reproduce the test.
- The smoke test passes only because fixture mode is enabled while the live
  connection/configuration path is broken. Fixture tests and disposable
  endpoint tests must be reported separately.

## Workflow safety and publication

- A fork pull request reaches a privileged homelab runner or receives release,
  deployment, or publication credentials. Fork guards must remain on every
  self-hosted job that executes untrusted code.
- A build/test job can access publication or deployment credentials, or the
  publish job runs before package and downloaded-artifact gates pass.
- A tag/manual dispatch points at an unchecked mutable branch, mismatched
  version, or wrong source revision; manual inputs can select arbitrary code or
  commands.
- GitHub and Gitea both execute or publish the same pipeline after migration.
  Adapters may trigger the same local commands, but one canonical forge owns
  execution and publication.
- Publication is attempted with missing/skipped matrix evidence, a changed
  artifact, a conflicting existing release asset, or a failed durable-retain
  step. A retry must reuse the retained bytes and never rebuild silently.
- A publication adapter is given private deployment state, or a public verify
  step cannot retrieve the recorded ZIP/checksum anonymously.

The current implementation keeps the packaging and downloaded-artifact checks
local and repeatable. Full GNOME and Fedora execution remain explicit workflow
hooks until the parent supplies the pinned Fedora image and runner capability.
