# Current Status

## Local baseline

- Local `main` HEAD: `d15bd4c`
- Commit: `feat: render golden scene from canonical camera state`
- Remote tracking state at this snapshot: local `main` is ahead of
  `origin/main` pending this session's push.

## Verified capability boundary

- Deterministic SceneSpec build and SceneChangeSet revision pipeline are in
  place through canonical Corona render-state revisions (rev9 `SetRenderIntent`,
  rev10 `AddLight`) and the first canonical material-appearance revision
  (rev11 `MigrateMaterialAppearanceContract`, SceneSpec v0.3). rev11 has now
  also been rendered as a canonical preview that reuses every persisted
  renderer-facing element as-is (8H) rather than realizing anything fresh.
- `ReplaceAsset` preserves logical object identity, transform, material, and
  locks while changing immutable `assetDefinitionId` and intrinsic geometry,
  including a controlled `VERIFIED` external `.max` source (Spike 7C).
- Fresh-process semantic manifest verification and durable idempotent replay
  are required before a candidate `.max` becomes canonical; the same pattern
  now extends to a fresh canonical render-state verification pass.
- Corona is integrated end-to-end: renderer/material/light discovery and
  realization (8A), a pure `SceneSpec -> CoronaExecutionPlan` adapter (8B), a
  non-canonical Golden preview render (8C), canonical render-state revisions
  with CoronaLight evidence (8D), a canonical Corona preview rendered from
  the already-canonical rev10 revision through the normal adapter, reusing
  the persisted renderer/light/camera without mutation (8E), and a canonical,
  renderer-neutral material *appearance* contract (`roughness`/`metalness`)
  promoted from adapter defaults into SceneSpec v0.3, compiled through a
  dedicated adapter method to Corona execution plan v0.2, and observed on
  the actual installed Corona Physical Material with proven materialId-based
  (never value-based) deduplication (8F); and that capability persisted into
  the first canonical Golden material-appearance revision, `rev_golden_0011`
  (SceneSpec v0.3), with all rev1-rev10 preserved byte-identical and three
  independent fresh-process verifiers (semantic, render-state,
  `canonical-material-state-v0.1`) required before promotion (8G); and that
  persisted rev11 state has now been rendered directly — renderer, light,
  materials, and camera all resolved/observed/reused from the verified
  `.max`, with none created — proving 8G's persistence is actually
  production-usable rather than only revision-time-verifiable (8H); the
  first deterministic camera revision, `rev_golden_0012`
  (`camera_living_a` focal length 24mm -> 28mm only; position, target,
  sensor width, and orientation policy unchanged), has been added on top of
  rev11, gated by four independent fresh-process verifiers including a new
  `canonical-camera-state-v0.1` contract, with rotation always
  worker-derived from position/target rather than trusted from the
  ChangeSet (8I); and that persisted rev12 state has now been rendered
  directly from its 28mm camera — renderer, light, materials, and camera
  all resolved/observed/reused from the verified `.max`, with none created
  — mirroring 8H's own rev11 preview but gated by a fourth pre-render
  verification layer (canonical camera state) that 8H predates (8J).
- DCC execution is default-deny end-to-end: trusted local worker configuration
  must set `allowDccExecution: true`, the call site must separately authorize
  the specific launch, and DCC integration suites additionally require
  explicit `AI_ARCHVIZ_ALLOW_DCC_TESTS=1` operator opt-in. `runControlledProcess`
  now requires an explicit `env`; there is no implicit `process.env` fallback.
- Every DCC child process receives an environment built by the shared
  `buildDccChildEnvironment` allowlist (Windows runtime keys plus the exact
  proven `VRAY_FOR_3DSMAX2025_MAIN` key) plus caller-owned `AI_ARCHVIZ_*`
  overrides only; secret and untrusted parent variables never reach a DCC
  process. See [VALIDATION.md](VALIDATION.md) for the regression evidence.
- Local DCC evidence covers 3ds Max 2025.3 compatibility mode across every
  mandatory `test:3dsmax:*` suite. Production target 3ds Max 2026 is not yet
  verified.

## Current guardrails

- SceneSpec is the canonical software-independent contract.
- Real editable 3D scenes, not generated images, are the source of truth.
- No new renderer, AI provider integration, or new spike begins without
  explicit scope authorization. The next candidate spike is authorized to
  start only when the user explicitly asks for it (see
  [NEXT_TASK.md](NEXT_TASK.md)).

## Locally validated worktree milestone

- Post-8D hardening closed three residual gaps without touching the default-
  deny model: canonical render-state evidence lights now sort by `logicalId`
  (source `SceneSpec` order is untouched); the canonical Corona preview and
  `SetRenderIntent` preparation reject non-`area` lights with
  `RENDERER_LIGHT_TYPE_UNSUPPORTED` before any DCC process launches; and every
  remaining call site that built a DCC child environment from
  `{...process.env, ...}` now goes through `buildDccChildEnvironment`.
- A staged diagnostic ladder (bare `3dsmaxbatch` probe -> Corona discovery ->
  Corona object realization -> narrow Corona render suites -> full canonical
  render-state revision suite) confirmed the sanitized environment is
  compatible with the installed 3ds Max 2025.3 + Corona toolchain, and
  regression-proved that `VRAY_FOR_3DSMAX2025_MAIN` (only; not `_PLUGINS`) is
  required because Corona shares Chaos's V-Ray USD/DR startup component.
- Spike 8E rendered the first preview whose renderer and light intent are
  both already-canonical rev10 SceneSpec state: it built rev10 through the
  real r2..r10 revision pipeline, staged the verified artifact, re-verified
  its semantic manifest and canonical render-state fresh, reused the
  persisted CoronaLight/renderer/camera without mutation, realized canonical
  materials as temporary `CoronaPhysicalMtl` with proven deduplication, and
  rendered 320x240 at a four-pass limit without saving or creating rev11.
  Sixteen forced-failure cases (hash tamper, manifest/render-state mismatch,
  obsolete diagnostic light, camera, material, renderer, Safe Scene, PNG,
  timeout) all failed closed with no PASS evidence.
- Spike 8F added `scene-spec-v0.3.schema.json` (v0.2 unchanged, no automatic
  migration, Golden rev1-rev10 untouched) and
  `corona-execution-plan-v0.2.schema.json` (v0.1 unchanged). A new
  `CoronaRendererAdapter.compileCanonicalMaterialAppearance()` method compiles
  v0.3 material `roughness`/`metalness` straight into plan v0.2 with no
  adapter-injected fallback; `compile()` itself is untouched for v0.2 sources.
  A dedicated fixture with four materials (two dielectrics, one metal, one
  value-duplicate of a dielectric under a different ID) proved the pure
  plan-compile oracle deep-equals a frozen expected plan, and a fresh
  Safe-Scene DCC process realized real Corona Physical Materials, observed
  their actual native roughness/metalness/base-color, and proved
  materialId-based deduplication in both directions (same ID shares one
  native instance; different IDs never merge by value). No render call was
  made and no scene was saved. Seven forced-failure cases (Safe Scene,
  renderer, material class, roughness/metalness property unavailable,
  invalid evidence, timeout) all failed closed.
- Spike 8G added `scene-change-set-v0.2.schema.json` (v0.1 unchanged) and its
  one operation, `MigrateMaterialAppearanceContract`: a `high`-risk,
  scene-scoped, explicit-appearance-set migration that requires every base
  material exactly once (sorted, no duplicates, no `baseColorRgb` override)
  and rejects a locked material target or a non-v0.2-to-v0.3 transition
  before any DCC launch. `rev_golden_0011`'s roughness values (wall `0.62`,
  floor `0.34`, sofa `0.78`, all `metalness: 0`) are hand-picked, not the
  8F/8B adapter default. `apply_change_set.py` reuses 8F's
  `render_corona_material_appearance.py` discovery/creation/property
  functions rather than a third mapping, replacing each pre-migration
  `AVZ_MATERIAL_{materialId}` StandardMaterial with a same-named Corona
  Physical Material; `verify_scene.py`'s native-material check now accepts
  either class, and its manifest-recovery path stores the tolerance-checked
  canonical color (not the raw Corona float32 reading) so a native-class
  change alone never produces a spurious semantic diff. The new
  `verify_canonical_material_state.py` fresh-process verifier is the third
  required promotion gate; a wall's host is a non-renderable Dummy helper
  with no real material slot, so both it and the new verifier check/assign
  material identity only on physical segments (or the single node for
  non-wall targets), matching `verify_scene.py`'s own established pattern.
  `replayRevision()`'s render-state evidence gate now also covers
  `MigrateMaterialAppearanceContract` so replay doesn't drop already-verified
  render-state evidence for a later revision built on a render-configured
  scene. Eight forced-failure cases (Safe Scene, renderer missing, material
  class missing, roughness/metalness property unavailable, deduplication
  failure, invalid evidence, evidence mismatch) all failed closed with no
  candidate promoted; rev1-rev10 remain byte-identical, and Spike 8E's own
  suite still builds/verifies rev10 only and creates no rev11.
- Spike 8H rendered the first Golden preview whose renderer, light,
  material, and camera intent are ALL already-canonical, already-persisted
  rev11 state: it compiled through `compileCanonicalMaterialAppearance()`
  (plan v0.2, never the legacy adapter default), independently re-proved all
  three rev11 verification contracts (semantic, canonical render-state,
  canonical material-state) fresh against a staged copy before rendering,
  and resolved/observed/reused the persisted Corona renderer, CoronaLight,
  native `AVZ_MATERIAL_*` Corona Physical Materials, and `camera_living_a`
  without creating, switching, or mutating any of them — the render runner
  never calls anything equivalent to `create_corona_physical_material()`.
  Camera reuse is strictly observation-only (position/FOV/orientation
  compared within tolerance, never assigned). A new
  `canonical-corona-preview-evidence-v0.2` schema (rev11,
  `sceneSpecVersion: "0.3.0"`, persisted naming/class, per-material
  canonical-vs-observed appearance, deduplication proof) sits alongside the
  untouched v0.1 (rev10, temporary realization); no rev12 was created and
  the loaded scene was never saved. 18 forced-failure cases (hash,
  manifest, render-state, material-state, diagnostic-light, camera,
  renderer, Safe Scene, PNG, timeout) all failed closed. Building this
  observation-only camera check also surfaced and fixed a latent unit bug in
  8E's own runner (`Camera.fov` is degrees in MAXScript; the adapter's
  `fovRadians` is a genuine radian value, so 8E was silently assigning a
  ~1.3° FOV to its temporary in-memory camera instead of the intended ~74°)
  — 8E's suite still passes and still renders rev10 with temporary
  realization; it was not repointed to rev11.
- Spike 8I added `scene-change-set-v0.3.schema.json` (v0.1/v0.2 unchanged)
  and its one operation, `SetCamera`: an absolute desired-camera-state
  mutation that targets an existing camera logical ID, never accepts
  `rotationEuler` from the ChangeSet (rotation is always derived from
  position/target via the new shared `camera-policy.ts` /
  `camera_policy.py` modules), and is rejected before any DCC launch for a
  coincident position/target, a non-positive focal length or sensor width,
  a missing/ambiguous camera, or a desired state identical to the current
  one. `rev_golden_0012` changes only `camera_living_a.focalLengthMm`
  (24mm -> 28mm); `camera_living_b`/`camera_living_c` and every other
  managed entry are unchanged, and rev1-rev11 remain byte-identical.
  Promotion requires four independent fresh-process verifiers (semantic,
  canonical render-state, canonical material-state, and the new canonical
  camera-state), the last of which re-derives the OBSERVED camera target
  from physical position/orientation/distance rather than trusting stored
  target metadata, and deliberately re-proves the exact degrees/radians
  boundary that caused the 8H defect (a forced regression hook still fails
  closed with `CAMERA_FOV_MISMATCH`). No render was produced in this spike.
- A post-8I closure normalized `deriveLookAtRotationEuler`/
  `look_at_rotation_euler` to the same 6-decimal precision as the Golden
  fixtures (`canonicalCameraAngle()`/`canonical_camera_angle()`), so
  `rev_golden_0012`'s `camera_living_a.transform.rotationEuler` is now
  byte-identical to rev11's rather than differing at full float precision.
  The durable statement is: rev11 -> rev12 changes
  `camera_living_a.focalLengthMm` only; position, target, orientation
  policy, sensor width, and the normalized derived rotation are unchanged.
  FOV precision (`fovRadians`/`fovDegrees`) is unaffected.
- Spike 8J rendered the first Golden preview whose renderer, light,
  material, and camera intent are all already-canonical, already-persisted
  rev12 state: it compiled through `compileCanonicalMaterialAppearance()`
  (plan v0.2, camera A at 28mm, no legacy 24mm value), independently
  re-proved all FOUR rev12 verification contracts (semantic, canonical
  render-state, canonical material-state, and the new canonical
  camera-state) fresh against a staged copy before rendering, and
  resolved/observed/reused the persisted Corona renderer, CoronaLight,
  native `AVZ_MATERIAL_*` Corona Physical Materials, and the 28mm
  `camera_living_a` without creating, switching, or writing to any of
  them. The render runner never writes `camera.pos`/`camera.rotation`/
  `camera.fov`/`camera.targetDistance`; it reuses
  `verify_canonical_camera_state.py` (Spike 8I's own fresh-process
  verifier) rather than a second independent FOV/look-at formula. A new
  `canonical-corona-preview-evidence-v0.3` schema (rev12,
  `sceneSpecVersion: "0.3.0"`, canonical-vs-observed camera
  position/target/rotation/FOV) sits alongside the untouched v0.1 (rev10)
  and v0.2 (rev11); no `rev_golden_0013` was created and the loaded scene
  was never saved. 22 forced-failure cases across all four verification
  layers (hash, manifest, render-state, material-state, camera-state
  including the mandatory FOV-regression proof, diagnostic-light, camera,
  renderer, Safe Scene, PNG, timeout) all failed closed.
- Target 3ds Max 2026 verification has not occurred on this workstation.

See [VALIDATION.md](VALIDATION.md) for executed checks and
[NEXT_TASK.md](NEXT_TASK.md) for the next allowed action.
