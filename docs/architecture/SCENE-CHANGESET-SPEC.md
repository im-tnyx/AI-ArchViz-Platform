# SceneChangeSet Specification

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Purpose:** Define the deterministic, validated and auditable mutation contract used to change an existing SceneSpec and its compiled 3ds Max scene.

---

## 1. Why This Document Exists

AI ArchViz Platform must support frequent client revisions without allowing AI, UI actions, scripts or DCC automation to mutate production scenes arbitrarily.

Typical revisions include:

- replace the main sofa
- move a chair 300 mm
- change one wall material
- update a window after a revised elevation arrives
- modify ceiling geometry
- add a pendant light
- create a new camera
- lock an approved TV wall
- restore an accidentally deleted object
- update several related objects as one revision

These changes require one common mutation language.

The platform therefore defines `SceneChangeSet` as the canonical change contract.

---

## 2. Core Rule

> No AI model, UI component, API client, worker, plugin or renderer adapter may directly mutate canonical production scene state.

All production changes must be represented as a validated `SceneChangeSet`.

```text
User / Drawing / AI / UI
          ↓
     Change Intent
          ↓
   SceneChangeSet
          ↓
  Schema Validation
          ↓
 Identity Validation
          ↓
 Evidence Validation
          ↓
 Spatial Validation
          ↓
 Lock / Risk Validation
          ↓
       Dry Run
          ↓
     Apply to SceneSpec
          ↓
     Compile to 3ds Max
          ↓
      Verify Result
          ↓
   Commit or Rollback
```

---

## 3. Relationship to SceneSpec

`SceneSpec` describes current canonical scene state.

`SceneChangeSet` describes an intentional transition from one valid state to another.

```text
SceneSpec Revision N
       +
SceneChangeSet
       ↓
Validation
       ↓
SceneSpec Revision N+1
```

A change set is not itself the scene.

It is an ordered, auditable description of intended changes.

---

## 4. Design Goals

`SceneChangeSet` must be:

- deterministic
- schema-validatable
- identity-aware
- revision-safe
- lock-aware
- evidence-aware
- reversible where practical
- replayable
- idempotent where possible
- human-readable
- machine-executable
- independent of 3ds Max node names
- independent of a specific AI provider
- independent of Corona or V-Ray

---

## 5. Non-Goals

`SceneChangeSet` is not:

- arbitrary MAXScript
- arbitrary Python
- natural-language instructions
- renderer-specific script payloads
- a complete SceneSpec snapshot
- a transport for executable code
- an AI chain-of-thought representation

No operation may contain arbitrary executable code.

---

## 6. Top-Level Contract

Example:

```json
{
  "schemaVersion": "0.1.0",
  "changeSetId": "chg_01JXYZ123456",
  "projectId": "project_living_001",
  "sceneId": "scene_living_main",
  "baseRevisionId": "rev_0007",
  "targetRevisionId": "rev_0008",
  "requestedBy": {
    "type": "user",
    "id": "user_001"
  },
  "source": {
    "type": "natural_language_revision",
    "referenceIds": []
  },
  "intent": "Replace the main living room sofa with the approved curved beige sofa.",
  "riskLevel": "medium",
  "operations": [],
  "preconditions": [],
  "metadata": {
    "createdAt": "2026-08-13T00:00:00Z"
  }
}
```

---

## 7. Required Top-Level Fields

### `schemaVersion`

Version of the SceneChangeSet schema.

```text
0.1.0
```

### `changeSetId`

Globally unique immutable logical identifier.

Example:

```text
chg_01JXYZ123456
```

### `projectId`

Project that owns the target SceneSpec.

### `sceneId`

Immutable scene/branch identity targeted by the transition.

### `baseRevisionId`

Revision against which the change was generated.

This prevents stale changes from silently applying to newer scene state.

### `targetRevisionId`

Immutable revision identity proposed for the committed state. It must differ
from `baseRevisionId`. The validator rejects the entire ChangeSet as
`STALE_REVISION` when `baseRevisionId` does not equal the current committed
SceneSpec `scene.headRevisionId`.

### `requestedBy`

Who or what initiated the change.

Allowed conceptual types:

```text
user
ai
system
import
worker
operator
```

### `source`

Evidence or workflow source that produced the change intent.

Examples:

```text
manual_edit
natural_language_revision
revised_plan
revised_elevation
reference_update
asset_selection
system_repair
```

### `operations`

Ordered list of deterministic mutations.

---

## 8. Change Lifecycle

A change set has an explicit lifecycle.

Recommended states:

```text
draft
proposed
validating
blocked
ready
approved
executing
verified
committed
failed
rolled_back
superseded
```

Conceptual flow:

```text
draft
  ↓
proposed
  ↓
validating
  ├── blocked
  ↓
ready
  ↓
approved
  ↓
executing
  ├── failed → rolled_back
  ↓
verified
  ↓
committed
```

Low-risk system-generated operations may follow an automated approval policy later.

High-risk operations must support explicit approval gates.

---

## 9. Operation Envelope

Every operation uses a common envelope.

```json
{
  "operationId": "op_001",
  "type": "MoveObject",
  "targetId": "asset_living_sofa_main",
  "reason": "Increase circulation clearance.",
  "riskLevel": "low",
  "parameters": {},
  "preconditions": [],
  "provenance": [],
  "expectedImpact": {}
}
```

Required concepts:

- operation identity
- operation type
- target identity where relevant
- validated parameters
- reason
- provenance
- risk classification
- expected impact

---

## 10. Initial Operation Catalog

The initial schema should support the following operation families.

### Object Lifecycle

```text
CreateObject
DeleteObject
RestoreObject
ReplaceAsset
ReparentObject
```

### Transform

```text
MoveObject
RotateObject
ScaleObject
SetTransform
```

### Architecture / Geometry

```text
UpdateGeometry
UpdateWall
UpdateOpening
UpdateCeiling
UpdateFloor
```

### Materials

```text
AssignMaterial
UpdateMaterial
RemoveMaterialAssignment
```

### Lighting

```text
CreateLight
UpdateLight
DeleteLight
```

### Cameras

```text
CreateCamera
UpdateCamera
DeleteCamera
SetPrimaryCamera
```

### Constraints

```text
AddConstraint
UpdateConstraint
RemoveConstraint
```

### Approval / Protection

```text
LockObject
UnlockObject
LockProperty
UnlockProperty
ApproveObject
UnapproveObject
```

### Metadata

```text
UpdateMetadata
UpdateTags
UpdateProvenance
```

The initial implementation should remain intentionally small.

New operation types should be added only when an actual production requirement appears.

---

## 11. `CreateObject`

Creates a new logical scene object.

Example:

```json
{
  "operationId": "op_001",
  "type": "CreateObject",
  "parameters": {
    "object": {
      "id": "asset_living_chair_accent_02",
      "kind": "asset_instance",
      "assetDefinitionId": "assetdef_chair_0042",
      "parentId": "space_living",
      "transform": {
        "position": [2100, 4400, 0],
        "rotationEuler": [0, 0, 25],
        "scale": [1, 1, 1]
      }
    }
  }
}
```

Validation must check:

- new ID is unused
- parent exists
- asset definition exists where required
- transform follows canonical conventions
- object remains within allowed space
- collisions and clearances
- required renderer compatibility where relevant

---

## 12. `DeleteObject`

Production deletion should default to logical soft deletion rather than irreversible destruction.

```json
{
  "operationId": "op_002",
  "type": "DeleteObject",
  "targetId": "asset_living_side_table_01",
  "parameters": {
    "mode": "soft"
  }
}
```

The deleted object's identity and history remain available.

Physical DCC nodes may be removed during scene compilation.

---

## 13. `RestoreObject`

Restores a previously deleted logical object.

```json
{
  "operationId": "op_003",
  "type": "RestoreObject",
  "targetId": "asset_living_side_table_01"
}
```

Restore must validate that the previous transform and asset remain compatible with current scene state.

A restored object must not silently reappear inside newly added geometry.

---

## 14. `ReplaceAsset`

Replaces the asset definition while preserving the logical object identity.

```json
{
  "operationId": "op_004",
  "type": "ReplaceAsset",
  "targetId": "asset_living_sofa_main",
  "parameters": {
    "newAssetDefinitionId": "assetdef_sofa_000812",
    "placementPolicy": "preserve_anchor",
    "materialPolicy": "use_asset_default"
  }
}
```

Important rule:

```text
Logical Object ID remains unchanged.
```

Example:

```text
asset_living_sofa_main
```

remains the same before and after replacement.

Only its referenced asset definition changes.

Validation must check:

- category compatibility
- dimensions
- room fit
- collision
- clearances
- pivot/anchor compatibility
- renderer/material compatibility
- locked properties

---

## 15. Transform Operations

### `MoveObject`

SceneChangeSet v0.1 uses absolute desired-state transforms only. Relative
deltas are outside the v0.1 machine contract because blind replay would not be
idempotent.

```json
{
  "operationId": "op_005",
  "type": "MoveObject",
  "targetId": "asset_living_sofa_main",
  "parameters": {
    "transform": {
      "position": [3000, 2450, 0],
      "rotationEuler": [0, 0, 0],
      "scale": [1, 1, 1]
    }
  }
}
```

### `RotateObject`

```json
{
  "operationId": "op_006",
  "type": "RotateObject",
  "targetId": "asset_living_chair_accent_01",
  "parameters": {
    "transform": {
      "position": [2100, 4400, 0],
      "rotationEuler": [0, 0, 35],
      "scale": [1, 1, 1]
    }
  }
}
```

### `ScaleObject`

Non-uniform scaling should normally be rejected for curated production assets unless explicitly allowed by asset metadata.

---

## 16. Geometry Operations

Architecture is higher risk than furniture placement.

Example wall update:

```json
{
  "operationId": "op_007",
  "type": "UpdateWall",
  "targetId": "wall_living_north",
  "riskLevel": "high",
  "parameters": {
    "heightMm": 3150
  },
  "provenance": [
    {
      "evidenceId": "evidence_elevation_a_2026_08_13",
      "field": "wallHeight"
    }
  ]
}
```

Architectural geometry changes should usually require stronger evidence and stricter approval than decoration changes.

---

## 17. Opening Operations

Doors and windows require semantic awareness.

`UpdateOpening` may modify:

- position along host wall
- width
- height
- sill height
- head height
- opening type
- host wall

Example:

```json
{
  "operationId": "op_008",
  "type": "UpdateOpening",
  "targetId": "opening_window_w01",
  "parameters": {
    "widthMm": 1800,
    "heightMm": 1500,
    "sillHeightMm": 750
  }
}
```

Validation must verify host-wall compatibility and evidence authority.

---

## 18. Material Operations

Example:

```json
{
  "operationId": "op_009",
  "type": "AssignMaterial",
  "targetId": "wall_living_tv",
  "parameters": {
    "slot": "finish",
    "materialId": "mat_travertine_warm_001"
  }
}
```

Material changes must not unexpectedly modify unrelated objects that share a DCC material instance unless shared behavior is explicitly intended.

Canonical material identity and DCC material instances must therefore remain separate concepts.

---

## 19. Light Operations

`CreateLight` and `UpdateLight` use semantic lighting fields rather than arbitrary renderer code.

Example:

```json
{
  "operationId": "op_010",
  "type": "UpdateLight",
  "targetId": "light_living_cove_01",
  "parameters": {
    "temperatureKelvin": 3000,
    "intensity": {
      "value": 1200,
      "unit": "lm"
    }
  }
}
```

Renderer adapters compile semantic values into Corona or V-Ray implementations.

---

## 20. Camera Operations

Example:

```json
{
  "operationId": "op_011",
  "type": "UpdateCamera",
  "targetId": "camera_living_hero_01",
  "parameters": {
    "transform": {
      "position": [1200, -1800, 1500],
      "rotationEuler": [-1.601049, 0, 333.434949],
      "scale": [1, 1, 1]
    },
    "target": [3600, 3000, 1350],
    "focalLengthMm": 24,
    "verticalCorrection": true
  }
}
```

Camera changes should preserve architectural geometry.

AI camera critique may propose camera changes but must not silently move room objects to improve composition.

---

## 21. Lock Operations

Locks protect approved production decisions.

### Object Lock

```json
{
  "operationId": "op_012",
  "type": "LockObject",
  "targetId": "ceiling_living_main",
  "parameters": {
    "reason": "Client approved ceiling design."
  }
}
```

### Property Lock

```json
{
  "operationId": "op_013",
  "type": "LockProperty",
  "targetId": "opening_window_w01",
  "parameters": {
    "propertyPath": "dimensions.widthMm"
  }
}
```

Any later operation touching a locked target/property must be blocked unless an authorized unlock operation occurs first.

---

## 22. Preconditions

Change sets and individual operations may declare preconditions.

Examples:

```text
Object exists
Object is active
Object asset definition equals expected value
Property equals expected value
Base revision matches
Object is not locked
Evidence revision is current
Material exists
Target space exists
```

Example:

```json
{
  "type": "PropertyEquals",
  "targetId": "asset_living_sofa_main",
  "propertyPath": "assetDefinitionId",
  "expected": "assetdef_sofa_000124"
}
```

If the precondition fails, the operation must not silently continue.

---

## 23. Optimistic Concurrency

`baseRevisionId` is mandatory for production mutation.

Example:

```text
ChangeSet generated from rev_0007
Current project revision = rev_0009
```

Result:

```text
Do not auto-apply.
```

The system must either:

- rebase/recalculate the proposal
- request review
- mark the change set stale

This prevents older AI or UI proposals from overwriting newer revisions.

---

## 24. Operation Ordering

Operations are ordered.

Later operations may depend on earlier operations within the same change set.

Example:

```text
1. CreateObject pendant_02
2. AssignMaterial pendant_02
3. MoveObject pendant_02
4. LockProperty pendant_02.position.z
```

The validator should construct a dependency graph where useful.

Invalid dependency cycles must be rejected.

---

## 25. Atomicity

Default production behavior should be atomic at the `SceneChangeSet` level.

```text
All required operations succeed
→ commit

Any required operation fails
→ no canonical partial commit
```

Optional operations may later support explicit best-effort semantics, but this should not be the default.

---

## 26. Dry Run

Before production execution, every change set should support a dry-run result.

Dry run should calculate:

- target objects
- changed properties
- created/deleted identities
- lock conflicts
- collisions
- clearance failures
- affected rooms
- affected cameras
- affected render outputs
- required assets
- missing textures
- renderer compatibility
- estimated risk
- evidence conflicts

Example summary:

```json
{
  "valid": true,
  "riskLevel": "medium",
  "affectedObjects": [
    "asset_living_sofa_main",
    "asset_living_coffee_table_main"
  ],
  "affectedCameras": [
    "camera_living_hero_01",
    "camera_living_side_01"
  ],
  "warnings": []
}
```

---

## 27. Risk Levels

Initial risk model:

```text
low
medium
high
critical
```

### Low

Examples:

- camera focal length change
- decor position adjustment
- unlocked material change

### Medium

Examples:

- sofa replacement
- large furniture movement
- lighting replacement

### High

Examples:

- wall geometry
- ceiling geometry
- window/door dimensions
- room height

### Critical

Examples:

- destructive project-wide coordinate changes
- unit changes after geometry exists
- operations affecting locked approved architecture
- large automated changes with unresolved evidence conflicts

Approval policy can depend on risk level.

---

## 28. Evidence & Provenance

Every operation that modifies architectural truth should carry evidence references.

Example:

```json
{
  "provenance": [
    {
      "evidenceId": "drawing_elevation_a_rev03",
      "evidenceType": "elevation",
      "authority": "verified_drawing",
      "field": "windowHeight"
    }
  ]
}
```

Reference images should normally influence design intent rather than authoritative dimensions.

The evidence policy is defined separately in:

```text
EVIDENCE-PROVENANCE-AND-CONFIDENCE.md
```

---

## 29. AI Boundary

AI may:

- interpret natural-language revision intent
- identify likely target logical IDs
- propose operation types
- propose structured parameters
- explain reasoning at a concise user-facing level
- estimate affected scene areas

AI may not:

- execute arbitrary code
- bypass schema validation
- bypass locks
- bypass evidence authority
- mutate SceneSpec directly
- write directly into production `.max` files
- silently resolve high-risk conflicts

Canonical pattern:

```text
"Make the sofa 250 mm closer to the TV wall"
        ↓
AI Intent Parser
        ↓
{
  type: "MoveObject",
  targetId: "asset_living_sofa_main",
  transform: {
    position: [3000, 3100, 0],
    rotationEuler: [0, 0, 180],
    scale: [1, 1, 1]
  }
}
        ↓
Deterministic validation
        ↓
Execution
```

---

## 30. UI Boundary

The UI should use the same mutation contract as AI.

Example user drag:

```text
User drags sofa in web/desktop UI
        ↓
UI calculates intended transform
        ↓
MoveObject operation
        ↓
Validation
        ↓
Commit
```

There should not be separate correctness rules for AI and manual UI edits.

---

## 31. DCC Boundary

The 3ds Max worker receives only validated operations or a validated target SceneSpec produced from them.

The worker must not interpret natural-language revision requests.

The worker's responsibility is execution, not design reasoning.

Conceptually:

```text
SceneChangeSet
      ↓
Canonical Apply Engine
      ↓
New SceneSpec
      ↓
Scene Compiler
      ↓
3ds Max Commands
```

For efficient sync, the compiler may also derive incremental DCC commands from the same validated change set.

---

## 32. Idempotency

Every change set has a unique `changeSetId`.

Workers and APIs must record applied IDs.

If the same committed change set is accidentally delivered again:

```text
Do not apply twice.
```

Example:

```text
Move sofa +250 mm
```

must not become +500 mm because of a network retry.

---

## 33. Replay

A scene may be reconstructed by replaying accepted change sets from a known snapshot.

```text
SceneSpec Snapshot rev_0000
        ↓
ChangeSet 0001
        ↓
ChangeSet 0002
        ↓
ChangeSet 0003
        ↓
Current SceneSpec
```

Periodic snapshots prevent replay chains from becoming unnecessarily long.

---

## 34. Rollback

Rollback should prefer revision restoration over generating a blind inverse operation.

Recommended strategy:

```text
Before commit
→ preserve previous canonical SceneSpec revision

Execution failure
→ restore previous canonical revision
→ rebuild or resync affected DCC state
```

For simple operations, inverse operations may still be recorded for optimization.

Examples:

```text
MoveObject → previous transform
AssignMaterial → previous material assignment
ReplaceAsset → previous asset definition
```

---

## 35. Change Diff

Every committed revision should expose a human-readable diff.

Example:

```text
Revision 008 → 009

Changed:
- asset_living_sofa_main.assetDefinitionId
  assetdef_sofa_000124 → assetdef_sofa_000812

Moved:
- asset_living_coffee_table_main
  Y: 3800 → 3950 mm

Affected renders:
- camera_living_hero_01
- camera_living_side_01
```

This is essential for client revision auditability.

---

## 36. Affected Render Calculation

A change set should identify which renders need regeneration.

Examples:

```text
Camera-only change
→ only that camera render

Sofa material change
→ cameras where sofa is visible

Wall geometry change
→ all cameras where wall or dependent geometry is visible

Global lighting change
→ all affected renders
```

Initial MVP may use conservative invalidation.

Future versions can use visibility/dependency graphs for precise invalidation.

---

## 37. Scene Dependencies

Changes may affect dependent objects.

Examples:

- moving a host wall affects openings
- changing ceiling height affects ceiling lights
- replacing a table may affect tabletop decor anchors
- moving a bed may affect bedside-table relationships

The dependency engine should distinguish:

```text
hard dependency
soft relationship
visual dependency
render dependency
```

A change set dry run must report dependent impacts.

---

## 38. Grouped Revisions

One client instruction may require multiple operations.

Example:

```text
"Replace the sofa and move the coffee table so circulation remains clear."
```

May become:

```text
SceneChangeSet
├── ReplaceAsset sofa_main
└── MoveObject coffee_table_main
```

They should commit together if they represent one approved design decision.

---

## 39. Alternative Proposals

AI may generate multiple candidate change sets.

Example:

```text
Option A
Option B
Option C
```

Each option is a separate `SceneChangeSet` draft sharing the same `baseRevisionId`.

Only the approved option is committed.

Unselected options remain proposals, not scene history.

---

## 40. Validation Layers

Every production change set must pass the following conceptual layers:

```text
1. Schema Validation
2. Project / Revision Validation
3. Identity Validation
4. Lock Validation
5. Evidence Validation
6. Unit / Coordinate Validation
7. Spatial Validation
8. Constraint Validation
9. Asset / Material Availability
10. Renderer Compatibility
11. Risk Policy
12. Dry Run
```

Detailed rules belong in:

```text
VALIDATION-ENGINE.md
```

---

## 41. Error Model

Validation and execution errors must be structured.

Example:

```json
{
  "code": "OBJECT_PROPERTY_LOCKED",
  "operationId": "op_004",
  "targetId": "ceiling_living_main",
  "propertyPath": "geometry.heightMm",
  "message": "The requested change targets a locked approved property.",
  "recoverable": true
}
```

Errors must not rely only on human-readable text.

---

## 42. Security Boundary

Operation payloads are data, never code.

Forbidden fields/concepts include:

```text
script
python
maxscript
shellCommand
powershell
executable
rawCode
```

The DCC adapter maps known operation types to internal trusted implementations.

This prevents AI-generated arbitrary code execution through revision payloads.

---

## 43. Logging

Every executed change set should log:

- changeSetId
- projectId
- base revision
- resulting revision
- requester
- AI provider/model if AI-assisted
- operations
- validation result
- approval result
- start/end timestamps
- worker ID
- 3ds Max session ID
- execution result
- verification result
- rollback result where applicable

Logs should not become the canonical scene state.

---

## 44. Versioning

`SceneChangeSet` schema uses semantic versioning.

Example:

```text
0.1.0
0.2.0
1.0.0
```

Rules:

- additive compatible operation fields may be minor versions
- breaking operation semantics require a major version
- persisted historical change sets must remain readable
- migrations should be explicit

---

## 45. Testing Requirements

Minimum test groups:

### Schema Tests

- required fields
- invalid operation type
- invalid parameters
- invalid units

### Identity Tests

- missing target
- duplicate create ID
- replace while preserving logical ID

### Revision Tests

- stale `baseRevisionId`
- replay prevention
- rollback

### Lock Tests

- object lock
- property lock
- authorized unlock

### Spatial Tests

- out-of-room placement
- collision
- invalid opening

### Atomicity Tests

- operation 1 succeeds, operation 2 fails
- canonical state remains unchanged

### Idempotency Tests

- same change set delivered twice
- exactly one logical result

### DCC Sync Tests

- SceneSpec and 3ds Max remain equivalent after change

---

## 46. MVP Operation Set

The first real prototype does not need every operation in this document.

Recommended MVP subset:

```text
CreateObject
DeleteObject
RestoreObject
ReplaceAsset
MoveObject
RotateObject
AssignMaterial
CreateCamera
UpdateCamera
LockObject
LockProperty
```

Architecture geometry operations should be added when CAD ingestion begins.

---

## 47. Example: Sofa Revision

User request:

```text
Replace the main sofa with the approved curved beige sofa.
```

AI proposal:

```json
{
  "schemaVersion": "0.1.0",
  "changeSetId": "chg_sofa_009",
  "projectId": "project_living_001",
  "baseRevisionId": "rev_0008",
  "requestedBy": {
    "type": "user",
    "id": "user_001"
  },
  "source": {
    "type": "natural_language_revision"
  },
  "intent": "Replace the approved main sofa.",
  "riskLevel": "medium",
  "operations": [
    {
      "operationId": "op_001",
      "type": "ReplaceAsset",
      "targetId": "asset_living_sofa_main",
      "parameters": {
        "newAssetDefinitionId": "assetdef_sofa_000812",
        "placementPolicy": "preserve_anchor"
      }
    }
  ]
}
```

Then:

```text
Schema valid
↓
Target exists
↓
Target is not locked
↓
Asset exists
↓
Dimensions valid
↓
Collision check
↓
Dry run
↓
Approval
↓
Apply to SceneSpec
↓
Compile affected object in 3ds Max
↓
Preview verification
↓
Commit rev_0009
```

---

## 48. Example: Revised Elevation

New elevation changes window height.

```text
Revised Elevation
      ↓
Evidence extraction
      ↓
Difference detected
      ↓
UpdateOpening proposal
      ↓
Evidence authority check
      ↓
High-risk validation
      ↓
Approval
      ↓
SceneChangeSet commit
```

This allows progressive accuracy without recreating the project.

---

## 49. Future Extensions

Possible later operation types:

```text
CreateRoom
SplitWall
MergeWalls
CreateOpening
ApplyDesignOption
UpdateSunStudy
UpdateLandscape
AttachConstraint
DetachConstraint
CreateAnimationCamera
UpdateAnimationKeyframes
ImportBIMRevision
```

These should not be added until production use cases justify them.

---

## 50. Final Principle

The key architecture rule is:

```text
Intent is probabilistic.
Change representation is structured.
Validation is deterministic.
Execution is controlled.
History is immutable.
Rollback is always available.
```

`SceneChangeSet` is the boundary that makes AI-assisted scene editing safe enough for professional ArchViz production.
