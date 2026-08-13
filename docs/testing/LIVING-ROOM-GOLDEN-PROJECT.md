# Living Room Golden Project

**Status:** Contract Ready for Technical Spike
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Purpose:** Define the first deterministic end-to-end benchmark for SceneSpec, validation, worker execution, 3ds Max scene generation, fresh-process verification, and safe replay.

---

## 1. Why This Golden Project Exists

The platform needs one small, stable and repeatable scene that every major architecture layer can be tested against.

This project is intentionally synthetic. Its dimensions, objects and expected outputs are test fixtures, not assumptions about a real client project.

The golden project must remain simple enough to debug while still exercising the core production pipeline:

```text
Known Input
    ↓
Known SceneSpec
    ↓
Validation
    ↓
3ds Max Worker
    ↓
Generated Scene
    ↓
Verification
    ↓
Known Revision Cases
    ↓
Repeat Verification
```

The purpose is not to prove design quality yet. The purpose is to prove that the platform can generate and revise a deterministic editable scene without geometry drift.

---

## 2. Golden Project Identity

```text
Project ID: project_golden_living_001
Scene ID: scene_golden_living_001
Project Name: Living Room Golden Project 001
Units: mm
SceneSpec Version: 0.1.0
Primary DCC: 3ds Max
Spike 1 Renderer: none
Future Preview Renderer: Corona
```

All test fixtures must use stable logical IDs.

---

## 3. Test Modes

The broader Golden project may later support the two evidence-input modes
below. Technical Spike 1 consumes the repository-controlled SceneSpec fixture
directly and does not parse plans, elevations, or reference images.

### Mode A: Plan + References

```text
Synthetic Plan
+
Reference Set
+
Verified Ceiling Height
```

This mode tests progressive input behavior when no elevation is available.

### Mode B: Plan + Elevation + References

```text
Synthetic Plan
+
Synthetic Elevations
+
Reference Set
```

This mode tests plan/elevation registration and higher-confidence vertical geometry.

Reference images are design evidence only. They must not override verified architectural dimensions.

---

## 4. Canonical Room Geometry

The test room is a simple rectangular living room.

The authoritative machine fixture is
`tests/fixtures/living-room-golden/scene-spec.json`. This document explains
that fixture; it does not define an alternate serialization.

```text
Internal Width X: 6000 mm
Internal Length Y: 4500 mm
Finished Floor Z: 0 mm
Finished Ceiling Z: 3000 mm
Wall Thickness: 150 mm
```

Canonical SceneSpec coordinate system rules are inherited from:

```text
COORDINATES-UNITS-AND-SPATIAL-CONVENTIONS.md
```

Room local origin:

```text
[0, 0, 0]
```

Room internal polygon:

```text
P0 = [0, 0, 0]
P1 = [6000, 0, 0]
P2 = [6000, 4500, 0]
P3 = [0, 4500, 0]
```

---

## 5. Canonical Walls

Logical wall IDs:

```text
wall_south
wall_east
wall_north
wall_west
```

Expected wall baselines:

```text
wall_south: [0,0,0] → [6000,0,0]
wall_east:  [6000,0,0] → [6000,4500,0]
wall_north: [6000,4500,0] → [0,4500,0]
wall_west:  [0,4500,0] → [0,0,0]
```

Expected height:

```text
3000 mm
```

Expected thickness:

```text
150 mm
```

No wall may be silently resized by reference analysis or AI planning.

---

## 6. Door Fixture

Logical ID:

```text
opening_d01
```

Host wall:

```text
wall_west
```

Door type:

```text
single_hinged
```

Expected dimensions:

```text
Width: 900 mm
Height: 2100 mm
Sill: 0 mm
```

Authoritative host-local placement:

```text
offset from directed wall_west start: 2400 mm
opening interval along +U: [2400, 3300] mm
world Y interval: [2100, 1200] mm along directed -Y
hingeSide: start_jamb
swingDirection: into_room
```

Door swing metadata must be preserved even if the first 3ds Max prototype represents the opening with simplified geometry.

---

## 7. Window Fixture

Logical ID:

```text
opening_w01
```

Host wall:

```text
wall_north
```

Expected dimensions:

```text
Width: 2400 mm
Height: 1500 mm
Sill: 750 mm
Head: 2250 mm
```

Authoritative host-local placement:

```text
offset from directed wall_north start: 1800 mm
opening interval along +U: [1800, 4200] mm
world X interval: [4200, 1800] mm along directed -X
```

Expected left/right wall clearance:

```text
1800 mm each side
```

Mode A may infer vertical window values only if explicit values are not supplied. For this golden test, the values above are verified and therefore authoritative.

---

## 8. Floor and Ceiling Fixtures

Floor logical ID:

```text
surface_floor_main
```

Ceiling logical ID:

```text
surface_ceiling_main
```

Floor elevation:

```text
0 mm
```

Ceiling elevation:

```text
3000 mm
```

Initial prototype may use simple planar geometry.

The test fails if:

- floor is not at Z=0
- ceiling is not at Z=3000
- floor or ceiling dimensions differ from the room polygon beyond configured tolerance

---

## 9. Furniture Fixtures

The first worker spike must not depend on an external commercial asset library.

Therefore the golden scene initially uses primitive proxy assets with stable semantic IDs.

### Main Sofa

Logical object ID:

```text
asset_living_sofa_main
```

Proxy dimensions:

```text
Width: 2400 mm
Depth: 950 mm
Height: 780 mm
```

Authoritative transform and pivot:

```text
position: [3000, 3350, 0]
rotationEuler: [0, 0, 180]
scale: [1, 1, 1]
pivotPolicy: floor_center
```

### Coffee Table

Logical object ID:

```text
asset_living_coffee_table_main
```

Proxy dimensions:

```text
Width: 1200 mm
Depth: 650 mm
Height: 380 mm
```

Authoritative transform and pivot:

```text
position: [3000, 2200, 0]
rotationEuler: [0, 0, 0]
scale: [1, 1, 1]
pivotPolicy: floor_center
```

### TV / Focal Unit Proxy

Logical object ID:

```text
asset_living_tv_unit_main
```

Host relationship:

```text
wall_south
```

Proxy dimensions:

```text
Width: 2400 mm
Depth: 400 mm
Height: 500 mm
```

Authoritative transform and pivot:

```text
position: [3000, 200, 0]
rotationEuler: [0, 0, 0]
scale: [1, 1, 1]
pivotPolicy: floor_center
hostGeometryId: wall_south
```

Proxy assets are temporary execution fixtures. Their logical IDs must survive later replacement with real production assets.

---

## 10. Material Fixtures

The first golden project uses a deliberately small material set.

### Wall Material

```text
material_wall_neutral
```

Semantic intent:

```text
warm neutral paint
```

### Floor Material

```text
material_floor_neutral
```

Semantic intent:

```text
light stone / neutral surface
```

### Sofa Material

```text
material_sofa_proxy
```

Semantic intent:

```text
warm beige fabric
```

The early worker test may assign simple Corona-compatible values rather than final texture maps.

Material identity must remain stable during revisions.

---

## 11. Lighting Fixture

Initial lighting intentionally stays simple.

### Environment / Primary Light

Logical ID:

```text
light_primary
```

Spike 1 creates no light node and uses `render.engine=none`. Lighting and
renderer-specific values are outside the deterministic base-build oracle.

Renderer-specific values belong in the Corona adapter, not in the canonical architectural logic.

---

## 12. Camera Fixtures

The golden project defines three stable camera IDs.

### Camera A

```text
camera_living_a
```

Purpose:

```text
Primary hero view toward south focal wall
```

Authoritative target-based camera:

```text
Position: [1200, 3800, 1500]
RotationEuler: [-2.844710, 0, 206.565051]
Target:   [3000, 200, 1300]
Focal Length: 24 mm
Sensor Width: 36 mm
```

### Camera B

```text
camera_living_b
```

Purpose:

```text
Secondary diagonal room view
```

Authoritative target-based camera:

```text
Position: [5000, 800, 1500]
RotationEuler: [-3.762330, 0, 43.667780]
Target:   [2900, 3000, 1300]
Focal Length: 24 mm
Sensor Width: 36 mm
```

### Camera C

```text
camera_living_c
```

Purpose:

```text
Window-side reverse view
```

Authoritative target-based camera:

```text
Position: [3000, 3950, 1500]
RotationEuler: [-3.878525, 0, 180]
Target:   [3000, 1000, 1300]
Focal Length: 28 mm
Sensor Width: 36 mm
```

These are test fixtures, not final architectural-photography recommendations.

For the Golden profile, `orientationPolicy=look_at_target`; target is the
orientation authority and `rotationEuler` is its precomputed canonical value.
Camera A direction is `[1800,-3600,-200]`, so its negative Y component proves
that it looks toward `wall_south`.

The worker must preserve camera logical IDs and transforms within tolerance.

---

## 13. Normative Machine Contracts

The Golden fixture uses only the canonical root vocabulary defined by:

```text
packages/scene-spec/schema/scene-spec-v0.1.schema.json
tests/fixtures/living-room-golden/scene-spec.json
tests/fixtures/living-room-golden/expected-scene-manifest.json
tests/fixtures/living-room-golden/fixture-manifest.json
tests/fixtures/living-room-golden/job-envelope.json
tests/fixtures/living-room-golden/hash-vectors.json
```

No `version/walls/surfaces/objects` root variant is accepted.

`hash-vectors.json` freezes semantic JSON content hashing across key order,
indentation, LF/CRLF, and trailing-newline differences. It also proves that a
semantic value change produces a different hash. The normative algorithm is
defined in `docs/architecture/3DS-MAX-WORKER-ARCHITECTURE.md`.

---

## 14. Evidence Fixtures

Every important architectural value must carry provenance.

Example:

```json
{
  "value": 3000,
  "unit": "mm",
  "provenance": {
    "sourceType": "verified_test_fixture",
    "sourceId": "golden_living_001",
    "authority": "A5"
  }
}
```

For the Golden test, canonical dimensions use `A5` because the existing
evidence hierarchy defines it as locked/approved truth. Authority and
confidence remain separate; the fixture also records confidence `1.0`.

AI is not allowed to override them.

---

## 15. Expected Worker Build Sequence

The first deterministic worker run should perform:

```text
1. Validate job envelope
2. Validate SceneSpec
3. Start clean 3ds Max execution context
4. Normalize 3ds Max units to millimeters
5. Create room geometry
6. Create wall openings
7. Create floor
8. Create ceiling
9. Create proxy furniture
10. Assign basic materials
11. Create test lighting
12. Create cameras
13. Stamp logical IDs into managed nodes
14. Save candidate .max
15. Exit the build process
16. Start a fresh second 3ds Max process
17. Reopen candidate/project.max
18. Extract verification/scene-manifest.json
19. Compare against expected-scene-manifest.json
20. Promote output/project.max only on PASS
21. Write output/execution-report.json
22. Persist the idempotency result
```

No AI call is required for this test.

---

## 16. Required Output Artifacts

A passing Golden run produces these exact artifact roles:

```text
.workspace/job_<jobId>/
  candidate/project.max
  verification/scene-manifest.json
  output/project.max
  output/execution-report.json
```

No render artifact is required for Spike 1.

---

## 17. Geometry Verification

After scene creation, verification must compare expected and actual managed geometry.

Minimum checks:

```text
Room width = 6000 mm ± tolerance
Room length = 4500 mm ± tolerance
Ceiling height = 3000 mm ± tolerance
Door width = 900 mm ± tolerance
Door height = 2100 mm ± tolerance
Window width = 2400 mm ± tolerance
Window height = 1500 mm ± tolerance
Window sill = 750 mm ± tolerance
```

Golden comparison tolerances are fixed by `fixture-manifest.json`:

```text
geometryToleranceMm  = 0.01
transformToleranceMm = 0.01
rotationToleranceDeg = 0.001
```

No critical object may have non-uniform scale unless explicitly allowed.

No managed object may be mirrored accidentally.

---

## 18. Identity Verification

Every managed test object must contain recoverable platform identity.

At minimum:

```text
AIArchViz.LogicalObjectId
AIArchViz.ProjectId
AIArchViz.SceneId
AIArchViz.RevisionId
```

The reconciliation layer must be able to resolve:

```text
SceneSpec logical object
↔
3ds Max node
```

without relying only on node display names.

---

## 19. Idempotency Test

Run the same build job twice.

Expected result:

```text
Run 1 → valid scene
Run 2 → same logical scene state
```

The second run must not create duplicate:

- walls
- openings
- assets
- cameras
- lights

Idempotency is a mandatory worker property.

---

## 20. Revision Test R1: Replace Sofa

Initial logical object:

```text
asset_living_sofa_main
```

Revision intent:

```text
Replace sofa proxy with alternate sofa proxy.
```

Expected behavior:

```text
Logical object ID remains unchanged
Asset definition changes
Position remains unchanged unless validation requires adjustment
Revision record is created
Affected camera renders are invalidated
Unrelated walls/openings/cameras remain unchanged
```

The test fails if replacing the sofa causes the whole room to regenerate with different geometry.

---

## 21. Revision Test R2: Move Coffee Table

Change:

```text
Move asset_living_coffee_table_main +250 mm on X
```

Expected behavior:

```text
Only coffee table transform changes
Wall geometry remains byte/logically equivalent where applicable
Sofa remains unchanged
Cameras remain unchanged
Affected renders become stale
```

Validation must reject the move if a future test value would place the table outside the room or in an invalid collision state.

---

## 22. Revision Test R3: Change TV Wall Material

Change:

```text
Assign alternate material to wall_south finish
```

Expected behavior:

```text
wall_south geometry unchanged
material assignment changes
other wall materials unchanged
camera transforms unchanged
render outputs invalidated
```

---

## 23. Revision Test R4: Lock Ceiling

Operation:

```text
Lock geometry property on surface_ceiling_main
```

Then propose:

```text
Change ceiling elevation from 3000 mm to 2850 mm
```

Expected outcome:

```text
BLOCK
```

Approval cannot override a hard lock. An explicit auditable unlock operation
must create a new valid state before any DCC mutation.

---

## 24. Revision Test R5: Revised Elevation Arrives

New evidence:

```text
Verified elevation changes opening_w01 sill from 750 mm to 900 mm
```

Expected behavior:

```text
Evidence conflict is detected
Higher-authority revised elevation is linked
SceneChangeSet targets opening_w01 only
Window vertical placement updates
Wall identity remains stable
Unrelated objects remain unchanged
Affected renders are invalidated
Revision is auditable
```

This test proves progressive input accuracy.

---

## 25. Failure Test F1: Stale Revision

Submit a SceneChangeSet with an outdated `baseRevisionId`.

Expected result:

```text
BLOCK
```

The worker must not execute stale mutations.

---

## 26. Failure Test F2: Duplicate Job

Submit the exact same job twice with the same idempotency key.

Expected result:

```text
No duplicate scene mutation
No duplicate managed objects
Safe replay or previously-completed response
```

---

## 27. Failure Test F3: Missing Renderer

If Corona is unavailable:

Expected behavior:

```text
3ds Max scene build may still pass if renderer-independent portions are valid
Render step reports structured capability error
Candidate scene is not corrupted
Worker does not silently switch production renderer unless policy explicitly allows it
```

---

## 28. Failure Test F4: Missing Asset

If a referenced production asset file is unavailable:

Expected behavior:

```text
Preflight detects missing asset
Production mutation is blocked before partial scene corruption
Structured error identifies logical object and missing resource
```

Proxy fixture assets used by the initial golden test should be generated locally and therefore avoid this dependency.

---

## 29. Failure Test F5: Worker / 3ds Max Crash

Simulate interruption during candidate scene generation.

Expected behavior:

```text
Approved project.max remains untouched
Incomplete candidate is quarantined or deleted
Job is marked failed/retryable according to policy
Logs survive process crash where possible
A retry starts from a known scene state
```

---

## 30. Future Preview Render Requirements (Excluded from Spike 1)

Future preview target:

```text
1280 × 720
```

This value is a test default, not a permanent product limit.

Required checks:

- camera exists
- renderer invocation completes or returns structured capability failure
- output file exists when render reports success
- image dimensions match requested output
- image is not zero-byte/corrupt

No renderer invocation or image output is part of the first worker spike.

---

## 31. Pass Criteria for Technical Spike 01

The first worker spike passes when all mandatory items below succeed:

- SceneSpec fixture parses successfully
- units are millimeters
- correct room dimensions are created
- wall objects have stable logical IDs
- door and window openings are created
- floor and ceiling are created at expected elevations
- proxy sofa, coffee table and TV unit are created
- three cameras are created with stable IDs
- `.max` file is saved successfully
- candidate is reopened in a fresh second 3ds Max process
- normalized semantic manifest matches the expected manifest
- managed identity can be reconciled
- repeating the same job does not duplicate objects
- idempotency result survives worker restart
- `output/execution-report.json` is written

Renderer preview is explicitly excluded from Technical Spike 1.

---

## 32. Pass Criteria for Technical Spike 02

After base build works, revision safety passes when:

- sofa replacement preserves logical identity
- coffee table move changes only intended transform
- material change preserves geometry
- ceiling lock blocks unauthorized geometry change
- revised elevation updates only affected opening behavior
- stale revision is rejected
- duplicate job is safe
- rollback restores known-good scene state

---

## 33. Future Visual Golden Tests

After deterministic scene building is stable, this project can expand with reference images and visual evaluation.

Future checks may measure:

- style adherence
- asset similarity
- material category accuracy
- camera quality
- lighting intent
- render composition
- reference consistency

These should never replace geometric conformance tests.

---

## 34. Golden Fixture Versioning

Golden test fixtures are versioned.

Example:

```text
living-room-golden/0.1.0
living-room-golden/0.2.0
```

A fixture must not be silently changed to make a failing implementation pass.

If expected behavior intentionally changes:

1. update fixture version
2. document reason
3. update affected expectations
4. preserve previous fixture where useful for regression testing

---

## 35. Repository Test Fixture Direction

The v0.1 machine-readable fixtures live at:

```text
tests/fixtures/living-room-golden/
├── scene-spec.json
├── expected-scene-manifest.json
├── fixture-manifest.json
├── job-envelope.json
└── invalid/
    ├── invalid-schema-version.json
    ├── missing-scene-id.json
    ├── negative-scale.json
    ├── stale-revision-job.json
    └── idempotency-key-reuse-mismatch.json
```

The first three invalid files are deterministic mutation cases: load
`baseFixture`, apply the stated JSON Pointer operation, and assert the named
error. `stale-revision-job.json` is structurally valid but must fail semantic
revision validation. `idempotency-key-reuse-mismatch.json` is a two-record
ledger/submission scenario and must return its named deterministic error.

Reference images should be added only when licensing and repository-storage decisions are clear.

---

## 36. Implementation Boundary

This document marks the transition from architecture planning to executable verification.

The next engineering task should create the minimum code needed to satisfy this golden test incrementally.

Recommended first implementation sequence:

```text
1. Minimal repository/toolchain skeleton
2. Consume the existing SceneSpec and worker schemas
3. Consume the existing Golden fixture and expected manifest
4. Local worker CLI and trusted local configuration
5. 3ds Max health check and batch discovery
6. Trusted repository-controlled Python/pymxs runner
7. Generate the exact room, openings, proxies, and cameras
8. Stamp embedded logical IDs
9. Save candidate/project.max
10. Reopen in a fresh second process
11. Extract and compare the normalized semantic manifest
12. Write output/execution-report.json
13. Persist and prove safe idempotent replay
14. Exercise forced failure and timeout behavior
```

Do not connect generative AI to this path until the deterministic base test is stable.
