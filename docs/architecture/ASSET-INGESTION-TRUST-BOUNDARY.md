# External Asset Ingestion Trust Boundary (Spikes 7A–7C)

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

## Isolated inspection boundary (Spike 7B)

`resolveArtifactForInspection` is deliberately narrower than production
resolution: it permits only a `QUARANTINED` registry record after the same
canonical-root, normalized storage-key, regular-file, extension, byte-length,
and exact SHA-256 checks. `resolveVerifiedAssetArtifact` remains
`VERIFIED`-only.

The inspection job contract carries only its version, artifact ID, exact
artifact SHA-256, and `3ds_max` format. It accepts no path, storage key,
script, command, plug-in path, or caller-selected output location. The worker
uses a fresh `3dsmaxbatch.exe` process, its own temporary workspace, and only
the checked-in `tools/3ds-max/python/inspect_asset.py` runner. The inspected
file becomes that process's complete temporary scene; the runner never merges,
imports, saves, renames, repairs, or otherwise mutates it.

The Python runner also fails closed when its own DCC process is elevated. The
inspection path is intentionally a non-administrator operation.

The batch invocation requests Dialog Monitor and Safe Scene Script Execution.
The inspector reads `SceneScriptSecurityManager`; an observation is accepted
only when Safe Scene execution, command-line lock, and script-asset protection
are all actually observed. It never changes security preferences. If the API
cannot establish that posture, the inspection fails.

Evidence remains bound to the exact artifact bytes and records only normalized
facts: DCC identity, units, millimeter bounds, pivot compatibility, node and
material counts/classes, and dependency counts. It never persists raw author
machine paths. Any missing external file, missing plug-in/DLL, XRef, unexpected
scene content, unsupported scene class, or security uncertainty fails the
inspection. Pure worker-owned promotion permits only:

```text
QUARANTINED + matching passing evidence → VERIFIED
```

The controlled integration fixture is generated dynamically by trusted 3ds Max
code and removed after the test; no `.max` binary is tracked.

## Controlled verified ingestion boundary (Spike 7C)

Spike 7C is the first narrowly controlled production-scene use of an external
artifact. A `ReplaceAsset` ChangeSet continues to carry only
`newAssetDefinitionId` and `placementPolicy`; it cannot supply an artifact
path, storage key, hash, trust override, merge option, or script. A
worker-owned trusted definition catalog resolves that immutable definition to
its worker-owned artifact registry record.

The pure preflight validates the base SceneSpec and ChangeSet, catalog lookup,
category/pivot/scale/space compatibility, geometry lock, verified artifact
state, matching passing inspection evidence, and source byte identity. Only
then does the worker copy exact verified bytes to its isolated candidate
workspace at a worker-selected `inputs/replacement.max`, re-hash the copy, and
allow the mutation process to see that staged path. The original trusted
library path is never sent to the DCC and never appears in SceneSpec,
ChangeSet, semantic manifest, or execution evidence.

The 3ds Max Batch mutation uses `mergeMAXFile` through direct `pymxs` bindings,
with non-interactive duplicate and reparent policies, `pymxs.byref` result
lists, and abort-on-missing external/DLL/XRef handling. Safe Scene Script
Execution must be observed enabled, command-line locked, and script-asset
protected before both merge and fresh candidate reopen. The merge accepts only
the inspected first-ingestion shape: exactly one geometry node and no
dependency/XRef admission.

Incoming node names and `AIArchViz.*` data have no authority. After physical
dimension verification, the worker canonicalizes the replacement to the prior
logical ID, anchor, material, lock metadata, scene identity and external
definition ID, then removes the old procedural object. The revision is
promoted only after a distinct fresh Batch verifier rebuilds and matches the
full semantic manifest. The base checkpoint and verified source are hashed
before and after execution, while replay of the same idempotency key and
request hash launches no additional DCC process.

The target SceneSpec appends exactly one catalog-controlled immutable external
definition; existing definition records are byte-for-byte unchanged. This
runtime-bound controlled fixture does not create a portable committed
`rev_golden_0009` binary or store any machine-specific `.max` hash in the
Golden fixtures.

## Current build boundary

The clean Golden scene builder remains procedural-proxy-only. It must reject an
`external_max` definition when no verified artifact/catalog execution context
exists; it never synthesizes an external asset as a Box. The controlled 7C
runner is a separate worker path and does not rewrite rev1–rev8 fixtures.
Material normalization, texture packaging, multi-node commercial asset
normalization, Corona/V-Ray compatibility, and all renderer work remain out of
scope.
