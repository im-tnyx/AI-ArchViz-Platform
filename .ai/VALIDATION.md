# Latest Validation Evidence

## Spike 8H canonical Golden Corona preview from rev11 material state (local commit `553cb38`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 210/210
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:canonical-golden-corona-preview-rev11` (new) — built
  `rev_golden_0001`-`rev_golden_0011` through the real revision pipeline
  (base + r2..r11, including 8G's `MigrateMaterialAppearanceContract`);
  compiled the staged rev11 SceneSpec through
  `compileCanonicalMaterialAppearance()` to plan v0.2 (wall/floor/sofa
  roughness `0.62`/`0.34`/`0.78`, all `metalness: 0`, matching 8G's
  hand-picked values exactly, no adapter default); a fresh Safe-Scene process
  independently re-verified the staged copy against all three rev11
  contracts (semantic manifest, canonical render state, canonical material
  state) before ever calling render; resolved the persisted production
  Corona renderer, the persisted `light_living_key_area` CoronaLight, and
  all three persisted `AVZ_MATERIAL_*` Corona Physical Materials purely by
  observation (no creation, no reassignment); confirmed
  `material_floor_neutral` (shared by `wall_south` and `surface_floor_main`)
  resolved to one native instance and every distinct materialId resolved to
  a distinct instance; observed `camera_living_a`'s persisted
  position/FOV/orientation matched the canonical plan within tolerance
  without ever assigning to the camera; rendered a valid 320x240 four-pass
  PNG; produced `canonical-corona-preview-evidence-v0.2` with
  `sceneSpecVersion: "0.3.0"` and no `AVZ_CORONA_*` naming anywhere in the
  evidence; and proved canonical/staged rev11 raw hashes unchanged, no
  `rev_golden_0012` created, and rev11 replay unaffected afterward. 18
  forced-failure cases (staged-hash tamper, manifest mismatch, four
  canonical-render-state mismatches, four canonical-material-state
  mismatches, obsolete diagnostic light, camera missing/ambiguous/semantic-
  mismatch, renderer missing, Safe Scene, invalid PNG, timeout) all failed
  closed with no PASS evidence and no owned process left running.
- `test:3dsmax:canonical-material-appearance-revision`,
  `test:3dsmax:corona-material-appearance`,
  `test:3dsmax:canonical-golden-corona-preview`,
  `test:3dsmax:canonical-render-state-revision`,
  `test:3dsmax:golden-corona-preview`, `test:3dsmax:corona-adapter`,
  `test:3dsmax:corona-baseline`, `test:3dsmax:revision`,
  `test:3dsmax:replace-asset`, `test:3dsmax:asset-inspection`,
  `test:3dsmax:external-asset-ingestion` — all PASS. In particular,
  `canonical-golden-corona-preview` (8E) still builds/verifies `rev_golden_0010`
  only, still realizes temporary materials, and creates no `rev_golden_0011`,
  so it remains historical coverage rather than being superseded.

One real defect was found and fixed against real 3ds Max evidence, in code
this spike did not otherwise need to touch: 8H's observation-only camera
check (position/FOV/orientation compared against the canonical plan without
ever assigning to the camera) surfaced that 3ds Max's `Camera.fov` MAXScript
property is in degrees while the adapter's `fovRadians` is a genuine radian
value — Spike 8E's own runner had been assigning the radian number directly
into the degrees-based property, silently pointing its temporary in-memory
camera at a ~1.3° field of view instead of the intended ~74°. This was never
caught previously because 8E never saves the scene or visually inspects the
render (only format/dimensions are checked). Fixed in
`render_canonical_golden_corona_preview.py` by converting on write and on
read-back; 8E's own regression suite re-ran and passed unchanged afterward.

Target 3ds Max 2026 verification was not performed; only 2025.3 compatibility
mode is claimed. No test-owned 3ds Max process remained after the run; two
unrelated interactive `3dsmax.exe` sessions (no batch/script arguments) were
observed at one point during this session and deliberately left untouched.

## Spike 8G canonical material appearance revision (local commit `a1c9b23`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 191/191
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:canonical-material-appearance-revision` (new) — built
  `rev_golden_0001`-`rev_golden_0010` through the real revision pipeline,
  then applied `MigrateMaterialAppearanceContract` to produce
  `rev_golden_0011`: mutation replaced each pre-migration StandardMaterial
  with a same-named native Corona Physical Material (materialId-based
  deduplication proven: the pre-existing rev4 `wall_south` ->
  `material_floor_neutral` assignment shares one native instance with
  `surface_floor_main`; every other materialId resolved to its own distinct
  instance); fresh semantic-manifest verification reported zero node/camera
  changes (14/14 unchanged); fresh canonical render-state verification
  reported the unchanged Corona preview intent and `light_living_key_area`
  CoronaLight; a new, independent fresh-process
  `canonical-material-state-v0.1` verifier re-observed native base
  color/roughness/metalness within tolerance and re-proved deduplication
  from scratch. `rev_golden_0008`/`0009`/`0010` artifacts were byte-unchanged
  after the migration; replay returned all three evidence records without
  relaunching any DCC process. Eight forced-failure cases (Safe Scene,
  renderer missing, material class missing, roughness property unavailable,
  metalness property unavailable, deduplication failure, invalid evidence,
  evidence mismatch) all failed closed with no candidate promoted.
- `test:3dsmax:corona-material-appearance`,
  `test:3dsmax:canonical-golden-corona-preview`,
  `test:3dsmax:canonical-render-state-revision`,
  `test:3dsmax:golden-corona-preview`, `test:3dsmax:corona-adapter`,
  `test:3dsmax:corona-baseline`, `test:3dsmax:revision`,
  `test:3dsmax:replace-asset`, `test:3dsmax:asset-inspection`,
  `test:3dsmax:external-asset-ingestion` — all PASS unchanged. In particular,
  `canonical-golden-corona-preview` (8E) confirms it still builds/verifies
  `rev_golden_0010` only and creates no `rev_golden_0011`, so it remains
  unaffected by 8G's new revision.

Three real defects were found and fixed against real 3ds Max evidence during
this spike (not merely designed around): a wall's host node is a
non-renderable Dummy with no true material slot, so material identity must
be assigned/verified only on its physical segments (both the mutation and
the new verifier now do this, matching `verify_scene.py`'s pre-existing
wall-validation pattern); Corona's float32 base-color read-back carries
harmless sub-percent noise against a StandardMaterial's exact 8-bit
`.diffuse`, which `verify_scene.py`'s manifest-recovery step now resolves by
storing the tolerance-checked canonical color instead of the raw
observation; and `replayRevision()`'s render-state evidence gate was
extended to `MigrateMaterialAppearanceContract` so a later revision's replay
does not drop render-state evidence that was genuinely verified live. A
transient environmental issue was also encountered and ruled out: an
unrelated, must-not-touch interactive `3dsmax.exe` process briefly pegged a
CPU core during the regression matrix, causing spurious `PROCESS_TIMEOUT`
failures (the underlying scripts completed successfully, just after the
180s timeout) across suites unmodified by this spike; a retry once
conditions cleared passed all ten suites cleanly.

Target 3ds Max 2026 verification was not performed; only 2025.3 compatibility
mode is claimed. No test-owned 3ds Max process remained after the run; the
two unrelated interactive `3dsmax.exe` sessions observed (no batch/script
arguments) were deliberately left untouched throughout.

## Spike 8F canonical material appearance contract (local commit `6b6a48c`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 181/181
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:corona-material-appearance` (new) — pure plan oracle: the
  dedicated `tests/fixtures/corona-material-appearance/scene-spec-v0.3.json`
  fixture compiled through `compileCanonicalMaterialAppearance()` deep-equals
  the frozen `expected-corona-plan-v0.2.json` with no DCC; plan v0.2 carries
  no legacy material adapter default. DCC: a fresh Safe-Scene process
  discovered Corona, realized four native Corona Physical Materials (rough
  dielectric, smooth dielectric, metal, and a value-duplicate of the rough
  dielectric under a distinct ID), and observed native
  `baseColorRgb`/`roughness`/`metalness` matching canonical intent within
  tolerance for every material, including the metallic material's
  `metalness=1`. Deduplication proof PASS in both directions: the rough
  dielectric materialId used on two wall targets realized to one shared
  native instance, while the value-duplicate materialId (identical
  appearance, different ID) realized to a distinct native instance. No
  render call was made; no scene was saved. Seven forced-failure cases
  (Safe Scene, renderer missing, material class missing, roughness property
  unavailable, metalness property unavailable, invalid evidence, timeout)
  all failed closed with no PASS evidence.
- `test:3dsmax:canonical-golden-corona-preview`,
  `test:3dsmax:canonical-render-state-revision`,
  `test:3dsmax:golden-corona-preview`, `test:3dsmax:corona-adapter`,
  `test:3dsmax:corona-baseline`, `test:3dsmax:revision`,
  `test:3dsmax:replace-asset`, `test:3dsmax:asset-inspection`,
  `test:3dsmax:external-asset-ingestion` — all PASS unchanged (8B-8E and
  core DCC regressions unaffected by the `resolveMaterials`/adapter refactor
  or the new SceneSpec v0.3 / plan v0.2 schemas).

Target 3ds Max 2026 verification was not performed; only 2025.3 compatibility
mode is claimed. No test-owned 3ds Max process remained after the run; one
unrelated pre-existing interactive `3dsmax.exe` session (no batch/script
arguments) was observed and deliberately left untouched.

## Spike 8E canonical Golden Corona preview (local commit `79d6d24`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 160/160
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:canonical-golden-corona-preview` (new) — built canonical rev10
  through the real r2..r10 revision pipeline; compiled the plan through the
  normal `CoronaRendererAdapter.compile()` (no diagnostic profile: plan has
  no `profileId`/`intentSource`/`temporaryLight`); staged the verified
  artifact with a pre-launch raw-hash check; re-verified the fresh semantic
  manifest and canonical render-state before any renderer/material work;
  confirmed no obsolete `preview_key_area`/`AVZ_PREVIEW_CORONA_KEY`
  diagnostic light was present; reused the persisted `light_living_key_area`
  CoronaLight, renderer, and `camera_living_a` without creating, switching,
  or repositioning any of them on disk; realized canonical materials as
  temporary `_CoronaPhysicalMtl` instances with proven same-ID-to-same-
  instance deduplication; rendered a valid 320x240 four-pass PNG; produced
  `canonical-corona-preview-evidence-v0.1` evidence with
  `intentSource: "canonical_scene_spec"`; and proved canonical/staged rev10
  raw hashes unchanged, no `rev_golden_0011` created, and r10 replay
  unaffected afterward. Sixteen forced-failure cases (staged-hash tamper,
  manifest mismatch, four canonical-render-state mismatches, obsolete
  diagnostic light, camera missing/ambiguous/semantic-mismatch, material
  class/property missing, renderer missing, Safe Scene, invalid PNG, timeout)
  all failed closed with no PASS evidence and no owned process left running.
- `test:3dsmax:canonical-render-state-revision`, `test:3dsmax:corona-adapter`,
  `test:3dsmax:corona-baseline`, `test:3dsmax:golden-corona-preview`,
  `test:3dsmax:revision`, `test:3dsmax:replace-asset`,
  `test:3dsmax:asset-inspection`, `test:3dsmax:external-asset-ingestion` — all
  PASS unchanged (post-8D environment-hardening regressions remain green).

Target 3ds Max 2026 verification was not performed; only 2025.3 compatibility
mode is claimed.

## Post-8D hardening (local commit `9dd86cf`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 147/147
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:canonical-render-state-revision` — rev9 `SetRenderIntent` and
  rev10 `AddLight` PASS; `light_living_key_area` at
  `[3000,1600,2800]`/`[-35,0,0]`, canonical intensity `1.25` mapped to `150`,
  width `800`; rev8/rev9 artifacts unchanged after later revisions; r9/r10
  replay returned recorded evidence with zero mutation/verifier DCC launches.
- `test:3dsmax:corona-baseline`, `test:3dsmax:corona-adapter`,
  `test:3dsmax:golden-corona-preview` — PASS, including the actual `rt.render`
  call.
- `test:3dsmax:revision`, `test:3dsmax:replace-asset`,
  `test:3dsmax:asset-inspection`, `test:3dsmax:external-asset-ingestion`,
  `test:3dsmax:opening-revision`, `test:3dsmax:materials`,
  `test:3dsmax:material-revision`, `test:3dsmax:lock-revision`,
  `test:3dsmax:unlock-revision`, `test:3dsmax:asset-identity` — PASS.

Diagnostic ladder used to isolate the DCC environment compatibility question
(same `buildDccChildEnvironment` sanitized builder at every stage): a bare
`3dsmaxbatch` + `pymxs` probe, Corona renderer-class discovery only, Corona
renderer/`CoronaPhysicalMtl`/`CoronaLight` object realization with no render
call, then the full render-calling suites above — all PASS. This ruled out a
base-Windows-runtime or Corona-discovery problem and isolated the failure to
render time only.

Regression evidence for the environment allowlist: removing
`VRAY_FOR_3DSMAX2025_MAIN` reproduced a real (non-crash) Corona failure —
`[V-Ray] Could not read V-Ray environment variable "VRAY_FOR_3DSMAX2025_MAIN".
Please re-install` — in the Corona baseline and adapter suites, because Corona
shares Chaos's V-Ray USD/DR startup component. `VRAY_FOR_3DSMAX2025_PLUGINS`
was proven unnecessary by the same method and removed. No `ADSK_*`,
`CORONA_*_LOAD_PATH`, licensing, or benign Windows identity variable was
needed; none were added. No full parent environment was exposed to any DCC
process at any point.

Two unrelated test-harness bugs were found and fixed while running the
mandatory gate: `external-asset-ingestion-integration.ts`'s forced-DCC-failure
helper was launching 3dsmaxbatch with almost no environment (missing
`...process.env` before its forced-failure flag), and
`external-asset-ingestion.ts`'s verification-process overrides never forwarded
`AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH` to `verify_scene.py`. Both are fixed
in the same commit; production security behavior is unchanged.

A prior local crash (exception `0xC0000005`, minidump inspected for exception
code and module-basename list only — no memory or environment values
extracted) showed Corona's licensing/telemetry modules and the Windows TLS
stack loaded immediately before the fault. That dump predates the current
`VRAY_FOR_3DSMAX2025_MAIN` allowlist entry and is superseded by the evidence
above; it was not reproduced during this validation.

For local commit `7810fb9ac79898e9f0119f3e8dea693288203a71`:

- `pnpm build` — PASS
- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm test` — PASS (95 tests)
- `pnpm test:3dsmax:replace-asset` — PASS on 3ds Max 2025 compatibility mode
- `pnpm test:3dsmax:revision` — PASS
- `pnpm test:3dsmax:opening-revision` — PASS
- `pnpm test:3dsmax:materials` — PASS
- `pnpm test:3dsmax:material-revision` — PASS
- `pnpm test:3dsmax:lock-revision` — PASS
- `pnpm test:3dsmax:unlock-revision` — PASS
- `pnpm test:3dsmax:asset-identity` — PASS
- `git diff --check` — PASS before commit

ReplaceAsset evidence: verified rev7 stayed byte-preserved; rev8 preserved
`asset_living_sofa_main`, transform, material, and locks while moving from
`assetdef_sofa_proxy_standard_v1` / `[2400, 950, 780]` to
`assetdef_sofa_proxy_alternate_v1` / `[2200, 900, 760]`. One replay completed
without a second DCC mutation or verifier process.

Target DCC verification remains required for 3ds Max 2026.

## Spike 7A locally validated worktree

- `pnpm build` — PASS
- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm test:asset-trust` — PASS (7 tests; synthetic temporary bytes only)
- `pnpm test` — PASS (103 tests)
- `pnpm test:3dsmax:replace-asset` — PASS on 3ds Max 2025 compatibility mode

Coverage includes artifact/evidence schemas, duplicate registry ID rejection,
evidence binding, trust-state gating, path traversal/UNC/control-character
rejection, conditional symlink escape rejection, size/hash mutation, SceneSpec
portability, and prevention of external definitions in current build/revision
paths. Target DCC verification remains required for 3ds Max 2026.

## Local DCC opt-in safety worktree

- `pnpm build` — PASS
- `pnpm lint` — PASS
- `pnpm typecheck` — PASS
- `pnpm test` — PASS (107 tests)
- `pnpm test:3dsmax:replace-asset` without explicit opt-in — expected guarded
  failure before DCC launch
- Post-guard `3dsmax` and `3dsmaxbatch` process check — no running process

The new DCC batch argument helper uses Autodesk-supported Dialog Monitor and
Safe Scene flags. The 2025 compatibility regression was intentionally not
rerun with DCC opt-in during this safety verification; target 2026 remains
unverified.

## Spike 7B local validation

- `pnpm build` — PASS
- `pnpm typecheck` — PASS
- `pnpm lint` — PASS
- `pnpm test` — PASS (111 tests; no DCC launch)
- `pnpm test:asset-trust` — PASS (7 tests)
- `pnpm test:3dsmax:asset-inspection` — PASS on 3ds Max 2025 compatibility
  mode. A dynamically generated `2200 x 900 x 760 mm` controlled source asset
  yielded one geometry node, one StandardMaterial, floor-center pivot,
  zero external dependencies/DLLs/XRefs, and observed Safe Scene command-line
  lock. Same-length tamper, fake `.max`, and owned timeout paths were blocked.
- `pnpm test:3dsmax:revision` — PASS on 3ds Max 2025 compatibility mode.
- `pnpm test:3dsmax:replace-asset` — PASS on 3ds Max 2025 compatibility mode.

Generated source assets, quarantine roots, inspection workspaces, temporary
captures, and DCC processes were removed after validation. Target 3ds Max 2026
remains required.
