# Renderer Execution Boundary

## Scope

Technical Spike 8A establishes a narrow, local Corona capability proof. It is
not a `RendererAdapter` implementation and does not alter SceneSpec material,
light, camera, revision, asset, CAD, AI, V-Ray, or final-quality rendering
contracts.

```text
repository-controlled render job
  -> fresh Safe-Scene 3ds Max Batch process
  -> runtime Corona discovery
  -> fixed local fixture and finite Corona render
  -> worker-controlled PNG validation
  -> portable normalized evidence
```

## Runtime discovery and no fallback

- The worker enumerates `RendererClass.classes`; it never relies on an array
  index or a configured DLL path.
- Corona candidates are selected from normalized runtime class metadata. A
  missing candidate yields `CORONA_NOT_FOUND`; more than one candidate yields
  `CORONA_RENDERER_AMBIGUOUS` rather than an arbitrary first match.
- The selected class is assigned to both `renderers.current` and
  `renderers.production`. Any post-assignment non-Corona identity is failure.
- Corona version is included only when the installed renderer exposes a
  reliable scalar version property. `null` means not observable from the
  supported runtime surface; it is not a guessed version.
- A Corona request never falls back to Scanline, Arnold, or V-Ray.

## Narrow baseline fixture

The 8A fixture is created procedurally in the fresh process using millimeters:

- floor box, back-wall box, and one subject box;
- exactly one discovered `CoronaPhysicalMtl`, assigned to the subject;
- neutral warm matte intent: RGB `[0.72, 0.62, 0.50]`, roughness `0.45`,
  non-metal mode;
- one discovered `CoronaLight` with fixed transform/controls. If an installed
  compatibility release cannot expose a stable configurable `CoronaLight`, the
  runner records an explicit `stock_omni` strategy rather than misrepresenting
  it as a Corona light;
- one native `FreeCamera` at a fixed transform with a 35 mm focal length
  (converted to the native camera FOV using a fixed 36 mm sensor width).

No external textures, maps, XRefs, Cosmos assets, HDRIs, Sun/Sky, IES,
LightMix, denoiser dependency, distributed rendering, network lookup, or
saved `.max` artifact is part of this fixture.

## Fixed render policy

`render-job-v0.1` accepts only this capability job:

```json
{
  "renderJobVersion": "0.1.0",
  "engine": "corona",
  "cameraId": "camera_corona_baseline",
  "mode": "preview",
  "resolution": { "width": 320, "height": 240 }
}
```

The worker, not the job, fixes the Corona pass limit to `4`. The outer
worker-owned process timeout remains a second hard stop. The runner invokes a
normal production `render()` call with the camera, `320 × 240` dimensions,
worker-owned `baseline.png` output, and VFB disabled. Interactive rendering is
not used.

## Evidence and determinism

`render-evidence-v0.1` contains renderer identity/version when observable,
DCC product/version/compatibility mode, camera/material/light identity,
resolution, pass limit, PNG byte length, and SHA-256. It deliberately has no
machine-local output path.

Scene semantic determinism and render configuration determinism are strict.
PNG byte equality is not a cross-machine Golden oracle: CPU, Corona version,
and implementation differences can change pixels. A valid output must instead
have the exact PNG signature, `320 × 240` dimensions, and a non-zero byte
length.

## Security and licensing

- DCC test execution remains explicit-authorization only and uses fresh owned
  `3dsmaxbatch.exe` processes with Dialog Monitor and Safe Scene enabled.
- Safe Scene must be observable as enabled, command-line locked, and
  script-asset protected; it is never weakened for Corona.
- Jobs cannot carry renderer class overrides, scripts, plug-in paths,
  credential/license fields, or output paths.
- Every DCC child process receives a newly constructed environment containing
  only the allowlisted Windows runtime keys needed by 3ds Max/Corona plus
  explicit worker-owned `AI_ARCHVIZ_*` input overrides for that runner. The
  parent environment is never implicitly inherited; vendor and secret
  variables are not copied by wildcard. The exact `VRAY_FOR_3DSMAX2025_MAIN`
  runtime location is allowlisted because Corona shares Chaos's V-Ray USD/DR
  startup component, which fails to render when that variable is absent even
  though the assigned renderer is Corona, not V-Ray; no `VRAY_*`, `CHAOS_*`,
  or `ADSK_*` wildcard is allowed.
- The runner performs no install, upgrade, activation, license-server change,
  distributed render action, download, Cosmos access, or plugin configuration
  mutation.
- License-shaped renderer failures map to `CORONA_LICENSE_UNAVAILABLE`; the
  runner never attempts repair.
- A timeout returns `PROCESS_TIMEOUT`, creates no PASS evidence, terminates
  only the owned process tree, and treats any partial PNG as invalid.

## Compatibility policy and next boundary

The production DCC target remains 3ds Max 2026. A successful 3ds Max 2025.x
run is reported only as compatibility evidence. Corona version policy remains
runtime-discovered; the repository does not pin a public release.

## Spike 8B: SceneSpec-to-Corona adapter boundary

Technical Spike 8B adds a pure TypeScript `RendererAdapter` that compiles a
validated canonical SceneSpec and strict `render-job-v0.2` into the versioned
`corona-execution-plan-v0.1`. Compilation performs no DCC discovery, process
launch, filesystem access, or renderer mutation. The 8A `render-job-v0.1`
baseline remains unchanged and remains a diagnostic capability proof.

- SceneSpec owns canonical material IDs, canonical base-color RGB, assignment
  IDs/targets, area-light transforms and intensity, and camera position,
  target, focal length, and sensor width. The adapter derives native camera
  FOV with `2 * atan(sensorWidth / (2 * focalLength))`.
- Adapter-owned rendering defaults are explicit in the execution plan only:
  Corona Physical Material roughness `0.45`, non-metal mode, an 800 mm area
  light width, and a `120` multiplier for the canonical unitless preview
  intensity. They do not expand or reinterpret SceneSpec.
- The adapter supports one selected camera, Corona `preview` only, exactly
  `320 × 240`, and an adapter-owned Corona pass limit of `4`. `engine: none`,
  non-Corona engines, `final` mode, missing/duplicate cameras, missing or
  duplicate material assignments, and non-area lights fail before any DCC
  invocation.
- A material is created once per canonical material ID. Its assignments are
  realized with the same native material instance; material deduplication is
  recorded in semantic realization evidence. No V-Ray, generic fallback,
  stock-light fallback, external asset, texture, HDRI, IES, Cosmos, or network
  path is permitted in this adapter.
- The DCC runner consumes only the worker-owned, schema-validated execution
  plan. It accepts no renderer classes/properties, scripts, plug-in paths,
  output paths, or executable fields from SceneSpec or the render job. The
  worker owns the temporary plan/result/output paths and normalizes portable
  evidence without local paths.

`renderer-realization-evidence-v0.1` records actual Corona renderer/material/
light/camera identity, assignments, mapped values, render policy, and portable
PNG integrity data. It is evidence of the current runtime realization, not a
cross-machine pixel-equality oracle. A missing Corona renderer/material/light,
unsupported required property, unsafe-scene posture, process timeout, invalid
evidence, or invalid PNG is a closed failure and cannot produce PASS evidence.

The next desired task after a verified 8B pass is **Technical Spike 8C**.
V-Ray remains later work.

## Spike 8C: trusted diagnostic preview of a verified scene

Spike 8C is a read-only diagnostic execution, not a SceneSpec revision. The
canonical Golden `rev_golden_0008` SceneSpec intentionally remains
`render.engine: none` and `render.mode: build_only`. Normal
`CoronaRendererAdapter.compile()` continues to reject that state. A separately
named diagnostic compiler accepts only the repository-owned Golden rev8
identity, binds its RFC 8785 SceneSpec hash and raw verified `.max` hash, and
adds a worker-owned immutable preview profile.

```text
verified rev8 .max + verified rev8 manifest + canonical SceneSpec
  -> worker-owned staged copy, exact raw-hash check
  -> fresh Safe-Scene 3ds Max Batch process
  -> full manifest re-verification before renderer changes
  -> temporary Corona materials + one temporary CoronaLight
  -> canonical camera_living_a preview PNG + portable evidence
  -> process exit without save
```

- The profile is explicitly `trusted_diagnostic_profile`, with ID
  `golden_living_corona_preview_v1`. It contains one execution-only area light
  named `AVZ_PREVIEW_CORONA_KEY`; it has no `AIArchViz.LogicalObjectId` and is
  never canonical SceneSpec lighting state.
- The existing 8B material, deduplication, FOV, area-light, 320 × 240, and
  four-pass policies are reused. The rev8 material assignments and
  `camera_living_a` resolve through `AIArchViz.LogicalObjectId`, not display
  names. Unassigned canonical objects retain their existing neutral DCC state.
- The runner opens only the staged input `.max`, normalizes and compares the
  full 14-managed-node manifest before temporary changes, then never calls a
  save operation. It proves both staged and canonical raw artifact hashes are
  unchanged after rendering.
- Preview evidence separates canonical source identity/materials/assignments/
  camera from temporary Corona realization, renderer policy, profile light,
  and output integrity. It contains no absolute paths. PNG pixels remain
  non-canonical evidence rather than a cross-machine byte oracle.

Rendering an existing verified scene does not create `rev_golden_0009`, change
head revision, or write renderer intent into SceneSpec. Canonical lighting and
render-intent changes require a separate future revision contract. The next
desired task after a verified 8C pass is **Technical Spike 8D — Canonical
Lighting + Render Intent Revision Contract**.

## Spike 8D: canonical render-state revision contract

Spike 8D turns the previously diagnostic-only renderer intent into two
deterministic SceneChangeSet revisions: `SetRenderIntent` creates rev9 with
`render.engine: "corona"` and `render.mode: "preview"`; `AddLight` creates rev10
with exactly one canonical `light_living_key_area` area light. Its transform is
`position [3000,1600,2800]`, `rotationEuler [-35,0,0]`, `scale [1,1,1]`, and
canonical intensity `1.25`. The DCC realization maps that intensity to `150`
using the fixed adapter scalar `120` and uses the fixed `800 mm` area width.

Each change remains one operation (`SceneChangeSet.maxItems = 1`). The pure
SceneSpec transition is checked before execution; stale, unchanged, duplicate,
wrong-target, and renderer-prerequisite requests fail closed. A fresh
Safe-Scene process verifies the actual Corona renderer and canonical light,
emits the separate `canonical-render-state-v0.1` evidence contract, and never
saves renderer-modified `.max` state. Rev8 and rev9 artifacts remain hash-
preserved, and replay uses the verified evidence without a second DCC mutation.
This spike's compatibility evidence targets 3ds Max `2025.3`; no 2026
verification is claimed.

## Spike 8E: canonical Golden Corona preview from rev10

Where 8C rendered a non-canonical diagnostic preview of the pre-canonical
rev8 scene (temporary light, diagnostic compiler, `render.engine: none`
source), and 8D turned renderer/light intent into canonical rev9/rev10
revision state without rendering, 8E renders the first preview whose
renderer and light intent are both already-canonical rev10 SceneSpec state:

```text
verified rev10 .max (built through the real r2..r10 pipeline)
  + rev10 SceneSpec + render-job-v0.2(camera_living_a)
  -> normal CoronaRendererAdapter.compile() (no diagnostic profile)
  -> worker-owned staged copy, exact raw-hash check
  -> fresh Safe-Scene 3ds Max Batch process
  -> full manifest re-verification, then canonical render-state re-verification
  -> obsolete-diagnostic-light absence check
  -> persisted canonical CoronaLight reused, never recreated
  -> temporary Corona materials realized onto canonical assignment targets
  -> persisted camera_living_a and persisted Corona renderer reused, not switched
  -> 320 x 240 / four-pass preview PNG + portable evidence
  -> process exit without save
```

- The compiled plan is the same `corona-execution-plan-v0.1` shape 8B/8D
  already use; its `geometry` field is produced for validation only and is
  never used to rebuild the opened scene, which is loaded directly from the
  staged rev10 `.max` via a documented non-interactive load call.
- The runner never assigns or reconfigures the renderer (`renderers.production`
  is only observed and pass-limited); an already-non-Corona persisted renderer
  fails closed rather than falling back.
- `canonical-corona-preview-evidence-v0.1` records `intentSource:
  "canonical_scene_spec"` (never `trusted_diagnostic_profile`), the rev10
  identity, SceneSpec/canonical/staged artifact hashes, a deterministic
  request hash derived only from those hashes plus revision/camera/render
  policy (no absolute paths, PID, timestamp, or PNG hash), the reused
  canonical light(s) sorted by `logicalId`, temporary material realizations
  with proven same-ID-to-same-instance deduplication, the reused camera, and
  output integrity. It contains no absolute paths.
- Rendering rev10 does not create `rev_golden_0011`, change head revision, or
  mutate canonical or staged artifact bytes; both are hash-verified unchanged
  after the DCC process exits. This spike's compatibility evidence targets
  3ds Max `2025.3`; no 2026 verification is claimed.

## Spike 8F: canonical material appearance contract

Spike 8F promotes the first renderer-independent material *appearance*
properties — `roughness` and `metalness` — from Corona adapter defaults into
canonical SceneSpec semantics, without touching any existing Golden revision.

- SceneSpec v0.2 is unchanged and remains valid as-is; `scene-spec-v0.3`
  is a new, separate schema (`sceneSpecVersion: "0.3.0"`) whose material
  additionally requires `roughness` and `metalness`, both normalized `0..1`.
  `roughness` is renderer-neutral micro-surface roughness intent (`0` smooth,
  `1` rough); `metalness` is renderer-neutral metallic-workflow intent (`0`
  dielectric, `1` metal). Neither is IOR, specular level, or reflection.
  There is no automatic v0.2-to-v0.3 migration: a v0.2 material's `roughness:
  0.45` adapter default was never a canonical design decision, so no v0.3
  document is ever backfilled with it, and Golden `rev_golden_0001`
  through `rev_golden_0010` remain v0.2 and untouched.
- `CoronaRendererAdapter.compile()` is unchanged: a v0.2 SceneSpec still
  compiles to `corona-execution-plan-v0.1`, whose material realization keeps
  filling roughness `0.45` and non-metal mode from the legacy
  `coronaAdapterMaterialDefaults` compatibility constant. A new,
  separate `compileCanonicalMaterialAppearance()` method accepts only a v0.3
  SceneSpec and compiles it to `corona-execution-plan-v0.2`, whose material
  `roughness`/`metalness` always come directly from SceneSpec; that plan's
  `adapterDefaults` carries no material sub-object at all, so there is no
  hidden fallback if either canonical value is absent (schema validation
  rejects the SceneSpec before compilation is ever reached).
- Material identity for realization and deduplication is always
  `materialId`, never appearance-value equality: the same `materialId`
  assigned to multiple targets realizes to one shared native Corona Physical
  Material instance, while two distinct `materialId`s with byte-identical
  `baseColorRgb`/`roughness`/`metalness` always realize to two distinct
  native instances. The dedicated fixture under
  `tests/fixtures/corona-material-appearance/` proves both directions with
  four materials (rough and smooth dielectric, one metallic, and one
  value-duplicate of the rough dielectric under a different ID).
- The DCC runner (`render_corona_material_appearance.py`) is a capability
  proof, not a render: it discovers Corona, creates one native Corona
  Physical Material per canonical material, maps `baseColorRgb` to the
  discovered base-color property, `roughness` to the discovered roughness
  property, and `metalness` to whichever native representation the installed
  Corona Physical Material actually exposes (a scalar metalness property, or
  an enum metalness mode for exact `0`/`1` values) — never by swapping
  material classes. A roughness or metalness property that the installed
  Corona version does not expose at all fails closed with
  `CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED` /
  `CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED` rather than emulating it.
  No render call is made, no PNG is produced, and the scene is never saved.
- `corona-material-appearance-evidence-v0.1` records, per material, the
  installed native class, canonical intent, and observed
  `baseColorRgb`/`roughness`/`metalness` side by side (small float
  tolerances absorb native conversion noise without creating a new
  machine-dependent SceneSpec revision), plus a `deduplication` proof
  (`sameIdSharedInstance`, `differentIdDistinctInstances`). It contains no
  absolute paths. This spike's compatibility evidence targets 3ds Max
  `2025.3`; no 2026 verification is claimed.

## Spike 8G: canonical material appearance revision for the Golden scene

8F proved that Corona Physical Material realization and property mapping
work as a standalone capability; 8G persists that capability into the first
canonical Golden revision, `rev_golden_0011`, whose material appearance is
explicit SceneSpec v0.3 state saved into a verified editable `.max`.

- `rev_golden_0011`'s `MigrateMaterialAppearanceContract` values are
  hand-picked, not the 8F/8B adapter default: `material_wall_neutral`
  roughness `0.62`, `material_floor_neutral` roughness `0.34`,
  `material_sofa_proxy` roughness `0.78`, all `metalness: 0`. The old
  adapter-owned `0.45` roughness default is never auto-promoted into a
  canonical revision.
- `rev_golden_0001` through `rev_golden_0010` remain byte-identical and
  SceneSpec v0.2; only `rev_golden_0011` is v0.3. The migration changes zero
  nodes, cameras, base colors, material IDs, names, order, or assignments,
  so the semantic manifest diff between rev10 and rev11 is empty (`changed:
  []`, all 14 managed items `unchanged`) — material appearance lives only in
  SceneSpec's top-level `materials[]`, which the manifest never tracks. The
  already-canonical render state (`corona`/`preview` plus
  `light_living_key_area`) and its evidence are re-verified, not altered.
- `apply_change_set.py` accepts `revisionPlanVersion` `0.1.0` or `0.2.0` and
  adds one new scene-scoped operation branch that reuses
  `render_corona_material_appearance.py`'s discovery, creation, and
  property-mapping functions rather than a third independent mapping. It
  replaces each pre-migration `AVZ_MATERIAL_{materialId}` StandardMaterial
  with a same-named native Corona Physical Material, requires the
  production renderer to already be Corona (set by the persisted rev9
  intent), and fails closed with the same 8F error codes
  (`CORONA_MATERIAL_CLASS_NOT_FOUND`,
  `CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED`,
  `CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED`) rather than inventing new
  ones. `verify_scene.py`'s native-material check is broadened
  backward-compatibly to accept either StandardMaterial (rev1–rev10) or
  Corona Physical Material (rev11+); no rev1–rev10 behavior changes.
- Promotion requires three independent verifiers to pass, not two: the
  existing fresh semantic-manifest verifier, the existing fresh canonical
  render-state verifier (still sticky once `render.engine`/`mode` are set,
  so it re-runs and must still observe the unchanged light), and a new fresh
  canonical material-state verifier (`verify_canonical_material_state.py`,
  its own independent DCC process, separate from the mutation process and
  from the other two verifiers) validated against
  `canonical-material-state-v0.1`. Every verifier's evidence is written as
  the tolerance-checked canonical values, not the raw runtime observation,
  matching the normalization pattern `canonical-render-state-v0.1` already
  established.
- MaterialId, never appearance value, is the deduplication key, re-proven in
  the fresh material-state verifier process (not only at mutation time):
  `material_floor_neutral` is shared by two targets (`wall_south` and
  `surface_floor_main`, a pre-existing rev4 assignment) and must resolve to
  one native instance, while every distinct `materialId` must resolve to a
  distinct native instance even where appearance values coincide. This
  spike's compatibility evidence targets 3ds Max `2025.3`; no 2026
  verification is claimed.
