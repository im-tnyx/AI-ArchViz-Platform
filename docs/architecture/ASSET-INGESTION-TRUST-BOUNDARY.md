# External Asset Ingestion Trust Boundary (Spike 7A)

Spike 7A defines eligibility and byte verification for a future external
`3ds_max` asset loader. It does not open, import, merge, execute, render, or
otherwise load an external `.max` file into a production scene.

## Contract split

- A scene object has a stable logical `id`.
- An `assetDefinition.id` identifies immutable intrinsic asset data.
- An external `artifactId` identifies one exact binary artifact.

SceneSpec v0.2 may describe an `external_max` asset definition only through its
`artifactId`, dimensions, pivot policy, and scale policy. It never contains a
file path, storage key, URL, command, trust override, or raw hash. Procedural
proxy definitions must not carry an `artifactId`.

The worker-only registry keeps the normalized relative storage key separately
from SceneSpec and manifests. `trustedAssetRoot` is absolute worker
configuration, never portable scene data.

## Eligibility and resolution

`validateAssetArtifactEligibility` is pure. It requires one registry artifact
record in `VERIFIED` state and passing inspection evidence bound to the same
`artifactId` and exact SHA-256 value. Its result does not expose a storage
location. The SHA-256 value is over the exact artifact bytes; a canonical JSON
hash of a registry record is never a substitute for that byte hash.

`resolveVerifiedAssetArtifact` subsequently canonicalizes the trusted root and
candidate path, rejects traversal, drive/UNC/rooted keys, control characters,
wrong extensions, missing files, non-files, size mismatches, hash mismatches,
and reparse/symlink escapes. It exposes an internal path only to worker code
after all checks pass; that path must not enter SceneSpec, a semantic manifest,
logs, jobs, or DCC plans.

## Future inspection boundary

Inspection must run in an isolated workspace and separate process. It may only
inspect bytes already quarantined by the asset pipeline; it must never replace
the production scene process. Unknown plugins and external dependencies are
reject-by-default. No unsafe bypass is defined. Renderer-specific handling is
out of scope and the contract remains renderer-neutral.

## Current build boundary

The existing Golden scene remains procedural-proxy-only. `ReplaceAsset` accepts
only procedural proxy definitions, so no external artifact can enter the DCC
through current revisions. A future loading spike needs an explicit scope,
inspection implementation, fresh-process DCC verification, and a new Golden
revision.
