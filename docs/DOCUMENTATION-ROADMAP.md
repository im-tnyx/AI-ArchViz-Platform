# Documentation Roadmap

**Status:** Active  
**Project:** AI ArchViz Platform  
**Goal:** Define the minimum architecture documentation required before implementation, while avoiding endless planning.

---

## 1. Principle

Documentation exists to remove expensive ambiguity before implementation.

It should not delay practical testing indefinitely.

The project will use a staged approach:

```text
Architecture Foundation
        ↓
Production Contracts
        ↓
Execution Architecture
        ↓
MVP Test Specification
        ↓
Implementation Starts
```

---

## 2. Completed Foundation Documents

### Project Direction

- [x] `architecture/PROJECT-PLAN.md`
- [x] `architecture/INPUT-EVIDENCE-MODES.md`

### Scene Contract

- [x] `architecture/SCENE-SPEC-v0.1.md`

### AI Reliability

- [x] `architecture/AI-ORCHESTRATION-RELIABILITY.md`
- [x] `testing/AI-EVALS-AND-GOLDEN-DATASET.md`

### Evidence Reliability

- [x] `architecture/EVIDENCE-PROVENANCE-AND-CONFIDENCE.md`

### Spatial Conventions

- [x] `architecture/COORDINATES-UNITS-AND-SPATIAL-CONVENTIONS.md`

### Revision Safety

- [x] `architecture/OBJECT-IDENTITY-AND-REVISION-MODEL.md`

### Architecture Decisions

- [x] `decisions/0001-real-3d-source-of-truth.md`
- [x] `decisions/0002-scenespec-canonical-contract.md`
- [x] `decisions/0003-progressive-input-evidence.md`
- [x] `decisions/0004-ai-proposes-platform-validates.md`

---

## 3. Required Before First Serious 3D Implementation

These documents should be completed before the first production-oriented SceneSpec → 3ds Max prototype.

### P0.1 Coordinates, Units & Spatial Conventions ✅

File:

```text
architecture/COORDINATES-UNITS-AND-SPATIAL-CONVENTIONS.md
```

Defined:

- canonical unit: millimeters
- world origin
- up axis
- handedness
- rotation convention
- transform order
- local vs world coordinates
- pivot rules
- room coordinate frames
- asset normalization
- CAD → SceneSpec mapping
- SceneSpec → 3ds Max mapping
- tolerance rules

### P0.2 Object Identity & Revision Model ✅

File:

```text
architecture/OBJECT-IDENTITY-AND-REVISION-MODEL.md
```

Defined:

- stable logical IDs
- project, scene, asset-definition and DCC identity layers
- immutable logical identity
- asset replacement semantics
- object lifecycle states
- soft delete and restoration
- parent/child identity
- approval and property-level locks
- transactional revision history
- revision impact analysis
- render invalidation
- branch and merge behavior
- 3ds Max DCC mapping and reconciliation
- managed vs unmanaged object workflows
- AI identity boundaries

### P0.3 SceneChangeSet Specification

File:

```text
architecture/SCENE-CHANGESET-SPEC.md
```

Must define deterministic operations such as:

```text
CreateObject
DeleteObject
RestoreObject
ReplaceAsset
MoveObject
RotateObject
UpdateMaterial
UpdateGeometry
CreateCamera
UpdateLight
LockProperty
UnlockProperty
```

AI should propose `SceneChangeSet` operations rather than mutate a production scene directly.

### P0.4 Validation Engine

File:

```text
architecture/VALIDATION-ENGINE.md
```

Must define:

- schema validation
- evidence validation
- spatial validation
- collision validation
- room-boundary validation
- architectural rule validation
- locked-property checks
- renderer compatibility checks
- risk classification
- execution gates

---

## 4. Required Before Local Worker Development

### P1.1 3ds Max Worker Architecture

File:

```text
architecture/3DS-MAX-WORKER-ARCHITECTURE.md
```

Must define:

- process lifecycle
- communication protocol
- job format
- local service responsibilities
- 3ds Max launch / attach strategy
- script execution
- failure recovery
- timeout handling
- logging
- scene save strategy
- crash recovery
- idempotency

### P1.2 Scene Compiler Architecture

File:

```text
architecture/SCENE-COMPILER.md
```

Must define:

```text
SceneSpec
   ↓
Validated Intermediate Model
   ↓
DCC Commands
   ↓
3ds Max Scene
```

Compiler responsibilities must be separated from AI responsibilities.

### P1.3 Corona Adapter

File:

```text
architecture/CORONA-ADAPTER.md
```

Must define:

- renderer setup
- material compilation
- lights
- camera compatibility
- preview render settings
- production render settings
- render elements
- output naming
- error handling

V-Ray documentation can follow after Corona MVP is stable.

---

## 5. Required Before CAD Automation

### P2.1 CAD / Drawing Ingestion

File:

```text
architecture/CAD-AND-DRAWING-INGESTION.md
```

Must define:

- DWG
- DXF
- vector PDF
- raster PDF
- plans
- elevations
- sections
- drawing registration
- scale detection
- layer mapping
- dimensions
- openings
- room boundary extraction

### P2.2 Drawing Registration

File:

```text
architecture/PLAN-ELEVATION-SECTION-REGISTRATION.md
```

Must define how plan, elevation, and section data refer to the same physical objects.

Example:

```text
Plan Window W01
        ↕
Elevation Window W01
        ↕
SceneSpec Opening opening_w01
```

This will be important for progressive project accuracy.

---

## 6. Required Before Asset Automation

### P3.1 Asset Library Architecture

File:

```text
architecture/ASSET-LIBRARY.md
```

Must define:

- asset metadata
- dimensions
- category taxonomy
- tags
- styles
- renderer support
- native file path
- preview image
- material slots
- pivot standard
- bounding boxes
- licensing/source metadata
- versioning

### P3.2 Placement & Constraint Engine

File:

```text
architecture/PLACEMENT-AND-CONSTRAINT-ENGINE.md
```

Must define:

- room containment
- collision checks
- clearance
- door swings
- furniture relationships
- focal-point relationships
- placement scoring
- deterministic constraints
- AI proposal boundaries

---

## 7. Required Before Design Automation

### P4.1 Material System

```text
architecture/MATERIAL-SYSTEM.md
```

### P4.2 Lighting System

```text
architecture/LIGHTING-SYSTEM.md
```

### P4.3 Camera System

```text
architecture/CAMERA-SYSTEM.md
```

These documents should describe semantic intent separately from renderer implementation.

---

## 8. Required Before AI Is Connected to Production

### P5.1 AI Provider Gateway

```text
architecture/AI-PROVIDER-GATEWAY.md
```

### P5.2 AI Task Contracts

```text
architecture/AI-TASK-CONTRACTS.md
```

Each task should have explicit schemas.

Examples:

```text
AnalyzePlan
AnalyzeElevation
AnalyzeReference
ProposeLayout
FindAssets
InterpretRevision
CritiqueCamera
CritiqueRender
```

### P5.3 Model Routing Policy

```text
architecture/AI-MODEL-ROUTING.md
```

Models should be selected by task eval performance, latency, cost, availability, and risk.

---

## 9. MVP Test Documents

Before real implementation expands, create:

```text
testing/LIVING-ROOM-GOLDEN-PROJECT.md
testing/SCENESPEC-CONFORMANCE.md
testing/REVISION-SAFETY-TESTS.md
testing/3DS-MAX-AUTOMATION-TESTS.md
```

The first golden project should include:

```text
Plan
Reference Images
Optional Elevation
Verified Dimensions
Known Expected SceneSpec
Known Expected Room Geometry
Known Camera Targets
Expected Revision Cases
```

---

## 10. Documentation Stop Gate

Do **not** complete every future document before coding.

Implementation should start once these six are ready:

```text
1. SCENE-SPEC-v0.1.md                              ✅
2. EVIDENCE-PROVENANCE-AND-CONFIDENCE.md           ✅
3. COORDINATES-UNITS-AND-SPATIAL-CONVENTIONS.md    ✅
4. OBJECT-IDENTITY-AND-REVISION-MODEL.md           ✅
5. SCENE-CHANGESET-SPEC.md
6. 3DS-MAX-WORKER-ARCHITECTURE.md
```

At that point the first technical spike begins:

```text
SceneSpec JSON
      ↓
Local Worker
      ↓
3ds Max
      ↓
Create Room
      ↓
Create Camera
      ↓
Save .max
      ↓
Render Preview
```

Other documents can then evolve alongside real implementation findings.

---

## 11. Immediate Order

Recommended next sequence:

```text
NEXT 01
SCENE-CHANGESET-SPEC.md

NEXT 02
VALIDATION-ENGINE.md

NEXT 03
3DS-MAX-WORKER-ARCHITECTURE.md

NEXT 04
LIVING-ROOM-GOLDEN-PROJECT.md

THEN
Start local implementation
```

---

## 12. Long-Term Documentation Rule

Documents should be updated when real implementation proves an assumption wrong.

Architecture is a controlled evolving system, not a frozen initial guess.

Use ADRs for important irreversible or expensive decisions.

Use architecture documents for contracts and system behavior.

Use testing documents for measurable correctness.

Use workflow documents for human/operator procedures.
