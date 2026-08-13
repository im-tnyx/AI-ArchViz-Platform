# Validation Engine Architecture

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Purpose:** Define the deterministic validation pipeline that protects architectural truth, approved design decisions, spatial correctness, scene integrity, and execution safety before any SceneChangeSet reaches 3ds Max or another production DCC.

---

## 1. Why This Document Exists

AI ArchViz Platform receives changes from multiple sources:

- user instructions
- revised plans
- elevations and sections
- reference analysis
- AI proposals
- asset search
- automated placement
- UI edits
- future external APIs

These inputs can be useful while still being incomplete, conflicting, geometrically impossible, stale, or unsafe.

The platform therefore requires a validation layer between intent and execution.

The Validation Engine is not an AI model.

It is a deterministic policy and rule system that evaluates whether a proposed change is structurally valid, evidence-compatible, spatially possible, revision-safe, renderer-compatible, and safe to execute.

---

## 2. Core Rule

> No SceneChangeSet reaches a production DCC until it passes the required validation gates for its risk level.

Canonical flow:

```text
Intent / Evidence / AI Proposal
            ↓
      SceneChangeSet
            ↓
      Schema Validation
            ↓
     Identity Validation
            ↓
      Revision Validation
            ↓
      Evidence Validation
            ↓
       Lock Validation
            ↓
      Spatial Validation
            ↓
     Constraint Validation
            ↓
    Compatibility Validation
            ↓
       Risk Evaluation
            ↓
         Dry Run
            ↓
      Execution Decision
       ↙       ↓       ↘
   BLOCK   REQUIRE     ALLOW
           APPROVAL
```

---

## 3. Validation Outcomes

Every validation request returns one of three primary outcomes.

### 3.1 `ALLOW`

The change may execute automatically.

Example:

```text
Move an unlocked decorative vase 50 mm
within the same valid surface boundary.
```

### 3.2 `REQUIRE_APPROVAL`

The change is technically valid but affects approved, architectural, high-impact, or ambiguous state.

Example:

```text
Replace a client-approved main sofa with a dimensionally valid alternative.
```

### 3.3 `BLOCK`

The change violates a hard rule, stale state, lock, geometry constraint, architectural truth, or execution safety requirement.

Example:

```text
Move a verified load-bearing wall because a reference image looks different.
```

---

## 4. Validation Is Layered

Validation must be performed in layers rather than by one large opaque function.

Recommended order:

```text
01 Schema
02 Identity
03 Revision / Concurrency
04 Evidence / Provenance
05 Lock / Approval
06 Spatial
07 Architectural Constraints
08 Asset Compatibility
09 Renderer / DCC Compatibility
10 Risk Classification
11 Dry Run
12 Post-Execution Verification
```

Earlier failures should prevent unnecessary later processing when possible.

---

## 5. Validation Request Contract

Conceptual request:

```json
{
  "projectId": "project_living_001",
  "sceneId": "scene_main",
  "baseRevisionId": "rev_000012",
  "changeSetId": "chg_000041",
  "changeSet": {},
  "executionTarget": {
    "dcc": "3ds_max",
    "renderer": "corona"
  },
  "mode": "production"
}
```

The validator must always know which exact scene revision is being evaluated.

---

## 6. Validation Result Contract

Conceptual result:

```json
{
  "status": "require_approval",
  "riskLevel": "high",
  "baseRevisionId": "rev_000012",
  "changeSetId": "chg_000041",
  "checks": [],
  "blockingErrors": [],
  "warnings": [],
  "approvalReasons": [],
  "affectedObjects": [],
  "affectedRenders": [],
  "dryRun": {
    "performed": true,
    "success": true
  }
}
```

Validation results must be machine-readable and auditable.

---

## 7. Schema Validation

Schema validation checks structural correctness before domain logic.

Examples:

- required fields exist
- operation type is supported
- IDs follow accepted format
- positions contain exactly three numeric values
- dimensions are finite positive values where required
- rotations use the canonical convention
- unknown executable fields are rejected
- arbitrary script payloads are rejected

Example failure:

```json
{
  "operation": "MoveObject",
  "objectId": "asset_sofa_main",
  "position": [1000, 2000]
}
```

Result:

```text
BLOCK
Reason: invalid 3D position vector
```

---

## 8. Identity Validation

Every mutation must resolve stable logical identity.

Checks include:

- target object exists
- target object is active when required
- object ID is not confused with asset definition ID
- parent exists
- referenced material/light/camera exists
- replacement asset definition exists
- deleted objects cannot receive normal transforms
- restored objects preserve their logical identity

The validator must never infer target identity from a DCC node name alone.

---

## 9. Revision and Concurrency Validation

Every SceneChangeSet must target an expected base revision.

Example:

```text
Current scene revision: rev_000020
Incoming change base:    rev_000018
```

Default result:

```text
BLOCK AS STALE
```

unless an explicit deterministic rebase procedure proves the operation is still valid.

This prevents old AI responses, delayed UI actions, or parallel operators from overwriting newer work.

---

## 10. Evidence and Provenance Validation

The validator must use the rules from `EVIDENCE-PROVENANCE-AND-CONFIDENCE.md`.

Example authority relationship:

```text
Verified drawing dimension
        >
Approved manual value
        >
Vector-derived inference
        >
AI visual inference
        >
Unverified assumption
```

A lower-authority source cannot silently override a higher-authority value.

Example:

```text
Plan dimension: 5200 mm, verified
AI proposal:     5050 mm, inferred from reference
```

Result:

```text
BLOCK geometry overwrite
ALLOW reference influence on style only
```

---

## 11. Conflict Detection

The engine should detect evidence disagreements before execution.

Possible conflict types:

- plan vs elevation
- plan vs section
- elevation vs section
- drawing vs manual instruction
- approved state vs new imported drawing
- asset metadata vs measured geometry
- current scene vs revised source drawing

Conflict records should include:

```json
{
  "conflictId": "conflict_0014",
  "property": "opening_w01.height",
  "sources": [
    {
      "source": "elevation_A02",
      "value": 2100,
      "authority": "verified_drawing"
    },
    {
      "source": "manual_note_07",
      "value": 2200,
      "authority": "user_instruction"
    }
  ],
  "resolution": "requires_review"
}
```

---

## 12. Lock Validation

Locks are hard production controls.

Supported concepts include:

- object lock
- geometry lock
- transform lock
- material lock
- asset-definition lock
- camera lock
- light lock
- property-level lock

Example:

```text
TV wall geometry = locked
AI proposes UpdateGeometry
```

Result:

```text
BLOCK
```

Unlocking must itself be an explicit auditable operation.

---

## 13. Approval Validation

Approval and locks are different.

An approved object may still be editable under controlled revision, while a locked property may not be changed without explicit unlock authority.

Approval states may include:

```text
draft
proposed
reviewed
approved
superseded
rejected
```

A change affecting approved design should generally raise risk and may require approval even when no hard lock exists.

---

## 14. Spatial Validation

Spatial validation operates in canonical SceneSpec coordinates.

Checks include:

- finite coordinates
- valid scale
- valid rotation
- valid elevation
- object inside assigned room where required
- floor-supported objects touching expected support plane
- wall-mounted objects attached to intended wall plane
- ceiling-mounted objects attached to ceiling plane
- no invalid negative dimensions
- no unintended mirroring
- no extreme transform values

---

## 15. Room Boundary Validation

Furniture and room-specific objects must respect room boundaries unless explicitly classified otherwise.

Example:

```text
Sofa bounding footprint extends 420 mm outside living-room polygon.
```

Result:

```text
BLOCK
```

or, in exploratory planning mode:

```text
ALLOW AS PROPOSAL ONLY
NOT PRODUCTION-EXECUTABLE
```

---

## 16. Collision Validation

The collision engine should support multiple levels of precision.

### Level 1: Bounding Box

Fast broad-phase validation.

### Level 2: Oriented Bounding Box / Footprint

Better furniture validation.

### Level 3: Mesh / Semantic Collision

Used only when justified by precision requirements.

Common collision rules:

- furniture vs walls
- furniture vs furniture
- decor vs support surface
- pendant vs ceiling
- door leaf swing vs furniture
- wardrobe door clearance
- cabinet access clearance

---

## 17. Clearance Validation

Not every non-collision arrangement is usable.

The validator should support semantic clearances such as:

```text
walking clearance
bed side clearance
wardrobe access clearance
chair pull-out clearance
door swing clearance
kitchen work clearance
bathroom fixture clearance
```

Exact values should be configuration/policy data rather than hard-coded throughout application logic.

---

## 18. Architectural Rule Validation

Architectural checks are separate from generic geometry checks.

Examples:

- opening remains hosted by a valid wall
- door width remains physically plausible
- window sill does not exceed opening geometry
- ceiling height remains above floor level
- wall thickness remains positive
- opening does not exceed host wall bounds
- room boundaries remain closed where required
- floor and ceiling relationships remain consistent

The initial MVP should implement a small reliable subset and expand through tests.

---

## 19. Asset Validation

Before `ReplaceAsset` or `CreateObject`, validate the selected asset.

Checks include:

- asset exists
- file is accessible
- dimensions are known or explicitly unverified
- pivot normalization is known
- canonical forward direction is known
- renderer compatibility is known
- material slots are valid
- bounding box is available
- scale is plausible
- licensing/source metadata exists where required

An unknown asset should not silently enter production as trusted.

---

## 20. Renderer Compatibility Validation

Renderer-specific compatibility is evaluated only after semantic scene validity.

For Corona MVP, checks may include:

- required material compiler available
- unsupported material type not requested
- referenced textures exist
- light type supported
- camera feature supported
- renderer installed and target version compatible

Renderer validation must not own architectural business rules.

---

## 21. DCC Compatibility Validation

For 3ds Max execution, checks may include:

- required 3ds Max version is supported
- unit normalization is possible
- plugin dependencies are installed
- required asset file type can be loaded
- object naming/mapping can be created
- scene path is writable
- required renderer is available

This prevents jobs from reaching the worker when execution prerequisites are already known to be missing.

---

## 22. Risk Classification

Every valid change receives a risk level.

Suggested initial levels:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

### LOW

Examples:

- move unlocked decor slightly
- change non-approved decorative accessory
- create a preview camera

May auto-execute after validation.

### MEDIUM

Examples:

- replace a non-approved furniture asset
- modify a material on a design object
- move a major furniture object within constraints

May auto-execute in development mode but require review in production depending on policy.

### HIGH

Examples:

- modify approved furniture
- alter ceiling design
- change window dimensions
- revise fixed joinery

Requires approval in production.

### CRITICAL

Examples:

- override verified architectural dimensions
- move/delete structural or locked architecture
- mass delete objects
- change canonical coordinate conventions

Blocked by default unless a specialized privileged workflow exists.

---

## 23. Risk Is Contextual

Risk depends on more than operation type.

Example:

```text
MoveObject decorative_vase = LOW
MoveObject main_sofa = MEDIUM
MoveObject approved_kitchen_island = HIGH
MoveObject verified_wall = CRITICAL
```

Therefore risk should be computed from:

```text
operation type
+
object category
+
approval state
+
lock state
+
evidence authority
+
revision scope
+
spatial impact
+
downstream render impact
```

---

## 24. Change Blast Radius

The validator must estimate affected state before execution.

Example outputs:

```text
Affected objects: 1
Affected materials: 0
Affected cameras: 2
Affected renders: 3
Requires geometry rebuild: false
Requires lighting rebuild: false
```

Large blast radius increases risk.

---

## 25. Dry Run

A dry run applies the SceneChangeSet to a temporary in-memory or sandbox scene state without committing production state.

Dry run should detect:

- missing references
- invalid dependency order
- constraint violations after combined operations
- impossible parent/child changes
- unexpected deletions
- derived geometry failures
- revision conflicts

All multi-operation SceneChangeSets should be dry-run before execution.

---

## 26. Atomicity

A SceneChangeSet is atomic by default.

Example:

```text
Operation 1 succeeds
Operation 2 succeeds
Operation 3 fails
```

Result:

```text
NO production commit
```

The canonical SceneSpec must remain at the original revision.

Partial scene mutation is not considered a valid committed revision.

---

## 27. Dependency Ordering

Some operations depend on others.

Example:

```text
Create wall panel
Assign material
Attach lighting detail
```

The validator/compiler should construct a deterministic dependency order instead of relying on arbitrary input order when safe and supported.

Invalid circular dependencies must be blocked.

---

## 28. AI-Specific Validation

AI output receives no special trust.

The validator should check:

- model-supplied object IDs exist
- dimensions are backed by acceptable evidence
- operations do not exceed task authority
- proposed asset satisfies deterministic constraints
- free-form explanations do not affect execution
- only structured fields enter domain logic

AI confidence is metadata, not execution permission.

---

## 29. Human Approval Gate

Approval records should capture:

```json
{
  "approvalId": "approval_0091",
  "changeSetId": "chg_000041",
  "approvedBy": "user_or_operator_id",
  "approvedAt": "2026-08-13T15:00:00+05:30",
  "scope": "entire_changeset",
  "baseRevisionId": "rev_000012"
}
```

If the base revision changes after approval, approval should normally become stale and require revalidation.

---

## 30. Development vs Production Mode

Policies may differ by mode.

### Development

Allows faster iteration while still preserving hard safety rules.

### Production

Uses stricter approval and evidence requirements.

Example:

```text
MEDIUM risk
Development → auto-execute after validation
Production  → policy-dependent approval
```

Hard blocks remain hard blocks in both modes unless explicitly configured for test fixtures.

---

## 31. Post-Execution Verification

Validation does not end before execution.

After 3ds Max applies a change, verify:

- expected logical IDs still exist
- transforms match expected values
- no unexpected managed objects disappeared
- scene revision metadata is correct
- renderer remains available
- scene save succeeded
- generated preview is not empty/corrupt

Later versions may also use render/image critique, but deterministic checks come first.

---

## 32. Scene Reconciliation

3ds Max may contain manual edits.

Before applying a new production change, the platform should detect managed-scene drift where possible.

Possible states:

```text
IN_SYNC
MANUAL_CHANGES_DETECTED
MISSING_MANAGED_OBJECT
UNKNOWN_MANAGED_OBJECT
TRANSFORM_DRIFT
MATERIAL_DRIFT
```

Production execution should not silently overwrite unexplained drift.

---

## 33. Error Severity

Validation findings should use structured severity.

Suggested levels:

```text
INFO
WARNING
ERROR
BLOCKING
```

Example:

```json
{
  "code": "ROOM_BOUNDARY_VIOLATION",
  "severity": "BLOCKING",
  "objectId": "asset_living_sofa_main",
  "message": "Object footprint extends outside assigned room boundary."
}
```

Machine-readable error codes are required for UI, tests, logs, and future automated repair flows.

---

## 34. Initial Error Code Families

Suggested families:

```text
SCHEMA_*
IDENTITY_*
REVISION_*
EVIDENCE_*
LOCK_*
SPATIAL_*
COLLISION_*
CLEARANCE_*
ARCH_*
ASSET_*
RENDERER_*
DCC_*
RISK_*
DRYRUN_*
EXECUTION_*
RECONCILIATION_*
```

---

## 35. Auto-Repair Boundaries

The platform may later support deterministic auto-repair for low-risk problems.

Example:

```text
Chair is 20 mm outside room boundary
→ snap inside if policy explicitly allows
```

Auto-repair must never silently change high-authority architectural facts.

Every repair must itself become an explicit SceneChangeSet operation or normalized transformation with audit metadata.

---

## 36. Validation Profiles

Different tasks may use different validation profiles.

Examples:

```text
concept_preview
interior_design
production_still
client_revision
cad_sync
asset_ingestion
camera_only
```

A profile controls which checks are required and how risk maps to approval policy.

Core architectural truth checks remain mandatory where applicable.

---

## 37. Performance Strategy

Validation should avoid expensive full-scene checks when local dependency analysis is sufficient.

Example:

```text
Change one lamp material
```

should not require full mesh collision validation for every room.

Use affected-object graphs to scope checks.

However, optimization must never skip a required invariant.

---

## 38. Determinism

Given:

```text
same SceneSpec revision
same SceneChangeSet
same validation policy version
same asset metadata
same configuration
```

validation outcome should be reproducible.

AI calls must not occur inside deterministic validation rules.

If AI assistance is used for explanation or suggestion, its output is outside the authoritative validation result.

---

## 39. Policy Versioning

Validation behavior will evolve.

Every validation result should record policy version.

Example:

```json
{
  "validationPolicyVersion": "0.1.0"
}
```

This allows historical revisions to explain why a change was accepted under an earlier rule set.

---

## 40. Logging and Audit

Store enough metadata to reconstruct decisions.

Recommended fields:

```text
validation request ID
project ID
scene ID
base revision
changeSet ID
policy version
validation profile
checks executed
warnings
blocking errors
risk level
approval requirement
duration
result
```

Do not rely only on free-form log strings.

---

## 41. Testing Strategy

Each validation rule needs positive and negative fixtures.

Examples:

### Valid

- sofa inside room
- unlocked material update
- correctly hosted window
- valid asset replacement

### Invalid

- sofa outside room
- stale base revision
- locked geometry update
- missing asset definition
- opening outside host wall
- furniture blocking door swing
- AI inference overriding verified dimension

### Boundary

- object exactly on room boundary
- tolerance-level collision
- small coordinate rounding differences

---

## 42. Golden Validation Cases

The first living-room golden project should include known expected results for:

```text
valid sofa replacement
invalid oversized sofa
valid decor movement
invalid locked wall edit
valid material revision
invalid stale revision
valid camera creation
invalid window geometry override
```

These become regression tests.

---

## 43. MVP Validation Scope

Do not implement every possible architectural rule in the first version.

Initial required checks:

```text
Schema
Identity
Base Revision
Locks
Basic Evidence Authority
Canonical Transforms
Room Boundary
Basic Bounding-Box Collision
Asset Availability
Basic Clearance
Corona / 3ds Max Availability
Risk Classification
Dry Run
Post-Execution Identity Verification
```

This is sufficient for the first controlled living-room prototype.

---

## 44. Validation Engine Module Boundary

Recommended conceptual package:

```text
packages/validation-engine/
```

Possible internal structure:

```text
validation-engine/
├── schema/
├── identity/
├── revision/
├── evidence/
├── locks/
├── spatial/
├── collision/
├── constraints/
├── assets/
├── compatibility/
├── risk/
├── dry-run/
├── policies/
├── errors/
└── tests/
```

The module should not import 3ds Max scripting APIs directly.

DCC-specific checks should use capability metadata or adapter contracts.

---

## 45. Relationship to Other Architecture Documents

```text
SceneSpec
   │
   ├── Evidence / Provenance
   ├── Coordinates / Units
   ├── Object Identity
   └── SceneChangeSet
           ↓
     Validation Engine
           ↓
      Scene Compiler
           ↓
       3ds Max Worker
           ↓
     Corona / V-Ray
```

The validator protects the boundary between declarative intent and production execution.

---

## 46. Non-Goals

The Validation Engine is not responsible for:

- generating creative design concepts
- choosing AI vendors
- rendering images
- directly controlling 3ds Max
- writing arbitrary MAXScript
- replacing SceneSpec
- deciding subjective beauty by itself

Its purpose is correctness, safety, consistency, and controlled execution.

---

## 47. Final Architecture Principle

The production architecture follows this rule:

```text
AI may be uncertain.
Inputs may conflict.
Users may revise decisions.
Assets may change.
DCC state may drift.

But execution must remain controlled.
```

Therefore:

> **Nothing enters the production 3D scene merely because an AI model suggested it. It enters because the platform can identify it, validate it, explain its evidence, measure its impact, and safely execute it.**
