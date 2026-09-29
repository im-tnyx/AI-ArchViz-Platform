# Active Contracts

## Canonical schemas

- SceneSpec v0.2:
  `packages/scene-spec/schema/scene-spec-v0.2.schema.json`
- SceneChangeSet v0.1:
  `packages/scene-spec/schema/scene-change-set-v0.1.schema.json`
- Worker contracts:
  `packages/worker-contracts/schema/`

## Identity and revisions

- `logicalId` identifies a scene object and remains stable across revisions.
- `assetDefinitionId` identifies immutable intrinsic proxy data; it is not a
  scene-object identity.
- Asset definitions own category, dimensions, pivot policy, and scale policy.
- Asset instances own placement, material assignment, and property locks.
- Revision operations must use a verified base revision and produce a distinct
  target revision.

## ReplaceAsset subset

- Procedural `ReplaceAsset` (targeting a `procedural_proxy` asset definition)
  remains supported, unchanged since the Spike 1B/7A groundwork.
- Spike 7C additionally proved a **controlled** `ReplaceAsset` path onto an
  already-`VERIFIED` `external_max` asset definition. It is gated by all of:
  a trusted worker-controlled asset-definition catalog; immutable
  `artifactId` binding; `VERIFIED` trust state; matching successful inspection
  evidence; exact trusted-root containment; `byteLength` + SHA-256
  revalidation; worker-controlled staging with a staged-copy rehash; Safe
  Scene; an isolated candidate revision; fresh second-process semantic
  verification; and promotion only after that verification's `PASS`. This is
  a controlled verified-ingestion contract, not general production-readiness
  for arbitrary external `.max` assets.
- Operation parameters are exactly `newAssetDefinitionId` and
  `placementPolicy: "preserve_anchor"` for both source types. The operation
  cannot carry a path, URL, artifact-hash override, trust-state override,
  script, or executable data.
- Category and pivot policy must match; non-uniform scale and spatial fit are
  validated before DCC launch.
- Geometry lock blocks replacement. Transform and material locks do not block
  it because those properties are preserved.
- Fresh DCC verification must observe actual dimensions and persisted
  metadata, not only planned JSON.

## External asset trust boundary (Spike 7A)

- `external_max` SceneSpec definitions require a structural `artifactId`.
  Procedural proxy definitions forbid it. Neither source type carries a path,
  URL, command, storage key, or raw binary hash in SceneSpec.
- Artifact and inspection evidence contracts are versioned under
  `packages/worker-contracts/schema/`. A `VERIFIED` artifact requires passing
  evidence bound to exactly the same artifact ID and byte SHA-256.
- `trustedAssetRoot` and registry storage keys are worker-only. The resolver
  canonicalizes both and verifies file type, exact size, and SHA-256 before an
  internal path may be returned. It never invokes a DCC.
- Spike 7A itself defined only this eligibility/resolver boundary; it did not
  open, import, merge, execute, or render an external `.max` file. Initial
  Golden compilation (`build-plan.ts`) still rejects any non-`procedural_proxy`
  definition today — that boundary is unchanged. Controlled staging import
  onto an existing verified revision was later proved for `ReplaceAsset` only,
  in Spike 7C (see the `ReplaceAsset subset` section above).

## Isolated external `.max` inspection (Spike 7B)

- The internal inspection job contains only version, `artifactId`, exact
  `artifactSha256`, and `3ds_max` format. It never accepts a path, storage key,
  script, command, plug-in path, or output path.
- Only exact `QUARANTINED` bytes may resolve for inspection. The same root,
  containment, regular-file, extension, size, and SHA-256 checks remain in
  force. Production resolution remains `VERIFIED`-only.
- The trusted inspector runs in a fresh non-admin 3ds Max Batch process. Safe
  Scene must be observed enabled, command-line locked, and script-asset
  protected; no unobserved or weakened posture promotes trust.
- Passing evidence records normalized units, bounds, pivot, scene/material
  counts, and dependency counts. Raw source-machine paths are not evidence.
- Spike 7B itself defined pure worker-owned promotion (`QUARANTINED` plus
  matching policy-clean passing evidence to `VERIFIED`) and did not perform a
  production merge. Golden compilation remains procedural-proxy-only; the
  `VERIFIED` artifacts this spike produces are what Spike 7C's controlled
  `ReplaceAsset` path (above) later consumed.

## DCC execution safety

- DCC discovery is read-only. DCC execution is disabled unless trusted local
  worker config explicitly sets `allowDccExecution: true`; job inputs cannot
  enable it.
- All local DCC integration suites require
  `AI_ARCHVIZ_ALLOW_DCC_TESTS=1` before creating their DCC-enabled test
  configuration. Without it, the suite exits before any 3ds Max process starts.
- `runControlledProcess` requires an explicit `env`; there is no
  `process.env` fallback. Every DCC call site builds that environment with
  `buildDccChildEnvironment` (`apps/worker/src/dcc-environment.ts`): a fixed,
  case-insensitive Windows-runtime-plus-exact-vendor-key allowlist, plus only
  the specific `AI_ARCHVIZ_*` overrides that call site owns. No wildcard
  prefix (`AI_ARCHVIZ_*`, `VRAY_*`, `ADSK_*`, `CORONA_*`) is copied from the
  parent process.
- Every 3ds Max Batch launch obtains its arguments from the single
  `threeDsMaxBatchArguments()` (`apps/worker/src/dcc-batch.ts`):
  `[scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"]`, never `-silent`
  (a `3dsmax.exe` flag, not a batch flag). No other worker source may
  construct these flags; a static guard in
  `tests/unit/worker-foundation.test.ts` fails if a flag literal appears
  outside `dcc-batch.ts` or any `batchExecutablePath` launch uses another
  argument builder.

## Corona rendering (Spikes 8A-8D)

- `corona-renderer-policy.ts` is the single source for canonical Corona
  mapping constants: only `area` SceneSpec lights are canonical
  (`isSupportedCanonicalCoronaLightType`), intensity maps at a fixed
  `coronaCanonicalIntensityScale` (120), width is fixed at
  `coronaCanonicalAreaLightWidthMm` (800mm), and canonical evidence lights
  sort by `logicalId` (`sortCanonicalCoronaLights`) without mutating
  `SceneSpec` source order. `corona-renderer-adapter.ts` and the canonical
  render-state path in `revision.ts` both consume this module; they must not
  duplicate its constants or ordering logic.
- A `SceneSpec` with `render.engine === "corona" && render.mode === "preview"`
  containing a non-`area` light is rejected pre-DCC with
  `RENDERER_LIGHT_TYPE_UNSUPPORTED` during `planSceneRevision`
  (`SetRenderIntent` preparation) and during canonical render-state evidence
  compilation. No DCC process launches for a rejected scene.
- The pure `CoronaRendererAdapter` (`corona-renderer-adapter.ts`) compiles a
  `SceneSpec` + render job into a `CoronaExecutionPlan`; the DCC-side runner
  (`render_corona_adapter.py`) only realizes that already-validated plan and
  never evaluates generated code.

## Canonical Golden Corona preview (Spike 8E)

- `canonical-golden-corona-preview-execution.ts` renders an already-canonical
  revision (currently `rev_golden_0010`) through the *normal*
  `CoronaRendererAdapter.compile()` — never `compileDiagnosticPreview()` or
  `goldenLivingCoronaPreviewProfile` (those remain 8C-only historical
  coverage). The compiled plan's `geometry` field is used only to validate
  the plan; the DCC runner opens the staged `.max` directly and never rebuilds
  geometry from it.
- The runner reuses the persisted renderer, canonical light(s), and camera
  exactly as already realized in the `.max` — it never assigns/switches the
  renderer, never creates or deletes a light, and only applies temporary
  in-memory camera normalization (never saved). An already-non-Corona
  persisted renderer, a missing/duplicate canonical light, or an obsolete
  diagnostic light (`preview_key_area` / `AVZ_PREVIEW_CORONA_KEY`) fails
  closed before any render call.
- `canonical-corona-preview-evidence-v0.1`
  (`validateCanonicalCoronaPreviewEvidence`) records
  `intentSource: "canonical_scene_spec"` (never `trusted_diagnostic_profile`),
  the rev10 identity, SceneSpec/canonical/staged artifact hashes, a
  deterministic request hash bound only to those hashes plus
  revision/camera/render policy (no absolute paths, PID, timestamp, or PNG
  hash), and the reused canonical light(s) sorted by `logicalId` via the
  shared `corona-renderer-policy.ts`.
- Rendering an already-canonical revision is execution output, not a
  SceneChangeSet transition: it must not create a new revision, change head
  revision, or mutate the canonical or staged artifact bytes. Both are raw-
  hash-verified unchanged after every run, success or failure.

## Canonical material appearance (Spike 8F)

- `scene-spec-v0.3.schema.json` is a new, separate schema
  (`sceneSpecVersion: "0.3.0"`); `scene-spec-v0.2.schema.json` is byte-for-byte
  unchanged and Golden `rev_golden_0001`-`rev_golden_0010` remain v0.2.
  `validateSceneSpec()` dispatches on `sceneSpecVersion` (`"0.1.0"` /
  `"0.2.0"` / `"0.3.0"`); there is no automatic v0.2-to-v0.3 migration and no
  fallback if a v0.3 material omits `roughness` or `metalness` — it is a
  schema failure.
- v0.3 material `roughness` and `metalness` are renderer-neutral, normalized
  `0..1`: `roughness` is micro-surface roughness intent (`0` smooth, `1`
  rough), `metalness` is metallic-workflow intent (`0` dielectric, `1`
  metal). Neither is IOR, specular level, or reflection. `baseColorRgb` is
  unchanged from v0.2.
- `corona-execution-plan-v0.2.schema.json` is a new, separate schema
  (`planVersion: "0.2.0"`); `corona-execution-plan-v0.1.schema.json` is
  unchanged and still produced by `compile()` for a v0.2 SceneSpec, filling
  material appearance from the legacy `coronaAdapterMaterialDefaults`
  compatibility constant (roughness `0.45`, non-metal). A separate
  `CoronaRendererAdapter.compileCanonicalMaterialAppearance()` method accepts
  only a v0.3 SceneSpec and compiles it to plan v0.2, whose `materials`
  entries carry canonical `roughness`/`metalness` directly from SceneSpec and
  whose `adapterDefaults` has no `material` sub-object at all (no fallback is
  possible even in principle).
- Material identity for realization and deduplication is always
  `materialId`, never appearance-value equality (`resolveMaterialAssignments`
  in `corona-renderer-adapter.ts`, shared by both plan v0.1 and v0.2
  material resolution): the same `materialId` on multiple targets realizes
  to one shared native Corona Physical Material instance; two distinct
  `materialId`s with byte-identical appearance always realize to two
  distinct native instances.
- The DCC runner (`render_corona_material_appearance.py`) is a capability
  proof only — no render call, no scene save. It maps `roughness` to the
  discovered Corona roughness property and `metalness` to whichever native
  representation the installed Corona Physical Material actually exposes (a
  scalar property, or an enum mode for exact `0`/`1`); an installation
  exposing neither fails closed with
  `CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED` /
  `CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED` rather than emulating it.
  `corona-material-appearance-evidence-v0.1` records canonical vs. observed
  `baseColorRgb`/`roughness`/`metalness` per material plus a
  `sameIdSharedInstance`/`differentIdDistinctInstances` deduplication proof.

## Canonical material appearance revision (Spike 8G)

- `scene-change-set-v0.2.schema.json` is a new, separate schema
  (`schemaVersion: "0.2.0"`); `scene-change-set-v0.1.schema.json` is
  byte-for-byte unchanged and every existing Golden changeset fixture still
  validates against it. `validateSceneChangeSet()` dispatches on
  `schemaVersion`. v0.2 adds exactly one operation,
  `MigrateMaterialAppearanceContract`: `high` risk, targets the scene
  identity, requires `parameters.materials` to enumerate every base material
  exactly once sorted lexicographically by `materialId` with no duplicates
  and no `baseColorRgb` override, and is rejected if the base is not
  canonical v0.2, is already v0.3, or any assigned target has a locked
  material — all before any DCC launch (`MATERIAL_APPEARANCE_SET_UNSORTED`,
  `MATERIAL_ID_DUPLICATE`, `MATERIAL_APPEARANCE_SET_INCOMPLETE`,
  `MATERIAL_NOT_FOUND`, `MATERIAL_APPEARANCE_ALREADY_CANONICAL`,
  `SCENE_SPEC_VERSION_TRANSITION_UNSUPPORTED`, `MATERIAL_LOCKED`).
- `rev_golden_0011` is the first canonical Golden revision at SceneSpec v0.3;
  `rev_golden_0001`-`rev_golden_0010` remain v0.2 and byte-identical. Its
  roughness/metalness values (`material_wall_neutral` `0.62`,
  `material_floor_neutral` `0.34`, `material_sofa_proxy` `0.78`, all
  `metalness: 0`) are an explicit, hand-authored design decision, never the
  8F/8B adapter's `0.45` default. Base colors, material IDs, names, order,
  and assignments (including the pre-existing rev4 `wall_south` ->
  `material_floor_neutral` reassignment) are unchanged; the migration
  produces zero semantic manifest diff (materials live only in SceneSpec's
  top-level `materials[]`, which the manifest never tracks) and does not
  disturb the already-canonical `corona`/`preview` render state or
  `light_living_key_area`.
- `apply_change_set.py` accepts `revisionPlanVersion` `0.1.0` or `0.2.0` and
  reuses `render_corona_material_appearance.py`'s discovery/creation/
  property-mapping functions for the new operation rather than a third
  independent mapping; it replaces each pre-migration
  `AVZ_MATERIAL_{materialId}` StandardMaterial with a same-named native
  Corona Physical Material. A wall's host node is a non-renderable Dummy
  helper with no real material slot (mirroring `verify_scene.py`'s own
  wall-validation, which never checks material on a wall host either), so
  material identity is assigned to the host for display-tree consistency but
  assigned-and-verified (including the deduplication proof) only on its
  physical segments, or on the single node directly for non-wall targets.
  `verify_scene.py`'s native-material check now accepts either
  StandardMaterial or Corona Physical Material, and its manifest-recovery
  step stores the tolerance-checked canonical color rather than the raw
  native reading, since Corona's float32 base-color read-back carries
  harmless sub-percent noise relative to a StandardMaterial's exact 8-bit
  `.diffuse` that would otherwise look like a spurious semantic diff on
  every native-class change.
- Promotion requires three independent fresh-process verifiers, not two: the
  existing semantic-manifest verifier, the existing canonical render-state
  verifier (still sticky once `render.engine`/`mode` are set, so it re-runs
  on rev11 too), and a new `verify_canonical_material_state.py` validated
  against `canonical-material-state-v0.1`
  (`validateCanonicalMaterialStateEvidence`) — its own independent DCC
  process, separate from the mutation process and the other two verifiers.
  All evidence is written as tolerance-checked canonical values, not the raw
  runtime observation, matching `canonical-render-state-v0.1`'s established
  normalization pattern. `replayRevision()`'s render-state evidence gate
  covers `MigrateMaterialAppearanceContract` in addition to
  `SetRenderIntent`/`AddLight`, so replaying a later revision built on a
  render-configured scene does not drop render-state evidence that was
  genuinely verified during the live run.
- MaterialId, never appearance value, is the deduplication key, re-proven
  independently in the fresh material-state verifier (not only at mutation
  time): `material_floor_neutral` is shared by two targets (`wall_south` and
  `surface_floor_main`) and must resolve to one native instance, while every
  distinct `materialId` must resolve to a distinct native instance.

## Canonical Golden Corona preview from rev11 (Spike 8H)

- `executeCanonicalGoldenCoronaPreviewRev11` (a new, separate execution
  module from 8E's `executeCanonicalGoldenCoronaPreview`, which is
  untouched) requires the source SceneSpec to be exactly `rev_golden_0011`
  at `sceneSpecVersion: "0.3.0"` and compiles it only through
  `compileCanonicalMaterialAppearance()` (plan v0.2). Rendering remains
  execution output, not a SceneChangeSet transition: no `rev_golden_0012` is
  ever created and the loaded scene is never saved.
- The render runner (`render_canonical_golden_corona_preview_rev11.py`)
  never creates a light or a material and never switches the renderer. It
  resolves and observes the already-persisted renderer, `light_living_key_area`
  CoronaLight, and `AVZ_MATERIAL_*` Corona Physical Materials by reusing
  `verify_scene`, `verify_canonical_render_state`, and
  `verify_canonical_material_state` — the same three fresh-process verifiers
  8G already trusts — rather than a fourth independent Corona
  material-property mapper. All three verification contracts (semantic
  manifest, canonical render state, canonical material state) must pass
  fresh against the staged artifact before any render call; 8G's
  revision-time verification is never relied upon alone.
- Camera reuse is strictly observation-only: `camera_living_a` is resolved
  by `AIArchViz.LogicalObjectId` and its persisted position, FOV
  (`math.radians(camera.fov)`, since MAXScript's `Camera.fov` is degrees
  while the canonical plan's `fovRadians` is a genuine radian value), and
  look-at-derived orientation are compared against the canonical plan within
  tolerance. The runner never assigns to `camera.pos`/`camera.rotation`/
  `camera.fov`; a persisted camera whose semantics differ from the canonical
  SceneSpec fails closed (`CAMERA_REALIZATION_FAILED`) rather than being
  normalized and re-checked. This degrees/radians distinction also applied
  to 8E's own camera handling (which normalizes the camera in memory before
  comparing); 8E's `_resolve_camera()` was fixed to convert on write and on
  read-back, since it had been silently assigning a ~1.3° FOV to its
  temporary in-memory camera instead of the intended ~74° (never caught
  because that scene is never saved or visually inspected).
- `canonical-corona-preview-evidence-v0.2` is a new, separate schema
  (`evidenceVersion: "0.2.0"`, `revisionId: "rev_golden_0011"`,
  `sceneSpecVersion: "0.3.0"`); `canonical-corona-preview-evidence-v0.1`
  (rev10, temporary `AVZ_CORONA_*` realization, Spike 8E) is byte-for-byte
  unchanged. v0.2's material entries require the persisted `AVZ_MATERIAL_*`
  naming and the `_CoronaPhysicalMtl` class, carry canonical and observed
  `baseColorRgb`/`roughness`/`metalness` side by side (the same
  tolerance-checked-canonical-value normalization as
  `canonical-material-state-v0.1`), and a top-level
  `sameIdSharedInstance`/`differentIdDistinctInstances` deduplication proof.
  If the persisted scene had only rendered correctly after fresh temporary
  materials were created, that would have meant 8G's persistence was not
  actually production-usable; this spike's evidence proves it is.

## Canonical camera revision (Spike 8I)

- `scene-change-set-v0.3.schema.json` is a new, separate schema
  (`schemaVersion: "0.3.0"`); v0.1 and v0.2 are byte-for-byte unchanged and
  every existing Golden changeset fixture still validates against its own
  version. `validateSceneChangeSet()` dispatches on `schemaVersion` and
  fails a recognized-but-unsupported version explicitly rather than falling
  back to any validator. v0.3 adds exactly one operation, `SetCamera`: an
  absolute-desired-state mutation whose `parameters` are exactly
  `position`, `target`, `orientationPolicy` (`const: "look_at_target"`),
  `focalLengthMm`, and `sensorWidthMm` — `additionalProperties: false`
  deliberately forbids `rotationEuler` or any other field from the
  ChangeSet. There is no camera lock model; camera locks are out of scope
  for this spike.
- `apps/worker/src/camera-policy.ts` and `tools/3ds-max/python/
  camera_policy.py` are the single, deliberately mirrored source for all
  camera math: `deriveCameraFovRadians`/`fov_radians` and
  `deriveCameraFovDegrees`/`fov_degrees` (`fovRadians = 2 *
  atan(sensorWidthMm / (2 * focalLengthMm))`), `deriveLookAtRotationEuler`/
  `look_at_rotation_euler` (canonical atan2-based look-at convention,
  `pitch = atan2(dz, hypot(dx,dy))`, `yaw = (atan2(dy,dx) + 270) mod 360`),
  and `targetDistanceMm`/`target_distance_mm` (rounded to 6 decimal places
  because JS and Python `hypot()` disagree at the ~13th significant digit,
  which is enough to fail an exact cross-process evidence comparison though
  far below any meaningful millimeter-scale precision). 3ds Max's
  MAXScript `Camera.fov` is degrees, never a genuine radian value — the
  exact Spike 8H boundary defect — and every DCC-side read or write through
  this module converts explicitly; there is no third, independent copy of
  this math anywhere in the codebase. `deriveLookAtRotationEuler`/
  `look_at_rotation_euler` normalize their returned pitch/roll/yaw through
  `canonicalCameraAngle()`/`canonical_camera_angle()` (round to 6 decimal
  places) before returning, so two derivations from the same
  position/target always serialize to the identical JSON number, matching
  the precision already used by the hand-authored Golden camera fixtures.
  This canonical-representation rounding is a distinct concept from a live
  DCC observation's angular tolerance (`verify_canonical_camera_state.py`'s
  `ANGLE_TOLERANCE`) and must never replace it.
- The revision engine never accepts a camera's rotation from the
  ChangeSet: `SetCamera`'s mutation branch in `revision.ts` always derives
  `transform.rotationEuler` via `deriveLookAtRotationEuler(position,
  target)`, resolves the target camera by logical ID only (`CAMERA_NOT_FOUND`
  / `CAMERA_ID_AMBIGUOUS` on zero or multiple matches), and rejects a
  coincident `position`/`target` (`CAMERA_POSITION_TARGET_INVALID`) and a
  desired state that exactly equals the current semantic camera state
  (`CAMERA_STATE_UNCHANGED`) before any DCC launch. `focalLengthMm > 0` and
  `sensorWidthMm > 0` are enforced by the v0.3 schema itself, not
  re-validated in the mutation branch.
- `rev_golden_0012` changes only `camera_living_a.focalLengthMm` (24mm ->
  28mm); position, target, sensor width, orientation policy, and the
  normalized derived rotation are unchanged (`transform.rotationEuler` is
  now byte-identical to rev11's `[-2.84471, 0, 206.565051]`), every other
  managed entry (including `camera_living_b`/`camera_living_c`) is
  unchanged, and rev1-rev11 remain byte-identical. `assertRevisionDiff`'s
  `SetCamera` branch still permits both `focalLengthMm` and
  `transform.rotationEuler` as allowed changed fields — the latter for a
  real position/target change, which the Golden fixture does not exercise
  but the general `SetCamera` contract must still support — always with
  exactly 13 unchanged entries and no additions or removals.
  `revisionPlanVersion` is `"0.3.0"` only for `SetCamera`; `"0.1.0"`/
  `"0.2.0"` plans for other operation types are unaffected.
- `apply_change_set.py`'s DCC mutation flow for `SetCamera` opens the
  verified rev11 source, resolves `camera_living_a` by
  `AIArchViz.LogicalObjectId`, requires its actual class to already be a
  camera, then writes `position`, the derived `rotation`, `targetDistance`,
  and `fov` (via `camera_policy.fov_degrees`) in that order, each write
  independently forceable-to-fail for regression testing
  (`CAMERA_REALIZATION_FAILED`); the camera node itself is mutated in
  place and never deleted, recreated, renamed, or reassigned a different
  `LogicalObjectId`.
- Promotion requires four independent fresh-process verifiers, not three:
  the existing semantic-manifest, canonical render-state, and canonical
  material-state verifiers, plus a new `verify_canonical_camera_state.py`
  validated against `canonical-camera-state-v0.1`
  (`validateCanonicalCameraStateEvidence`). Unlike its two render/material
  siblings, `canonicalCameraStateExpectation()` is deliberately NOT
  scene-state-"sticky" (cameras exist unconditionally from rev1 with no
  natural SceneSpec flag to key stickiness off); it is gated purely by
  `mutation.type === "SetCamera"` at the `applySceneChangeSet` and
  `replayRevision()` call sites. The render-state and material-state
  replay gates were both extended to also cover `SetCamera`, since rev12
  remains a corona/preview, v0.3 scene regardless of which operation
  produced it.
- The camera-state verifier checks all three canonical cameras (sorted by
  `logicalId`), not only the one being mutated, and re-derives the
  OBSERVED target from physical `node.pos`/`node.rotation` combined with
  the already-known canonical target distance via `camera_policy
  .implied_target()` — it never reads `node.targetDistance` back, which is
  settable but not reliably readable for a `Freecamera`. Its evidence
  carries tolerance-checked canonical values, matching the
  `canonical-render-state-v0.1` / `canonical-material-state-v0.1`
  normalization pattern. Three regression hooks specifically re-prove the
  8H degrees/radians boundary and related physical-consistency failures:
  `fov_regression` (treats the raw degrees FOV as if already radians) ->
  `CAMERA_FOV_MISMATCH`, `orientation_mismatch` -> `CAMERA_ORIENTATION_MISMATCH`,
  and `target_mismatch` -> `CAMERA_TARGET_MISMATCH`.
- No render is produced by this spike; rendering `rev_golden_0012` from its
  canonical camera state is out of scope (a plausible future Spike 8J, not
  authorized).

## Canonical Golden Corona preview from rev12 (Spike 8J)

- `canonical-golden-corona-preview-rev12-execution.ts` (a new, separate
  execution module from 8H's `executeCanonicalGoldenCoronaPreviewRev11`,
  which is untouched) requires the source SceneSpec to be exactly
  `rev_golden_0012` at `sceneSpecVersion: "0.3.0"` and compiles it only
  through `compileCanonicalMaterialAppearance()` (plan v0.2), additionally
  asserting the compiled plan's camera is exactly 28mm/36mm before any DCC
  launch. Rendering remains execution output, not a SceneChangeSet
  transition: no `rev_golden_0013` is ever created and the loaded scene is
  never saved.
- The render runner (`render_canonical_golden_corona_preview_rev12.py`)
  never creates a light or a material, never switches the renderer, and
  never writes to the camera. It resolves and observes the already-
  persisted renderer, `light_living_key_area` CoronaLight, and
  `AVZ_MATERIAL_*` Corona Physical Materials by reusing `verify_scene`,
  `verify_canonical_render_state`, and `verify_canonical_material_state` —
  the same fresh-process verifiers 8G/8H already trust. Unlike 8H, it adds
  a FOURTH mandatory pre-render verification layer, canonical camera state,
  by reusing `verify_canonical_camera_state.py` verbatim (Spike 8I's own
  fresh-process verifier) rather than introducing a second independent
  FOV/look-at formula — the exact thing Item 29 of this spike's task
  forbade. All four verification contracts (semantic manifest, canonical
  render state, canonical material state, canonical camera state) must
  pass fresh against the staged artifact before any render call.
- Camera reuse is strictly observation-only, one layer downstream of an
  already-completed proof: after `verify_canonical_camera_state.py` has
  independently confirmed `camera_living_a`'s physical position,
  orientation, and FOV (with a forced `fov_regression` hook proving the
  historical degrees-as-radians defect still fails closed with
  `CAMERA_FOV_MISMATCH`), the render runner performs one more resolution
  step purely to obtain a native node handle for `rt.render(camera=...)` —
  it never writes `camera.pos`/`camera.rotation`/`camera.fov`/
  `camera.targetDistance`, and a static unit test asserts the runner's
  source contains none of those write patterns nor any material/camera/
  light creation call.
- `canonical-corona-preview-evidence-v0.3` is a new, separate schema
  (`evidenceVersion: "0.3.0"`, `revisionId: "rev_golden_0012"`,
  `sceneSpecVersion: "0.3.0"`); `canonical-corona-preview-evidence-v0.1`
  (rev10, temporary `AVZ_CORONA_*` realization, Spike 8E) and
  `canonical-corona-preview-evidence-v0.2` (rev11, persisted 24mm camera,
  Spike 8H) are byte-for-byte unchanged. v0.3's camera evidence carries
  canonical-vs-observed `position`/`target`/`rotationEuler` and
  expected-vs-observed `fovRadians`/`fovDegrees` side by side, sourced
  directly from the camera-state verifier's own tolerance-checked-canonical
  evidence rather than re-derived by the render runner — the same
  normalization pattern established by `canonical-render-state-v0.1`/
  `canonical-material-state-v0.1`/`canonical-camera-state-v0.1`.
- 8H (`canonical-golden-corona-preview-rev11-execution.ts`/
  `render_canonical_golden_corona_preview_rev11.py`) is completely
  untouched: it still builds/verifies `rev_golden_0011` only, still
  realizes/reuses the 24mm camera under three verification layers (it
  predates canonical camera state), and creates no `rev_golden_0012`. 8J
  does not repoint or extend 8H; it is a structurally parallel, narrower
  entry point for the rev12 case.

## Deterministic spatial placement validation (Spike 9A)

- `packages/spatial-engine/` is a new, pure, DCC-independent package with
  zero runtime dependencies (no ajv, no json-canonicalize — those stay in
  `worker-contracts`). It never touches 3ds Max, pymxs, Corona, worker
  process execution, filesystem paths, or OS state; inputs are plain
  validated canonical data, outputs are plain deterministic data. It
  requires no new DCC script — every spatial test runs under normal
  `pnpm test`.
- `spatial-policy-v0.1` (implementation-owned, not user/job supplied) is
  frozen to: floor-plan XY occupancy (2.5D — height is preserved in source
  data but is never an authoritative collision axis), concave-safe
  canonical space containment, proxy-asset OBB collision, and a doorway
  access-clearance envelope. Circulation/pathfinding, true 3D collision,
  and any DCC geometry query are explicitly out of scope (see
  [SPATIAL-VALIDATION.md](../docs/architecture/SPATIAL-VALIDATION.md)).
- `SPATIAL_EPSILON_MM = 0.001` is the single frozen epsilon
  (`packages/spatial-engine/src/geometry.ts`), used consistently for
  point-on-boundary, segment intersection, SAT overlap, and the roll/pitch
  "upright" support check (as a degrees tolerance) — no other epsilon
  exists anywhere in the package.
- Supported asset footprint model: `type: proxy_asset`, definition
  `pivotPolicy: floor_center`, positive scale, and upright orientation
  (`rotationEuler.x`/`.y` within `SPATIAL_EPSILON_MM` degrees of zero);
  `rotationEuler.z` (yaw) is fully supported. Anything else — non-zero
  roll/pitch, `back_center_floor` pivot, invalid/missing dimensions —
  returns `SPATIAL_FOOTPRINT_UNSUPPORTED` with no guessed footprint, never
  a silent projection. Canonical corner order is frozen: local `(-x,-y)`,
  `(+x,-y)`, `(+x,+y)`, `(-x,+y)`, rotated/translated to world XY.
- Space containment requires BOTH every footprint corner inside-or-on the
  space boundary AND no footprint edge properly crossing a
  space-boundary edge (a robust, epsilon-aware segment test) — corner-only
  containment is insufficient for a concave polygon whose boundary dips
  between two contained corners. Boundary touching alone is always
  allowed; a footprint is invalid only if it has positive geometry outside
  the space beyond the epsilon.
- Asset-asset collision uses exact convex-polygon SAT, never world-axis
  AABB as the authoritative test (AABB may only be a future broad phase).
  A collision requires interior overlap by more than the epsilon on every
  candidate axis; boundary touching alone is allowed. Collision identity
  always uses canonical logical IDs, sorted lexicographically
  (`assetAId < assetBId`) so semantically identical scenes always report
  the pair in the same order.
- The doorway access-clearance envelope (`width = opening.width` along the
  host wall, `depth = opening.width` into the room, starting at the
  interior wall face) is deliberately conservative: **not** swing
  geometry, **not** a building-code claim, applies identically regardless
  of `swingDirection`, and never depends on `hingeSide`. Windows never
  produce a clearance zone. The interior side is derived from the shared
  `wallFrame()` (negated `exteriorNormal`) — `apps/worker/src/
  build-plan.ts`'s own `wallFrame()` now re-exports this single
  implementation rather than defining a second copy, so the DCC-side wall
  math and the pure spatial engine can never independently drift.
- Three pure APIs: `validateSpatialScene(sceneSpec)` (full-scene),
  `evaluateAssetPlacement(sceneSpec, assetId, desiredTransform)` (the
  future boundary an AI planner calls before proposing `MoveObject`), and
  `evaluateAssetReplacement(sceneSpec, assetId, newAssetDefinitionId)`
  (same boundary for `ReplaceAsset`; the *new* definition's dimensions are
  authoritative, never the old footprint). None mutates its input; all
  produce byte-equivalent normalized evidence for semantically identical
  scenes regardless of input array order (`assetFootprints` sorted by
  `assetId`, `doorwayClearances` by `openingId`, `violations` by
  `code, primaryId, secondaryId`).
- `spatial-validation-evidence-v0.1`
  (`packages/worker-contracts/schema/spatial-validation-evidence-v0.1.schema.json`,
  `validateSpatialValidationEvidence`) wraps a `validateSpatialScene()`
  result with `evidenceVersion: "0.1.0"` and `sceneSpecHash` (hashing is a
  worker-contracts concern via `semanticJsonHash`, built by
  `apps/worker/src/spatial-validation.ts`'s `spatialValidationEvidence()`
  — the pure engine itself never hashes). No filesystem paths appear
  anywhere in the evidence.
- The oracle is integrated into `apps/worker/src/revision.ts`'s
  `MoveObject` and `ReplaceAsset` branches (`enforceSpatialPlacement`/
  `enforceSpatialReplacement`, called with the *original* base scene, not
  a pre-mutated target) and into `apps/worker/src/
  external-asset-ingestion.ts`'s controlled `VERIFIED` `external_max`
  `ReplaceAsset` path (validated against the fully-constructed
  `targetSceneSpec`, since the new external definition does not exist in
  the base scene yet) — **strictly additively**. The pre-existing
  `validatePlacement()`/`OBJECT_OUTSIDE_SPACE` corner-only check in
  `revision.ts` and `validateSpatialFit()`/`OBJECT_OUTSIDE_SPACE` in
  `external-asset-ingestion.ts` are both completely unchanged and still
  run first; the new `spatial-policy-v0.1` checks run strictly afterward
  and only add rejections the legacy checks cannot catch. A specific
  `SPATIAL_*` code is always propagated (never a generic
  `REVISION_FAILED`), and an invalid candidate reaches zero DCC launch
  because the check runs entirely inside the pure preflight step, before
  `allowDccExecution && authorizeDccExecution` is ever reached. No other
  operation type is newly gated.

## Deterministic circulation analysis (Spike 9B)

- `circulation-policy-v0.1` lives in
  `packages/spatial-engine/src/circulation.ts`, a separate policy from
  `spatial-policy-v0.1` (unchanged) inside the same pure, dependency-free
  package. Authoritative doc:
  [CIRCULATION-ANALYSIS.md](../docs/architecture/CIRCULATION-ANALYSIS.md).
- Frozen constants: grid step 100 mm, agent disc radius 300 mm, snap
  distance `100 * sqrt(2)` mm, route distance rounded to 6 decimals,
  shared `SPATIAL_EPSILON_MM = 0.001`. These are software access-probe
  parameters, not building-code, accessibility, egress, or ergonomic
  claims.
- `validateSpatialScene()` must PASS first
  (`CIRCULATION_SOURCE_SPATIAL_INVALID` otherwise). Each space graph uses
  only the 9A asset OBB footprints whose canonical `AssetFootprint.spaceId`
  matches that space (never inferred from coordinates or overlap; a
  footprint naming a missing space joins no graph), so spaces sharing XY
  (stacked floors, overlapping boundaries) never obstruct each other; 9A
  doorway clearances are free space used for portals; windows produce
  nothing.
- Per space, grid centers are `min + (i + 0.5) * 100` from the boundary's
  bounding box; node ID `spaceId::ix::iy` (integers only); frozen node
  order `spaceId`, `ix`, `iy`. A node is walkable when strictly inside the
  space with exact distance >= `300 - epsilon` to every boundary segment
  and asset rectangle. 8-neighbor edges (N, NE, E, SE, S, SW, W, NW;
  costs 100 / `100*sqrt(2)`) require no diagonal corner cutting and an
  exact swept-segment clearance check. Component ID = smallest member node
  in frozen order.
- Door portal = midpoint of the clearance's two into-room corners. Portals
  and route endpoints must themselves be clear probe centers and snap only
  to a walkable node within the snap distance via a clear segment
  (nearest, then lowest node order); otherwise
  `CIRCULATION_PORTAL_BLOCKED` / `CIRCULATION_ENDPOINT_BLOCKED` /
  `CIRCULATION_ENDPOINT_UNRESOLVABLE`.
- `findCirculationRoute()` is same-space only (no cross-space topology is
  guessed) and uses deterministic Dijkstra with exact integer step-count
  costs compared as `a + b*sqrt(2)`; ties resolve by frozen node order.
  Disconnected endpoints return `CIRCULATION_NO_ROUTE`.
- `circulation-analysis-evidence-v0.1` (built by
  `apps/worker/src/circulation-analysis.ts`'s
  `circulationAnalysisEvidence()`, schema-validated) is compact: summaries
  and door portals only, with the full normalized graph committed via
  `graphSemanticHash` (`semanticJsonHash`, worker layer). No nodes, edges,
  paths, or DCC data are serialized.
- 9B adds no revision gate: `MoveObject`/`ReplaceAsset` remain gated by
  `spatial-policy-v0.1` only until an explicit canonical circulation
  requirement contract exists.

## Canonical circulation requirements (Spike 9C)

- SceneSpec v0.4 (`packages/scene-spec/schema/scene-spec-v0.4.schema.json`,
  `sceneSpecVersion: "0.4.0"`) is v0.3 with every property and `$defs`
  entry unchanged plus the required top-level `circulationRequirements[]`
  (empty array valid). v0.1-v0.3 schemas are untouched; v0.3 rejects the
  field. `validateSceneSpec()` supports exactly 0.1.0-0.4.0. Generic
  `constraints[]` semantics are unchanged. Authoritative doc:
  [CIRCULATION-REQUIREMENTS.md](../docs/architecture/CIRCULATION-REQUIREMENTS.md).
- Requirement: `id`, `type: same_space_route` (only type), `spaceId`,
  `evaluationPolicy: circulation-policy-v0.1` (pinned; anything else fails
  the schema), `start`/`end` endpoints of kind `door_portal` (`openingId`)
  or `point` (`pointXY`, two finite JSON numbers, world XY mm). No
  severity/priority/weight; every entry is a requirement.
- v0.4 semantic validation keeps asset identity checks and adds
  `circulationRequirementOrder` (sorted by id, code-point; never
  reordered), `uniqueCirculationRequirementId`,
  `circulationRequirementSpaceReference`,
  `circulationRequirementOpeningReference`,
  `circulationRequirementOpeningType` (door only),
  `circulationRequirementOpeningHost` (exactly one wall),
  `circulationRequirementOpeningSpace` (host wall canonical `spaceId`
  equals the requirement space), and
  `circulationRequirementDistinctEndpoints`. Blocked endpoints and missing
  routes are satisfaction results, never validation errors.
- `evaluateCirculationRequirements()`
  (`packages/spatial-engine/src/circulation-requirements.ts`) is pure and
  reuses 9B only: door portals from `analyzeCirculation()`, routes from
  `findCirculationRoute()`. Outcomes: SATISFIED, or UNSATISFIED with
  `CIRCULATION_SOURCE_SPATIAL_INVALID` / `CIRCULATION_PORTAL_BLOCKED` /
  `CIRCULATION_ENDPOINT_BLOCKED` / `CIRCULATION_ENDPOINT_UNRESOLVABLE` /
  `CIRCULATION_NO_ROUTE`. A requirement depends only on its own endpoints
  and route (an unrelated blocked portal never fails it). Overall PASS
  requires 9A PASS and every requirement SATISFIED; results sorted by
  `requirementId`.
- `circulation-requirement-evidence-v0.1` (built and schema-validated by
  `apps/worker/src/circulation-requirement-evidence.ts`'s
  `circulationRequirementEvidence()`, which first validates the scene as
  v0.4) carries identity, `sceneSpecHash`, both policy versions,
  `requirementSetHash`, `graphSemanticHash`, per-requirement results with
  `routeSemanticHash` (hash of the exact 9B route result), and `status`;
  no paths. `circulation-analysis-evidence-v0.1` is unchanged.
- Not enforced yet: no revision gate, no SceneChangeSet operation, no
  v0.3 to v0.4 migration, Golden rev1-rev12 unchanged (rev12 stays v0.3),
  no rev13. Requirements express project intent under a named policy, not
  building-code or accessibility compliance.

## Canonical circulation requirement enforcement (Spike 9D)

- SceneChangeSet v0.4 (`scene-change-set-v0.4.schema.json`) is v0.3 plus one
  high-risk, scene-scoped operation, `MigrateCirculationRequirementContract`
  (`targetSceneSpecVersion: "0.4.0"`, `circulationRequirements[]`), with the
  one-operation invariant kept. `validateSceneChangeSet()` dispatches exactly
  0.1.0-0.4.0. SceneSpec v0.1-v0.4 and SceneChangeSet v0.1-v0.3 are unchanged.
- The migration is the only explicit SceneSpec v0.3 -> v0.4 transition
  (revision plan `0.4.0`, bound to this operation only in Python). It rejects
  a v0.4 base (`CIRCULATION_REQUIREMENT_CONTRACT_ALREADY_CANONICAL`), other
  transitions (`SCENE_SPEC_VERSION_TRANSITION_UNSUPPORTED`), and incoherent
  requirements (`CIRCULATION_REQUIREMENT_SET_UNSORTED`,
  `CIRCULATION_REQUIREMENT_ID_DUPLICATE`,
  `CIRCULATION_REQUIREMENT_REFERENCE_INVALID`, via the 9C v0.4 validator),
  and it may not introduce an already-failing requirement. In 3ds Max it
  writes nothing physical: only worker-owned revision metadata advances.
- Golden `rev_golden_0013` (SceneSpec v0.4) differs from rev12 only in
  version, revision identity, history, and one hand-authored requirement,
  `circulation_req_entry_to_east_clear_point` (`opening_d01` portal ->
  `[5000, 1500]`). Its graph hash equals rev12's. No rev14.
- Enforcement: one shared gate, `circulationRequirementGateFailure()`
  (`apps/worker/src/circulation-requirement-evidence.ts`), runs on the
  COMPLETE candidate target (operation applied, revision metadata appended,
  target validated) and after all structural/lock/9A checks, for every
  operation on a v0.4 target, and never for v0.1-v0.3 targets. It throws
  `CIRCULATION_REQUIREMENT_UNSATISFIED` (`CirculationRequirementUnsatisfiedError`
  carries the first unsatisfied `requirementId` and the underlying 9B
  `failureCode`) inside the pure preflight, so no DCC discovery or process
  occurs. The controlled VERIFIED `external_max` `ReplaceAsset` path applies
  the same gate after its asset-trust and 9A checks.
- New evidence versions `canonical-material-state-v0.2` and
  `canonical-camera-state-v0.2` carry identical physical fields bound to
  SceneSpec 0.4.0 (the v0.1 contracts stay bound to <= v0.3); worker and
  Python verifiers dispatch by SceneSpec version. `canonical-render-state-v0.1`
  is reused. A v0.4 revision is promoted only after semantic manifest,
  render-state, material-state v0.2, camera-state v0.2, and PASS
  `circulation-requirement-evidence-v0.1` (persisted as
  `verification/circulation-requirement-evidence.json`, hash bound into the
  request hash, required on replay).

## Deterministic DXF extraction (Spike 10A)

- `cad-document-v0.1` (`packages/cad-parser/schema/cad-document-v0.1.schema.json`,
  `validateCadDocument`) is normalized CAD SOURCE EVIDENCE, not SceneSpec:
  `cadDocumentVersion: "0.1.0"`, `sourceFormat: "dxf"`, byte `sourceHash`,
  raw `header` (`acadVersion`/`dwgCodePage` null when absent,
  `insunitsCode`), `sourceUnits`, `canonicalUnits: "millimeters"`,
  code-point-sorted `layers` and `blocks` (inventory only), source-ordered
  `entities` and `unsupportedEntities`, and `summary` counts. No path, no
  inferred architecture, no confidence.
- `CadSourceAdapter.parse({ bytes })` is the trusted adapter boundary;
  `DxfSourceAdapter` is the only implementation and the only code that knows
  DXF group codes. A future DWG adapter must emit the same contract.
- Failure codes: `CAD_SOURCE_TOO_LARGE` (> 10 MiB, checked first),
  `CAD_BINARY_DXF_UNSUPPORTED`, `CAD_DXF_PARSE_FAILED` (all malformed input,
  including invalid UTF-8), `CAD_NUMERIC_NON_FINITE`, `CAD_UNITS_UNSPECIFIED`
  (`$INSUNITS` absent or 0), `CAD_UNITS_UNSUPPORTED`. No partial document.
- Units: `$INSUNITS` only; 1/2/4/5/6 -> x25.4/304.8/1/10/1000 to mm, one
  multiplication, no rounding, WCS preserved; bulge, INSERT scale, and angles
  are never scaled.
- Entities: LINE, LWPOLYLINE (`closed`, `flags`, `elevation`, per-vertex
  `bulge`), INSERT (not exploded), TEXT (inert). Everything else is
  recorded with `UNSUPPORTED_ENTITY_TYPE`, `UNSUPPORTED_OCS_EXTRUSION`, or
  `UNSUPPORTED_INSERT_ARRAY`; nothing is dropped. `sourceOrdinal` and
  `sourceHandle` are provenance, never SceneSpec identity.
- `cad-extraction-evidence-v0.1` (worker-contracts,
  `validateCadExtractionEvidence`) carries `sourceHash`, `cadDocumentHash`
  (`semanticJsonHash` of the document), units, summary, and `status:
  "PASS"`; no path, no entity array. `apps/worker/src/cad-extraction.ts`
  (`extractCadDocument`, `writeCadExtraction`) and `extract-cad` enforce
  root-relative `.dxf` sources and root-bounded `.json` outputs.
- Path containment (post-10A closure): CAD source and output paths must be
  contained lexically (`resolveWithinRoot`) AND physically (realpath of the
  target, or of the nearest existing output ancestor, inside the realpath of
  the trusted root). A final source link is never followed; intermediate
  links are allowed only if they stay physically inside the root; a broken
  link in the route is `CAD_SOURCE_PATH_INVALID`; an existing output link
  entry or escaping ancestor is `CAD_OUTPUT_PATH_INVALID`; both output
  destinations are validated before any write.
- See [../docs/architecture/CAD-INGESTION.md](../docs/architecture/CAD-INGESTION.md).

## Deterministic CAD interpretation (Spike 10B)

- `cad-interpretation-policy-v0.1` is the software-owned algorithm;
  `cad-interpretation-profile-v0.1`
  (`packages/cad-interpreter/schema`, `validateCadInterpretationProfile`)
  is declarative human-authored configuration: `profileId`,
  `cadDocumentVersion: "0.1.0"`, exact `interpretationPolicy`, exact
  case-sensitive layer roles (`spaceBoundary`, `spaceLabel`, `door`,
  `window`; one role per layer), one `level`,
  `wallDefaults.wallThicknessMm`, exact label rules, door rules (sill 0,
  `anchorPolicy: "center"`, hinge/swing) and window rules.
- `interpretCadDocument(cadDocument, profile)` is pure, validates both
  inputs first, and returns `architectural-extraction-v0.1`
  (`validateArchitecturalExtraction`): `profileId`, `profileHash`,
  `source.{cadDocumentVersion, sourceFormat, sourceHash, cadDocumentHash}`,
  `level`, `spaces`, `walls`, `openings`, `unconsumedEntities`,
  `summary`, `status: "READY_FOR_REVIEW"`. Never SceneSpec.
- Every candidate field carries provenance of exactly one authority:
  `cad` (`sourceOrdinal`, `sourceHandle`, `role`), `profile` (`field`,
  `ruleId`), or `derived` (`derivation`). Candidate IDs
  (`space_candidate_NNNN`, `wall_candidate_SSSS_EEEE`,
  `opening_candidate_NNNN`) are not SceneSpec logical IDs.
- Policy rules: closed zero-bulge simple positive-area boundaries at the
  profile elevation, normalized to CCW (reversal recorded); positive-area
  overlap fails; one wall per CCW edge (`interior_face`,
  `exterior_right_of_u`); a label is owned only when strictly inside
  exactly one space; openings need a defined non-XREF block, an exact rule
  for that layer, scale [1,1,1], exactly one host within
  `CAD_INTERPRET_HOST_TOLERANCE_MM = 1`, and offset = centerDistance -
  width/2 within the host. Unsupported entities or wrong entity types on
  mapped layers fail closed; unmapped-layer source is recorded as
  unconsumed.
- `cad-interpretation-evidence-v0.1` (worker-contracts,
  `validateCadInterpretationEvidence`) carries `sourceHash`,
  `cadDocumentHash`, `profileId`, `profileHash`,
  `architecturalExtractionHash`, summary, and `status:
  "READY_FOR_REVIEW"`; no arrays, no paths. The worker recomputes the
  input hashes with `semanticJsonHash` (`CAD_INTERPRET_HASH_MISMATCH`).
- See [../docs/architecture/CAD-INTERPRETATION.md](../docs/architecture/CAD-INTERPRETATION.md).

## Reviewed CAD -> canonical SceneSpec seed (Spike 10C)

- `cad-scene-seed-policy-v0.1` (software-owned) +
  `cad-scene-seed-approval-v0.1`
  (`packages/cad-scene-seed/schema`, `validateCadSceneSeedApproval`):
  declarative approval with `approvalId`, exact `canonicalizationPolicy`,
  `decision` (only `approved_as_is` canonicalizes), the exact
  `architecturalExtractionHash` plus `sourceHash`/`cadDocumentHash`/
  `profileHash`/`profileId`, canonical `project` and `scene` identity,
  `lockPolicy: "all_unlocked"`, sorted candidate -> logical-ID mappings for
  every level, space (+ floor/ceiling surface IDs), wall, and opening, and
  `nonCadState` validated by reference to SceneSpec v0.4 `$defs`. No
  override field exists; architectural corrections go through a new 10B run.
- `createSceneSpecSeed(extraction, approval)` is pure: validates both,
  refuses non-approved and stale approvals
  (`CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH`), enforces complete, unique,
  sorted mappings, copies every architectural fact from the extraction,
  emits SceneSpec v0.4 with one committed initial revision and the
  `aiarchviz.cad_seed` provenance extension (hashes, IDs, mappings, no
  paths), then `validateSceneSpec`, reference, and source-metadata checks
  (a `dxf` source `urn:sha256:<sourceHash>`, no local paths).
- Worker `createCadSceneSeed` adds 9A spatial and 9C circulation
  validation and `cad-scene-seed-evidence-v0.1` (six hashes, identity,
  mapping counts, PASS statuses; no paths);
  `assertSeedBuildRealizable` refuses seeds the current initial build
  cannot realize exactly. The seed enters the existing `build-scene`
  pipeline unchanged; it is not a SceneChangeSet revision.
- See [../docs/architecture/CAD-SCENE-SEED.md](../docs/architecture/CAD-SCENE-SEED.md).

## Polygon surface realization (post-10C closure)

- Build plan v0.1 (`compileGoldenBuildPlan`) is immutable: bounding-box
  surface `dimensions`, legacy `Plane` realization. Build plan v0.2
  (`compileBuildPlanV02`, used by the initial build) = identical semantic
  content + `surfaceMeshes[{logicalId, type, vertices, triangles,
  elevationMm, areaMm2}]`; physical geometry comes only from
  `surfaceMeshes`, never from the semantic dimensions.
- `compileSurfaceMesh` (`apps/worker/src/surface-mesh.ts`): surface
  `boundary` is the world-space shape authority and `elevation` the Z
  authority; vertices in canonical order, node-local = world - canonical
  transform position; rotation must be [0,0,0] and scale [1,1,1]; one simple
  coplanar outer loop (10B `polygonDefect` rules), no holes; frozen
  first-valid-ear clipping, N - 2 CCW (+Z) triangles whose area equals the
  polygon area. Failures: `SURFACE_BOUNDARY_INVALID`,
  `SURFACE_TRANSFORM_UNSUPPORTED`, `SURFACE_TRIANGULATION_FAILED` (before DCC).
- Fresh verification with `AI_ARCHVIZ_SCENE_SPEC_PATH`: exactly one
  editable-mesh node per canonical surface; observed world vertices at the
  canonical elevation; valid non-degenerate consistently wound faces; one
  boundary loop from single-face edges equal to the canonical boundary
  (cyclic/orientation-tolerant); physical area equal to the canonical area.
  The initial build promotes only on `surfaceVerification.status: PASS` for
  every surface (`SURFACE_GEOMETRY_MISMATCH`). Scene manifest stays v0.1.
- See [../docs/architecture/DCC-SURFACE-REALIZATION.md](../docs/architecture/DCC-SURFACE-REALIZATION.md).

## Deterministic CAD topology (Spike 10D)

- `cad-topology-policy-v0.1` (software-owned; `CAD_TOPOLOGY_EPSILON_MM =
  0.001`, never user input) + `analyzeArchitecturalTopology({cadDocument,
  interpretationProfile, architecturalExtraction})` ->
  `architectural-topology-v0.1` (`packages/cad-topology/schema`,
  `validateArchitecturalTopology`): `identityScope:
  "topology_local_non_canonical"`, `source` hash chain (sourceHash,
  cadDocumentHash, profileId/profileHash, candidateBasis,
  architecturalExtractionHash or null, spaceWallStageHash), `spaces`,
  `sharedBoundaries`, `spaceAdjacencies`, `openingRelations`,
  `wallClassifications`, `summary`, `status: "READY_FOR_REVIEW"`. Not
  SceneSpec, not approved topology, not a DCC plan.
- Candidate basis: a READY_FOR_REVIEW extraction bound to the supplied
  cad-document and profile (`CAD_TOPOLOGY_INPUT_HASH_MISMATCH`), or null ->
  the shared 10B stage `deriveSpaceWallStage`, only when an opening lies
  on a shared boundary (`CAD_TOPOLOGY_EXTRACTION_REQUIRED`); 10B rejections
  surface as `CAD_TOPOLOGY_INTERPRETATION_REJECTED`.
- Shared boundary: positive-length (> epsilon) collinear overlap of wall
  candidates of different spaces, opposite direction required
  (`CAD_TOPOLOGY_SHARED_EDGE_DIRECTION_INVALID`), no positive overlap
  between intervals on one wall (`CAD_TOPOLOGY_SHARED_INTERVAL_CONFLICT`);
  worldStart/worldEnd lexicographic (x, then y). IDs `shared_boundary_NNNN`,
  `space_adjacency_AAAA_BBBB`, `topology_opening_NNNN`.
- Openings: a door on exactly one shared interval -> one
  `interior_shared_boundary` relation (`connectsSpaces` = two sorted spaces,
  exact profile rule, width inside the interval else
  `CAD_TOPOLOGY_OPENING_OUTSIDE_SHARED_BOUNDARY`); several intervals or an
  extra wall host -> `CAD_TOPOLOGY_OPENING_AMBIGUOUS`; window ->
  `CAD_TOPOLOGY_WINDOW_ON_SHARED_BOUNDARY_UNSUPPORTED`; otherwise the
  uniquely hosted 10B candidate verbatim as `single_space`.
- `cad-topology-evidence-v0.1` (worker-contracts,
  `validateCadTopologyEvidence`): full hash chain, candidateBasis,
  `architecturalTopologyHash`, summary; no geometry arrays, no paths. The
  worker recomputes every hash (`CAD_TOPOLOGY_HASH_MISMATCH`); CLI
  `analyze-cad-topology <doc> <profile> <extraction|none> <output>`.
- 10B public contracts and behavior are unchanged; passes 1-5 are exposed
  as `deriveSpaceWallStage` and opening helpers without semantic change.
- See [../docs/architecture/CAD-TOPOLOGY.md](../docs/architecture/CAD-TOPOLOGY.md).

## Reviewed shared partitions (Spike 10E)

- `cad-shared-partition-policy-v0.1` (software-owned,
  `CAD_PARTITION_EPSILON_MM = 0.001`) +
  `cad-topology-approval-v0.1` (`packages/cad-partition-model/schema`,
  `validateCadTopologyApproval`): `approvalId`, exact `partitionPolicy`,
  `decision` (only `approved_as_shared_partition_model` produces a model),
  `topology` binding (version, `architecturalTopologyHash`,
  `candidateBasis`, `sourceHash`, `cadDocumentHash`, `profileHash`,
  `spaceWallStageHash`, `architecturalExtractionHash` null only for the
  stage basis; `CAD_PARTITION_APPROVAL_HASH_MISMATCH`), sorted
  `sharedBoundaryReviews[{sharedBoundaryCandidateId, referencePolicy:
  "partition_centerline"}]` and `interiorDoorReviews[{topologyOpeningId,
  hingeEndpoint: world_start|world_end, swingIntoSpaceCandidateId}]`, exactly
  one each. No geometry field exists.
- `createReviewedPartitionModel({cadDocument, interpretationProfile,
  architecturalExtraction, architecturalTopology, approval})` ->
  `reviewed-partition-model-v0.1` (`validateReviewedPartitionModel`):
  `identityScope: "model_local_non_canonical"`, approval + source chain,
  `spaces`, `sharedPartitions` (`partition_candidate_NNNN`, centerline =
  10D worldStart -> worldEnd, unit/left [-u.y, u.x]/right [u.y, -u.x]
  normals, agreeing thickness/level/base/height, left and right
  `spaceFaces` at T/2 in the centerline direction, reviewed doors with
  derived hinge jamb point and swing side), `wallSegments` (exact
  shared/unpaired cover of every wall), `unsharedOpeningReferences`,
  summary, `status: "APPROVED_FOR_SCENE_CANONICALIZATION"`. Not SceneSpec.
- Candidate chain recomputed: stage basis reruns only
  `deriveSpaceWallStage` and must reproduce `spaceWallStageHash`; the
  extraction basis requires the exact extraction
  (`CAD_PARTITION_INPUT_HASH_MISMATCH`).
- `cad-partition-model-evidence-v0.1` (worker-contracts,
  `validateCadPartitionModelEvidence`): approval and full hash chain,
  `reviewedPartitionModelHash`, summary; no geometry, no paths. CLI
  `review-cad-partitions <doc> <profile> <extraction|none> <topology>
  <approval> <output>`.
- See [../docs/architecture/CAD-SHARED-PARTITIONS.md](../docs/architecture/CAD-SHARED-PARTITIONS.md).
