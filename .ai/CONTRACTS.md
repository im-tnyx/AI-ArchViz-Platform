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
