# Latest Validation Evidence

## Spike 8J canonical Golden Corona preview from rev12 camera state (local commit `d15bd4c`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 254/254 (19 new tests, including a static-source proof that
  the runner imports/calls no material-creation, camera-creation, or
  camera-mutation primitive)
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:canonical-golden-corona-preview-rev12` (new) — built
  `rev_golden_0001`-`rev_golden_0012` through the real revision pipeline
  (base + r2..r12, including 8I's `SetCamera`); compiled the staged rev12
  SceneSpec through `compileCanonicalMaterialAppearance()` to plan v0.2
  (camera A `focalLengthMm: 28`, `fovRadians≈1.1426749596672536`, no legacy
  24mm value; wall/floor/sofa roughness `0.62`/`0.34`/`0.78`, all
  `metalness: 0`, matching 8G/8H exactly); a fresh Safe-Scene process
  independently re-verified the staged copy against all FOUR rev12
  contracts (semantic manifest, canonical render state, canonical material
  state, canonical camera state — the last new to this spike, verifying all
  three canonical cameras sorted by `logicalId`) before ever calling
  render; resolved the persisted production Corona renderer, the persisted
  `light_living_key_area` CoronaLight, and all three persisted
  `AVZ_MATERIAL_*` Corona Physical Materials purely by observation (no
  creation, no reassignment); confirmed material deduplication in both
  directions; resolved the persisted `camera_living_a` node purely to
  obtain a render handle — no write to `camera.pos`/`camera.rotation`/
  `camera.fov`/`camera.targetDistance` occurred, and its physical FOV
  (~65.47deg / ~1.1427rad) and orientation were proven fresh one layer
  earlier by `verify_canonical_camera_state.py` (reused verbatim from Spike
  8I, not re-derived); confirmed `camera_living_b`/`camera_living_c`
  unchanged; rendered a valid 320x240 four-pass PNG; produced
  `canonical-corona-preview-evidence-v0.3` with `revisionId:
  "rev_golden_0012"` and canonical-vs-observed camera
  position/target/rotation/FOV recorded side by side; and proved
  canonical/staged rev12 raw hashes unchanged, no `rev_golden_0013`
  created, and rev12 replay unaffected afterward. 22 forced-failure cases
  (staged-hash tamper, manifest mismatch, Safe Scene, four
  canonical-render-state mismatches, four canonical-material-state
  mismatches, six canonical-camera-state mismatches — camera missing,
  wrong class, the mandatory FOV degrees-as-radians regression, orientation
  mismatch, target mismatch, invalid evidence — obsolete diagnostic light,
  camera ambiguity, renderer missing, invalid PNG, timeout) all failed
  closed with no PASS evidence and no owned process left running.
- `test:3dsmax:canonical-camera-revision` (8I),
  `test:3dsmax:canonical-golden-corona-preview-rev11` (8H),
  `test:3dsmax:canonical-material-appearance-revision` (8G),
  `test:3dsmax:corona-material-appearance` (8F),
  `test:3dsmax:canonical-golden-corona-preview` (8E),
  `test:3dsmax:canonical-render-state-revision` (8D),
  `test:3dsmax:golden-corona-preview` (8C), `test:3dsmax:corona-adapter`
  (8B), `test:3dsmax:corona-baseline` (8A), `test:3dsmax:revision`,
  `test:3dsmax:replace-asset`, `test:3dsmax:asset-inspection`,
  `test:3dsmax:external-asset-ingestion` — all PASS unchanged. In
  particular, `canonical-golden-corona-preview-rev11` (8H) still
  builds/verifies `rev_golden_0011` at 24mm only, still performs
  observation-only camera reuse with no fourth verification layer, and
  creates no `rev_golden_0012`, so it remains historical coverage rather
  than being superseded or repointed.

No new defects were found this spike; the runner design deliberately reused
8I's `verify_canonical_camera_state.py` and 8H's render-runner structure
rather than introducing a second independent camera-observation path, which
avoided reproducing either the Spike 8H degrees/radians defect or the
Spike 8I `targetDistance`/cross-runtime-`hypot()` issues a third time.

Target 3ds Max 2026 verification was not performed; only 2025.3
compatibility mode is claimed. No test-owned 3ds Max process remained after
the run; the two previously-observed interactive `3dsmax.exe` sessions had
already exited by the time this spike's DCC validation ran.

## Post-8I canonical camera precision closure (local commit `662abfa`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 235/235 (4 new tests: repeated-call determinism, a
  focal-length-only-change orientation-identity check, and
  `canonicalCameraAngle`'s exact 6-decimal rounding)
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:canonical-camera-revision` — re-ran end to end with the
  normalized `deriveLookAtRotationEuler`/`look_at_rotation_euler`: fresh
  semantic-manifest verification now reports exactly one changed field for
  `camera_living_a` (`focalLengthMm` only), 13 unchanged, 0 added, 0
  removed; canonical render-state, material-state, and the four-verifier
  promotion gate, all 11 forced-failure cases (including the `fov_regression`
  hook that still fails closed with `CAMERA_FOV_MISMATCH`), rev11
  immutability, and idempotent replay all remained PASS unchanged from 8I.
- `test:3dsmax:canonical-golden-corona-preview-rev11` (8H) and
  `test:3dsmax:canonical-golden-corona-preview` (8E) — both PASS unchanged;
  neither consumes `deriveLookAtRotationEuler`, so this closure does not
  touch their camera handling.

Root cause: `deriveLookAtRotationEuler()`/`look_at_rotation_euler()`
returned full float precision, while rev11's hand-authored
`camera_living_a.transform.rotationEuler` was rounded to 6 decimal places.
Deriving the same physical orientation from the same unchanged
position/target therefore produced a numerically different (but physically
identical) value, making a focal-length-only `SetCamera` revision falsely
report an unrelated `transform.rotationEuler` semantic diff. Fixed by adding
`canonicalCameraAngle()`/`canonical_camera_angle()` (round to 6 decimal
places) to the shared camera-policy modules and applying it inside the
look-at derivation itself, so every caller gets the normalized value with no
per-call rounding responsibility. `rev_golden_0012`'s `scene-spec.json` and
`expected-scene-manifest.json` were regenerated from the fixed derivation;
`camera_living_a.transform.rotationEuler` in rev12 is now byte-identical to
rev11's `[-2.84471, 0, 206.565051]`. FOV precision
(`fovRadians`/`fovDegrees`) was deliberately left unrounded — this closure
is scoped to Euler-angle serialization only.

A transient environmental issue was encountered and resolved during this
closure's DCC validation, unrelated to the fix itself: two consecutive
`canonical-camera-revision` runs failed with `PROCESS_TIMEOUT` even though
the underlying 3ds Max script logged "Task Completed Successfully" well
within the 180s wall-clock budget. Diagnosis found an unrelated, foreign
`find.exe / -path */supabase-*/...` process that had been running since
11:28 AM, had consumed roughly 32,000 CPU-seconds scanning the entire
filesystem root, and was starving the DCC batch process's exit/cleanup
phase of CPU. This process was not owned by this repository or session; it
was terminated only after explicit user confirmation. All three suites
passed cleanly on the following run with no code changes.

Target 3ds Max 2026 verification was not performed; only 2025.3
compatibility mode is claimed. No test-owned 3ds Max process remained after
the run; both previously-observed interactive `3dsmax.exe` sessions had
exited by the time this closure's validation completed.

## Spike 8I canonical camera revision (local commit `1792183`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 231/231
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:canonical-camera-revision` (new) — built `rev_golden_0001`-
  `rev_golden_0011` through the real revision pipeline, then applied
  `SetCamera` (position/target/sensor width/orientation policy unchanged,
  `focalLengthMm` 24 -> 28) to produce `rev_golden_0012`: mutation resolved
  `camera_living_a` by `AIArchViz.LogicalObjectId`, required its actual
  class to be `Freecamera`, wrote position/derived rotation/target
  distance/FOV in that order (FOV written in degrees via
  `camera_policy.fov_degrees`, never the raw radian value), and updated only
  the worker-owned camera metadata; the camera object's own identity was
  never deleted or recreated. Fresh semantic-manifest verification reported
  exactly one changed entry (`camera_living_a`: `focalLengthMm` and, at the
  time this evidence was captured, the full-precision recomputed
  `transform.rotationEuler` — see "Post-8I canonical camera precision
  closure" above, which normalizes this to `focalLengthMm` only), 13
  unchanged, 0 added, 0 removed. Fresh canonical render-state and canonical
  material-state verification both reported the unchanged Corona
  `preview` intent, `light_living_key_area`, and all three v0.3 materials.
  The new `verify_canonical_camera_state.py` independently re-observed all
  three canonical cameras (sorted by `logicalId`): `camera_living_a`'s
  position, look-at-derived orientation, and FOV (~65.47deg / ~1.1427rad)
  matched the canonical plan within tolerance, its OBSERVED target was
  reconstructed from physical position/orientation/canonical target
  distance (never a raw `node.targetDistance` read, which is unreliable for
  a Freecamera) and matched canonical intent, and `camera_living_b`/
  `camera_living_c` were confirmed byte-for-byte unchanged from rev11.
  `rev_golden_0011` was byte-unchanged after the r12 mutation; replay
  returned all four evidence records (semantic, render-state,
  material-state, camera-state) without relaunching any DCC process; no
  `rev_golden_0013` was created. Compiling `rev_golden_0012` through
  `CoronaRendererAdapter.compileCanonicalMaterialAppearance()` confirmed the
  camera A plan entry carries `focalLengthMm: 28` and
  `fovRadians≈1.1426749596672536` with no legacy 24mm value anywhere in the
  serialized plan. Eleven forced-failure cases (camera missing, camera wrong
  class, position/rotation/target-distance/FOV write failure, Safe Scene,
  a simulated FOV degrees-as-radians regression, an orientation mismatch, a
  target mismatch, and invalid camera-state evidence) all failed closed
  with no candidate promoted.
- `test:3dsmax:canonical-golden-corona-preview-rev11`,
  `test:3dsmax:canonical-material-appearance-revision`,
  `test:3dsmax:corona-material-appearance`,
  `test:3dsmax:canonical-golden-corona-preview`,
  `test:3dsmax:canonical-render-state-revision`,
  `test:3dsmax:golden-corona-preview`, `test:3dsmax:corona-adapter`,
  `test:3dsmax:corona-baseline`, `test:3dsmax:revision`,
  `test:3dsmax:replace-asset`, `test:3dsmax:asset-inspection`,
  `test:3dsmax:external-asset-ingestion` — all PASS unchanged. In
  particular, `canonical-golden-corona-preview-rev11` (8H) still
  builds/verifies `rev_golden_0011` at 24mm only, still performs
  observation-only camera reuse, and creates no `rev_golden_0012`, so it
  remains unaffected by 8I's new revision.

Two real defects were found and fixed against real 3ds Max evidence during
this spike: `Freecamera.targetDistance` is settable via pymxs (used since
Spike 1B) but not reliably readable back for that class, so
`verify_canonical_camera_state.py` never reads it — it reconstructs the
observed target from the genuinely-observable position/orientation combined
with the already-known canonical target distance instead. Separately, JS
`Math.hypot()` and Python `math.hypot()` compute the same distance with
different internal scaling and disagreed at the ~13th significant digit,
which failed the exact cross-process `targetDistanceMm` evidence comparison
for two of the three cameras; both languages' `targetDistanceMm`/
`target_distance_mm` now round to 6 decimal places, eliminating the
discrepancy without any loss of meaningful precision.

A precision nuance was identified here (rev11's hand-authored
`camera_living_a.transform.rotationEuler` was rounded to ~6 significant
figures, while `deriveLookAtRotationEuler` produced full float precision,
making the rev11 -> rev12 semantic diff report both `focalLengthMm` and
`transform.rotationEuler` as changed even though the physical orientation
was unchanged) and was, at the time, accepted rather than fixed. It was
subsequently closed without touching the immutable rev11 fixture — see
"Post-8I canonical camera precision closure" above, which normalizes the
look-at derivation itself so the rev11 -> rev12 diff now reports
`focalLengthMm` only. `assertRevisionDiff`'s `SetCamera` branch still
permits `transform.rotationEuler` as an allowed changed field, since a real
position/target change (not exercised by the Golden fixture) legitimately
changes the derived orientation.

Target 3ds Max 2026 verification was not performed; only 2025.3
compatibility mode is claimed. No test-owned 3ds Max process remained after
the run; two unrelated interactive `3dsmax.exe` sessions (no batch/script
arguments) were observed during this session and deliberately left
untouched.

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
