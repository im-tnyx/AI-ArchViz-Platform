# CAD Scene Seed (reviewed CAD -> canonical SceneSpec)

## 1. The upstream chain

| Stage | Contract | Question answered | Authority |
| --- | --- | --- | --- |
| 10A ([CAD-INGESTION.md](CAD-INGESTION.md)) | `cad-document-v0.1` | What exactly is in this DXF? | the source bytes |
| 10B ([CAD-INTERPRETATION.md](CAD-INTERPRETATION.md)) | `architectural-extraction-v0.1` | Which architectural candidates follow from it under an explicit profile? | CAD evidence + profile + deterministic derivation |
| 10C (this document) | `cad-scene-seed-approval-v0.1` -> SceneSpec v0.4 | Which reviewed candidates become canonical, under which identity? | an explicit human approval |

```text
DXF bytes -> 10A cad-document -> 10B architectural extraction (READY_FOR_REVIEW)
          -> EXPLICIT approval (approved_as_is, bound by hash)
          -> canonical logical IDs + non-CAD state
          -> SceneSpec v0.4 seed -> SceneSpec / 9A spatial / 9C circulation validation
          -> existing build-scene pipeline -> fresh semantic verification -> editable .max
```

No AI, no automatic approval, and no Golden revision is touched: the seed is
a separate project (`project_cad_seed_living_001`), and Golden rev1-rev13
stay byte-identical with no rev14.

## 2. READY_FOR_REVIEW is not approval

`architectural-extraction-v0.1` always carries `status: "READY_FOR_REVIEW"`.
That means deterministic candidates awaiting a human; it never means
APPROVED, CANONICAL, or SAFE_TO_BUILD. `createSceneSpecSeed` refuses to run
without a valid approval artifact. There is no `autoApprove`, no implicit
approval, no approval-by-successful-interpretation, and no confidence
threshold.

## 3. Policy and approval contract

- **`cad-scene-seed-policy-v0.1`** is the software-owned canonicalization
  algorithm. The approval pins it exactly (`canonicalizationPolicy`); there
  is no "latest".
- **`cad-scene-seed-approval-v0.1`**
  (`packages/cad-scene-seed/schema/cad-scene-seed-approval-v0.1.schema.json`,
  `validateCadSceneSeedApproval`) is declarative JSON only: no callbacks,
  expressions, scripts, templates, or code. Fields:
  - `approvalVersion: "0.1.0"`, `approvalId` (canonical ID grammar);
  - `decision`: `approved_as_is`, `rejected`, or `changes_requested` (only
    `approved_as_is` is canonicalizable; the others fail with
    `CAD_SCENE_SEED_NOT_APPROVED`);
  - `extraction`: the exact `architecturalExtractionVersion`,
    `interpretationPolicyVersion`, `profileId`,
    `architecturalExtractionHash`, `sourceHash`, `cadDocumentHash`, and
    `profileHash` being approved;
  - `canonical`: `project.{id, name}` and `scene.{id, revisionId,
    createdAt}`;
  - `lockPolicy: "all_unlocked"` (the only v0.1 policy, written explicitly
    onto every wall, surface, and opening);
  - `mappings`: candidate -> logical ID for every level, space (plus its
    floor and ceiling surface IDs), wall, and opening;
  - `nonCadState`: `sources`, `assetDefinitions`, `assets`, `materials`,
    `materialAssignments`, `lights`, `cameras`, `render`,
    `circulationRequirements`, each validated by **reference** to the
    normative SceneSpec v0.4 `$defs` (not a duplicated schema; SceneSpec
    v0.4 itself is unchanged).

## 4. approved_as_is and no overrides

v0.1 supports only approval as-is. The approval schema has no field that can
carry an architectural value, and `additionalProperties: false` everywhere,
so an attempt to add wall thickness, a boundary, an opening width or offset,
a ceiling height, or a top-level `overrides` object is rejected by the
schema (`CAD_SCENE_SEED_APPROVAL_INVALID`).

If a reviewer finds a wrong thickness, room type, door size, host, or
ceiling height, the fix is: correct the 10B interpretation profile, rerun
10B (producing a new `architecturalExtractionHash`), review again, and
approve the new extraction. The approval is never a hidden geometry patch.

## 5. Exact extraction binding

The canonicalizer recomputes the RFC 8785 semantic hash of the supplied
extraction and requires it to equal `extraction.architecturalExtractionHash`;
`sourceHash`, `cadDocumentHash`, `profileHash`, and `profileId` are
cross-checked against the extraction as well. Any difference (for example an
approval for extraction H1 used with a modified extraction H2) fails with
`CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH` before any SceneSpec exists. There
is no fuzzy remapping: if the extraction changes, the approval is stale.

## 6. Candidate -> canonical mappings

Canonical logical IDs come exclusively from the approval. The canonicalizer
never derives an ID from candidate order, DXF handles, source ordinals, room
labels, wall orientation, or coordinates (`wall_south` in the fixture is a
human-approved name, not a computed one). Each mapping array must be sorted
by `candidateId` in code-point order (unsorted input is rejected, never
silently sorted, which also stabilizes the approval hash).

| Failure | Code |
| --- | --- |
| a candidate with no mapping | `CAD_SCENE_SEED_MAPPING_INCOMPLETE` |
| a mapping for a candidate not in the extraction | `CAD_SCENE_SEED_MAPPING_UNKNOWN_CANDIDATE` |
| a candidate mapped twice | `CAD_SCENE_SEED_MAPPING_DUPLICATE` |
| one logical ID used twice (across levels, spaces, surfaces, walls, openings, assets, cameras, lights) | `CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE` |
| unsorted mapping array | `CAD_SCENE_SEED_MAPPING_UNSORTED` |

## 7. SceneSpec generation (architectural facts are immutable)

Every architectural fact is copied from the approved extraction, never from
the approval: level name/elevation/ceiling height, space type and boundary,
floor elevation, wall start/end, base elevation, height, thickness,
`referenceLine`/`thicknessDirection`, opening type, host, offset, width,
sill, height, door hinge side and swing direction.

- **Vectors:** 10B `[x, y]` becomes `[x, y, levelElevation]`; no recentering,
  axis swap, or origin move.
- **Coordinate system:** fixed by the policy (`mm`, `degree`, `Z` up, right
  handed, `X_east_Y_north_Z_up`, origin `[0, 0, 0]`).
- **Level:** one, mapped ID, 10B values.
- **Spaces:** mapped ID and level, 10B `spaceType`, boundary at the floor
  elevation, `counter_clockwise`, 10B floor elevation and ceiling height,
  identity transform.
- **Walls:** mapped ID, level, owning space; 10B geometry; identity
  transform; all-unlocked.
- **Surfaces:** one floor and one ceiling per space with approval-supplied
  IDs, the exact space boundary, thickness 0, `extrusionDirection: "none"`;
  floor elevation = floor elevation, ceiling elevation = floor elevation +
  ceiling height; transform position `[0, 0, elevation]` (identity for a
  ground-level floor, `[0, 0, 3000]` for the fixture ceiling, matching the
  existing convention).
- **Openings:** mapped ID; `hostGeometryId` is the mapped ID of 10B's host
  wall candidate (host resolution is never rerun); 10B offset, width, sill,
  height, hinge, swing; transform position `[offset, 0, sill]` (the existing
  SceneSpec opening convention, not a world-space location).
- **Initial revision:** `scene.revisionId = scene.headRevisionId =` the
  approved revision ID, and `revisions` holds exactly one committed revision
  with `parentRevisionId: null` and the approval-supplied `createdAt`. This
  is an initial canonical seed, not a SceneChangeSet revision: no base
  revision, no `revision.ts`, no migration operation.

## 8. Non-CAD state authority

SceneSpec needs state that no CAD source carries. The approval supplies it
explicitly, and it is labeled as approval-supplied design input, never as
DXF-derived. The dedicated fixture keeps it minimal: one procedural proxy
coffee table (`asset_cad_seed_table_main` at `[3000, 2200, 0]`), one camera
(`camera_cad_seed_a`, 28 mm), `render: { engine: "none", mode: "build_only" }`,
and empty `materials`, `materialAssignments`, `lights`, and
`circulationRequirements`. No Corona dependency exists.

Source metadata must include a `dxf` source content-addressed as
`urn:sha256:<raw DXF byte hash>` (equal to the approved `sourceHash`), and
no source URI may be a local filesystem path (drive letter, absolute, UNC,
`file:`, relative, or `~`), failing with `CAD_SCENE_SEED_SOURCE_INVALID`.
Asset, camera, and material-assignment references must resolve
(`CAD_SCENE_SEED_REFERENCE_INVALID`).

## 9. Provenance extension

The generated SceneSpec carries the vendor-qualified extension
`aiarchviz.cad_seed` (SceneSpec v0.4's existing `extensions` namespace, so
no v0.5 is needed): `version: "0.1.0"`, `canonicalizationPolicy`,
`approvalId`, `approvalHash`, `profileId`, `sourceHash`, `cadDocumentHash`,
`profileHash`, `architecturalExtractionHash`, and the compact candidate ->
logical-ID mappings. It contains hashes, IDs, policy versions, and mappings
only: never a source, workspace, temporary path, or user name.

## 10. Validation order and the six-hash chain

1. validate architectural-extraction-v0.1;
2. validate the approval schema;
3. require `approved_as_is`;
4. verify the exact hash binding;
5. verify mapping order, completeness, and uniqueness;
6. generate the complete SceneSpec;
7. `validateSceneSpec()` plus reference and source-metadata checks;
8. `validateSpatialScene()` (an approved asset can never bypass 9A:
   `CAD_SCENE_SEED_SPATIAL_INVALID` carries the underlying `SPATIAL_*` code);
9. `evaluateCirculationRequirements()` (`CAD_SCENE_SEED_CIRCULATION_UNSATISFIED`).

Only after all of these may the worker write a seed or invoke DCC.

| Link | Hash |
| --- | --- |
| DXF bytes | `sourceHash` |
| normalized CAD document | `cadDocumentHash` |
| interpretation profile | `profileHash` |
| architectural extraction | `architecturalExtractionHash` |
| human approval | `approvalHash` (RFC 8785; key order and whitespace do not matter) |
| SceneSpec seed | `sceneSpecHash` |

`cad-scene-seed-evidence-v0.1` (worker-contracts) records the six hashes,
`approvalId`, canonical project/scene/revision identity, mapping counts, and
the PASS spatial and circulation results, with no paths.

## 11. Worker, CLI, and build

`apps/worker/src/cad-scene-seed.ts` provides `createCadSceneSeed` (pure),
`seedSceneFromCadFiles`, and `writeCadSceneSeed`, using the post-10A
lexical and physical path-containment helpers for both inputs and both
outputs, never overwriting an input.

```bash
pnpm worker seed-scene-from-cad tests/fixtures/cad/interpretation/simple-living-room/expected-architectural-extraction-v0.1.json tests/fixtures/cad/scene-seed/simple-living-room/approval-v0.1.json cad/seed-scene-spec.json
```

The command consumes an architectural extraction; it never re-reads DXF,
reruns 10A, or reruns 10B.

**First DXF -> editable .max path** (`pnpm test:3dsmax:cad-scene-seed`): the
integration runs 10A, 10B, and 10C from the fixture DXF, proves every frozen
hash, then feeds the generated seed into the SAME `build-scene` pipeline as
every other initial build (`compileGoldenBuildPlan` -> `build_scene.py` ->
fresh `verify_scene.py` -> comparison with an independently frozen expected
manifest -> promotion), through the centralized batch policy, the sanitized
DCC environment, and default-deny execution. No render occurs. No
CAD-specific builder exists; the build path needed no SceneSpec v0.4 change.

**Build envelope:** since the post-10C polygon surface realization closure
(build plan v0.2, [DCC-SURFACE-REALIZATION.md](DCC-SURFACE-REALIZATION.md)),
the shared initial build realizes every floor/ceiling as an exact editable
polygon mesh, so translated, non-axis-aligned, and concave simple rooms are
buildable. `assertSeedBuildRealizable()` runs the same `compileSurfaceMesh`
as the build and refuses, before DCC (`CAD_SCENE_SEED_BUILD_UNSUPPORTED`),
only what v0.2 cannot realize exactly: surface rotation/scale and non-simple
or non-coplanar boundaries.

## 12. Out of scope

Multi-room/shared-wall interpretation, a production DWG adapter, a review UX,
geometry edits during approval, and AI-assisted interpretation are all out of
scope and not started.
