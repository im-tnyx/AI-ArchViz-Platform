# Latest Validation Evidence

## Post-10A CAD path containment closure (local commit `f51ea5a`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 453/453, including 16 new in
  `tests/unit/cad-path-containment.test.ts` using REAL links (Windows
  directory junctions on this workstation; directory symlinks on POSIX; not
  skipped): nested real source PASS with frozen hashes; parent-junction
  source escape, garbage outside bytes never parsed, deeper intermediate
  escape; inside-root intermediate link allowed; root reached through a
  link compared by realpath; final-entry link rejected (file symlink where
  the OS permits it; unelevated Windows refuses file symlinks with EPERM,
  so the final entry here was a junction reparse point); broken link
  (`CAD_SOURCE_PATH_INVALID`) vs plain missing (`CAD_SOURCE_NOT_FOUND`);
  lexical checks kept; nonexistent nested output and output root created;
  parent-junction output escape with nothing created outside; escape
  through a nested output link; evidence destination validated before any
  write; inside-root output link allowed; no raw errno codes exposed.
- Old-code proof: with the pre-closure lexical-only `cad-extraction.ts`
  restored, 11 of the 16 tests fail, including the source and output
  parent-junction escapes; restoring the fix returns 16/16.
- `pnpm test:asset-trust` — 7/7
- Frozen 10A oracle unchanged: `sourceHash`
  `sha256:f761c38d…156f`, `cadDocumentHash` `sha256:95f0c90d…8b70`,
  the expected document, and the evidence (52/52 10A tests unchanged).
- Real `extract-cad` CLI: the fixture PASSes into `.workspace/` with the
  frozen hashes; live junction probes under `.workspace/` fail with
  `CAD_OUTPUT_PATH_INVALID` (output) and `CAD_SOURCE_PATH_INVALID`
  (source), the outside directory stays empty, and the probe links were
  removed.

DCC: NO DCC TEST REQUIRED — DCC PATH UNCHANGED. `resolveWithinRoot()` is
byte-identical; the new helpers are used only by the CAD boundary.

## Spike 10A deterministic DXF extraction (local commit `af96b94`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 437/437, including 52 new in
  `tests/unit/cad-dxf-extraction.test.ts`: the synthetic
  `tests/fixtures/cad/dxf/simple-room-mm.dxf` deep-equals the frozen
  `expected-cad-document-v0.1.json` (frozen `sourceHash` and
  `cadDocumentHash`); byte hash vs semantic hash; one-byte change; header
  provenance with null for absent values; code-point layer order; LINE,
  LWPOLYLINE bulge, INSERT (no explosion), inert TEXT; MTEXT/DIMENSION/
  ATTRIB/SEQEND/CIRCLE recorded as unsupported; every ordinal accounted
  for; XREF recorded without its path; no architectural keys; repeated
  extraction; input bytes unchanged; line-ending independence apart from
  the byte hash; entity-order and layer-order behavior; two different
  source paths give deep-equal output with no path; inches/feet/cm/m
  convert to the exact mm geometry, dimensionless values unscaled;
  unitless/absent/unsupported units; 13 malformed-input cases, invalid
  UTF-8, non-finite numbers; binary signature and NUL; oversize input
  rejected before parsing; OCS extrusion and INSERT arrays unsupported;
  evidence schema, worker error mapping, source/output path policy, and
  static purity guards (cad-parser and the worker CAD boundary import no
  DCC, process, network, or renderer module). Mutation checks: removing
  unit scaling, dropping unsupported entities, removing the NUL check, or
  removing layer sorting fails 6, 8, 1, and 8 tests respectively.
- `pnpm test:asset-trust` — 7/7
- `extract-cad` CLI: the fixture writes document + evidence under
  `.workspace/`; `..` source and escaping output paths fail with
  `CAD_SOURCE_PATH_INVALID` / `CAD_OUTPUT_PATH_INVALID`.

DCC: NO DCC TEST REQUIRED — DCC PATH UNCHANGED. No Python, DCC execution,
revision, render, or asset-ingestion module changed; `cli.ts` and
worker-contracts gained additive entries only.

## Spike 9D canonical circulation requirement enforcement (local commit `d0263aa`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 385/385, including 30 new in
  `tests/unit/circulation-requirement-revision.test.ts`: ChangeSet v0.4
  contract and single-op invariant; exact Golden requirement; rev12 to rev13
  exact transition with frozen `requirementSetHash`; plan v0.1-v0.3
  compatibility; zero semantic diff; migration failure codes; frozen rev13
  evidence (graph hash equal to rev12); rev1-rev12 hashes frozen; no rev14;
  enforcement fixture gate cases (NO_ROUTE, ENDPOINT_BLOCKED,
  PORTAL_BLOCKED, unrelated portal plans, spatial collision still wins);
  UpdateOpening narrowing blocked; window/SetCamera edits plan; a move that
  plans on v0.3 rev12 is ENDPOINT_BLOCKED on rev13; `applySceneChangeSet`
  and external preflight reject with zero DCC; material/camera evidence
  v0.1 vs v0.2 dispatch; circulation promotion-failure mapping. Mutation
  checks: removing the planner gate fails 7 tests, removing the external
  gate fails 2.
- `pnpm test:asset-trust` — 7/7
- SceneSpec v0.1-v0.4 schemas, SceneChangeSet v0.1-v0.3 schemas, material/
  camera-state v0.1 schemas, and Golden rev1-rev12 fixtures show no diff.

DCC gates, all PASS on 3ds Max 2025 compatibility mode (2025.3 install),
run sequentially with `AI_ARCHVIZ_ALLOW_DCC_TESTS=1`:

- `test:3dsmax:canonical-circulation-requirement-revision` (new): r1-r12
  built through the real pipeline, r13 promoted after fresh semantic,
  render-state v0.1, material-state v0.2, camera-state v0.2, and
  circulation evidence gates; rev12 artifact unchanged; replay with zero
  processes; 12 forced failures (unsupported plan, wrong scene target,
  managed-ID mismatch, Safe Scene, candidate save, mutation timeout,
  manifest, render-state, material-state v0.2, camera-state v0.2,
  circulation evidence invalid/failed) all fail closed.
- `test:3dsmax:canonical-camera-revision`,
  `test:3dsmax:canonical-golden-corona-preview-rev12`,
  `test:3dsmax:revision`, `test:3dsmax:replace-asset`,
  `test:3dsmax:external-asset-ingestion`,
  `test:3dsmax:canonical-material-appearance-revision`,
  `test:3dsmax:canonical-golden-corona-preview-rev11`.

The first matrix run was stopped by the operator after the first two
suites (interactive 3ds Max sessions were hanging; the machine was
restarted); the remaining six suites were then re-run from scratch and
passed first time. The interrupted rev12 preview's non-zero exit was the
deliberate stop, not a test failure. Interactive user 3ds Max sessions
were not touched.

Target 3ds Max 2026 was not tested.

## Spike 9C canonical circulation requirement contract (local commit `40e1c38`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 355/355, including 33 new in
  `tests/unit/circulation-requirements.test.ts`: v0.4 = v0.3 + additions
  only; fixture validity; v0.4 requires the field (empty array valid);
  v0.3 rejects it; unknown versions rejected; v0.4 asset identity kept;
  every historical SceneSpec valid, unmigrated, rev12 still v0.3, no
  rev13; v0.1 still accepted; no SceneChangeSet circulation operation;
  every structural rule (missing space/opening, window portal,
  missing/non-wall host, door owned by another space with identical XY,
  duplicate IDs, unsorted, identical endpoints, pinned policy/type/kinds,
  3D/NaN/Infinity points, severity); blocked-point and no-route scenes
  remain valid; frozen PASS baseline evidence and hashes; portal endpoint
  equals the 9B portal and node; `CIRCULATION_NO_ROUTE`,
  `CIRCULATION_ENDPOINT_BLOCKED`, `CIRCULATION_PORTAL_BLOCKED`; an
  unrelated blocked portal leaves requirements SATISFIED; source-spatial-
  invalid fails closed; stacked-space isolation; determinism; reordered
  inputs; immutability; 9B reuse; no revision/ingestion enforcement.
- `pnpm test:asset-trust`
- Golden rev1-rev12, v0.1-v0.3 SceneSpec schemas, all SceneChangeSet
  schemas, existing evidence schemas, and `revision.ts` show no diff.

DCC gates, all PASS first run on 3ds Max 2025 compatibility mode (2025.3
install) through the centralized `threeDsMaxBatchArguments()` policy:
`test:3dsmax:revision`, `test:3dsmax:replace-asset`,
`test:3dsmax:canonical-camera-revision`,
`test:3dsmax:canonical-golden-corona-preview-rev12`. They ran alongside
three unrelated interactive 3ds Max 2025 sessions, which were not touched.

Target 3ds Max 2026 was not tested.

## Post-9B circulation space-scoping closure (local commit `8e5808b`)

Correctness closure within `circulation-policy-v0.1`: each space graph now
uses only 9A footprints whose canonical `spaceId` matches that space
(previously every footprint obstructed every space). 9A, all schemas, and
the policy version are unchanged; no rev13.

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 322/322, including 7 new two-space tests (identical-XY
  spaces on different levels, both isolation directions, foreign-space
  asset over a door portal, deep-equal space_a route and graph projection
  when only space_b furniture moves, partially overlapping boundaries, a
  footprint naming a missing space, reordered spaces/assets/definitions/
  geometry/openings). Six of the seven fail against the previous global
  obstacle list. All existing 9B Golden values (1394 nodes, 5126 edges,
  component `space_living_main::3::3`, portal node `::8::16`, route
  4182.842712 mm / 39 + 2 steps, frozen `graphSemanticHash`) are
  unchanged.
- `pnpm test:asset-trust`

DCC gates, all PASS first run on 3ds Max 2025 compatibility mode (2025.3
install) through the centralized `threeDsMaxBatchArguments()` policy:
`test:3dsmax:revision`, `test:3dsmax:replace-asset`,
`test:3dsmax:canonical-golden-corona-preview-rev12`.

Target 3ds Max 2026 was not tested.

## Spike 9B deterministic circulation graph (local commit `7ed0fee`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 315/315 (32 new in `tests/unit/circulation.test.ts`:
  frozen constants; Golden rev12 analysis PASS with frozen counts, portal
  node, and `graphSemanticHash`; Golden portal route (39 orthogonal + 2
  diagonal steps, 4182.842712 mm); 500 mm gap `NO_ROUTE` while 9A PASSes
  vs 1000 mm gap route; rotated OBB with an AABB-only counterexample;
  concave L-space; flush-furniture and narrow-door `PORTAL_BLOCKED`;
  endpoint blocked/unresolvable/unknown space; stable components; a
  proven equal-cost mirrored-route tie-break; reordered-input determinism;
  input immutability; source-spatial-invalid; compact schema-valid
  evidence; a 9A-valid `MoveObject` still planning despite blocking the
  portal; purity boundary; no corner cutting; swept-segment edge
  clearance). Removing the edge-clearance check or the corner-cutting
  rule was confirmed to fail tests. All 9A tests unchanged and PASS.
- `pnpm test:asset-trust`

DCC gates, all PASS first run on 3ds Max 2025 compatibility mode
(2025.3 install, `AI_ARCHVIZ_ALLOW_DCC_TESTS=1`), launched through the
centralized `threeDsMaxBatchArguments()` policy:

- `test:3dsmax:revision`, `test:3dsmax:replace-asset`,
  `test:3dsmax:canonical-golden-corona-preview-rev12` (28mm camera
  observed not mutated, no rev13).

Target 3ds Max 2026 was not tested.

## Post-8J DCC batch launch policy closure (local commit `0160de6`)

Structural hardening only: eleven worker modules with private
`batchArguments()` copies now call the shared `threeDsMaxBatchArguments()`;
flags, environment policy, authorization, and Python scripts are unchanged.

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 283/283, including a new static guard that fails if a
  `-safescene`/`-dm`/`-silent` literal appears outside `dcc-batch.ts` or any
  `batchExecutablePath` launch uses another argument builder (confirmed to
  fail when one local helper was temporarily restored)
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 compatibility mode
(`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`), first run, no retries:

- `test:3dsmax:canonical-golden-corona-preview-rev12` (8J),
  `-rev11` (8H), `test:3dsmax:canonical-golden-corona-preview` (8E),
  `test:3dsmax:corona-adapter`, `test:3dsmax:corona-baseline`,
  `test:3dsmax:corona-material-appearance`, `test:3dsmax:asset-inspection`,
  `test:3dsmax:external-asset-ingestion`, `test:3dsmax:golden-corona-preview`
- 8J still reports rev12 source, persisted 28mm camera observed not
  mutated, four verification layers, no light/material creation, no rev13.

Target 3ds Max 2026 was not tested.

## Spike 9A deterministic spatial placement validation (local commit `a5d4f9a`)

Static gates, all PASS:

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `git diff --check`
- `pnpm test` — 282/282 (42 new tests: 22 pure spatial-engine tests covering
  Golden rev12 PASS, sofa/coffee-table collision, boundary crossing vs.
  boundary touching, rotated-OBB correctness with an explicit AABB
  false-positive guard, doorway access-clearance blocking vs. touching,
  unsupported roll/pitch, ReplaceAsset candidate footprint with a
  dedicated synthetic fixture, external_max dimension-only equivalence, a
  synthetic concave L-shaped space, determinism, and the
  `spatial-validation-evidence-v0.1` schema; 20 new revision-integration
  tests including MoveObject/ReplaceAsset spatial-preflight blocking with
  specific `SPATIAL_*` codes through the real `planSceneRevision` pipeline)
- `pnpm test:asset-trust`

DCC gates, all PASS on 3ds Max 2025.3 (`AI_ARCHVIZ_ALLOW_DCC_TESTS=1`):

- `test:3dsmax:revision`, `test:3dsmax:replace-asset`,
  `test:3dsmax:external-asset-ingestion`,
  `test:3dsmax:canonical-camera-revision`,
  `test:3dsmax:canonical-golden-corona-preview-rev12` — all PASS
  unchanged. These are the suites whose `MoveObject`/`ReplaceAsset`
  preflight behavior is affected by the new spatial gate (directly, or via
  a build chain that includes earlier Golden `MoveObject`/`ReplaceAsset`
  revisions); all historical Golden operations (`MoveObject` r2/r7,
  `ReplaceAsset` r8) remain spatially valid under `spatial-policy-v0.1`
  because their real geometry is actually valid — no fixture was altered
  and no revision was grandfathered by ID to make this pass.
- A transient environmental failure was encountered and ruled out during
  this spike's DCC validation: the first run of
  `canonical-camera-revision` failed with `PROCESS_EXIT_NONZERO` at the
  rev11 `MigrateMaterialAppearanceContract` mutation step — an operation
  type Spike 9A does not touch at all. No stray or runaway process was
  found on retry (unlike the `find.exe` incident during the post-8I
  closure), and a clean re-run of both affected suites passed cleanly with
  no code changes, confirming this was a one-off environmental hiccup
  rather than a regression.

The pure engine was also spot-verified by direct execution against the
real `rev_golden_0012` fixture (not just via the test runner) before the
test suite was written, confirming exactly 3 supported asset footprints,
1 doorway clearance, and 0 violations, with hand-verified corner/rotation
arithmetic for the rotated sofa and the `opening_d01` clearance zone.

Target 3ds Max 2026 verification was not performed; only 2025.3
compatibility mode is claimed. No test-owned 3ds Max process remained
after the run.

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
