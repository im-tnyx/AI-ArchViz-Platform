# Documentation Roadmap

**Status:** Implementation Ready  
**Project:** AI ArchViz Platform  
**Goal:** Maintain the minimum architecture documentation needed for reliable implementation without allowing planning to delay practical testing.

---

## 1. Principle

Documentation exists to remove expensive ambiguity before implementation.

It must evolve with real testing rather than become a substitute for implementation.

```text
Architecture Foundation
        ↓
Production Contracts
        ↓
Execution Architecture
        ↓
Golden Test
        ↓
Implementation
        ↓
Measured Findings
        ↓
Documentation Updates / ADRs
```

---

## 2. Foundation Status

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
- [x] `architecture/SCENE-CHANGESET-SPEC.md`

### Validation Safety

- [x] `architecture/VALIDATION-ENGINE.md`

### Execution Architecture

- [x] `architecture/3DS-MAX-WORKER-ARCHITECTURE.md`

### Golden Test

- [x] `testing/LIVING-ROOM-GOLDEN-PROJECT.md`

### Architecture Decisions

- [x] `decisions/0001-real-3d-source-of-truth.md`
- [x] `decisions/0002-scenespec-canonical-contract.md`
- [x] `decisions/0003-progressive-input-evidence.md`
- [x] `decisions/0004-ai-proposes-platform-validates.md`

---

## 3. Documentation Stop Gate — COMPLETE

The minimum architecture gate required before local implementation is complete:

```text
1. SCENE-SPEC-v0.1.md                              ✅
2. EVIDENCE-PROVENANCE-AND-CONFIDENCE.md           ✅
3. COORDINATES-UNITS-AND-SPATIAL-CONVENTIONS.md    ✅
4. OBJECT-IDENTITY-AND-REVISION-MODEL.md           ✅
5. SCENE-CHANGESET-SPEC.md                         ✅
6. 3DS-MAX-WORKER-ARCHITECTURE.md                  ✅
7. VALIDATION-ENGINE.md                             ✅
8. LIVING-ROOM-GOLDEN-PROJECT.md                   ✅
```

Do not create another large architecture phase before beginning the deterministic technical spike.

---

## 4. Current Next Action — IMPLEMENTATION

The next work is code, not another planning document.

First technical spike:

```text
Golden SceneSpec Fixture
        ↓
Worker Skeleton
        ↓
3ds Max Environment Health Check
        ↓
3ds Max Batch Launch
        ↓
Trusted Python + pymxs Runner
        ↓
Create Basic Geometry
        ↓
Create Room
        ↓
Create Camera
        ↓
Write Logical IDs
        ↓
Save Candidate .max
        ↓
Re-open / Verify
        ↓
Execution Report
```

No AI is required in this path.

---

## 5. Initial Repository Implementation Areas

Create only the pieces needed by the golden project:

```text
apps/worker/
packages/scene-spec/
packages/worker-contracts/
packages/validation/
tools/3ds-max/python/
tools/3ds-max/maxscript/
tests/fixtures/living-room-golden/
```

Suggested first fixture files:

```text
tests/fixtures/living-room-golden/
├── scene-spec.json
├── expected/
│   ├── geometry.json
│   ├── identities.json
│   └── revisions.json
└── changesets/
    ├── r1-replace-sofa.json
    ├── r2-move-coffee-table.json
    ├── r3-change-tv-wall-material.json
    ├── r4-locked-ceiling-change.json
    └── r5-revised-window-elevation.json
```

---

## 6. Technical Spike Milestones

### Spike 01 — Environment Proof

Pass when:

```text
Worker finds configured 3ds Max executable
Worker records 3ds Max version
Worker starts controlled process
Trusted script executes
Structured success/failure report returns
```

### Spike 02 — Scene Proof

Pass when:

```text
SceneSpec → 3ds Max → valid .max
```

Required:

- millimeter units
- room shell
- floor
- ceiling
- one opening minimum
- stable logical IDs
- camera
- save candidate `.max`
- re-open or verify output

### Spike 03 — Idempotency Proof

Run the same input twice.

Pass when:

```text
No duplicated managed objects
Same logical scene state
Safe job replay
```

### Spike 04 — Revision Proof

Apply one SceneChangeSet.

Recommended first change:

```text
Move coffee table +250 mm on X
```

Pass when:

- only the target object changes
- logical ID remains stable
- revision is recorded
- unrelated scene objects remain unchanged

### Spike 05 — Corona Preview Proof

Pass when:

```text
Managed scene + camera → preview render
```

Renderer automation should not block Spikes 01-04.

---

## 7. Documents to Create Alongside Implementation

These are important, but should be written when real implementation exposes real requirements.

### Scene Execution

- [ ] `architecture/SCENE-COMPILER.md`
- [ ] `architecture/CORONA-ADAPTER.md`
- [ ] `testing/3DS-MAX-AUTOMATION-TESTS.md`
- [ ] `testing/SCENESPEC-CONFORMANCE.md`
- [ ] `testing/REVISION-SAFETY-TESTS.md`

### CAD / Drawings

- [ ] `architecture/CAD-AND-DRAWING-INGESTION.md`
- [ ] `architecture/PLAN-ELEVATION-SECTION-REGISTRATION.md`

### Asset Automation

- [ ] `architecture/ASSET-LIBRARY.md`
- [ ] `architecture/PLACEMENT-AND-CONSTRAINT-ENGINE.md`

### Design Automation

- [ ] `architecture/MATERIAL-SYSTEM.md`
- [ ] `architecture/LIGHTING-SYSTEM.md`
- [ ] `architecture/CAMERA-SYSTEM.md`

### AI Production Integration

- [ ] `architecture/AI-PROVIDER-GATEWAY.md`
- [ ] `architecture/AI-TASK-CONTRACTS.md`
- [ ] `architecture/AI-MODEL-ROUTING.md`

---

## 8. Renderer Order

For initial work:

```text
3ds Max scene automation
        ↓
Stable .max save/reopen
        ↓
Camera
        ↓
Corona preview adapter
        ↓
Materials / lights
        ↓
V-Ray adapter later
```

Renderer automation should not block proof of the basic scene pipeline.

---

## 9. CAD Order

Do not connect real DWG ingestion before the deterministic scene compiler works with known test geometry.

Recommended order:

```text
Known SceneSpec
↓
Known 3ds Max output
↓
Verified geometry
↓
Then DWG / DXF parser
↓
Then Plan + Elevation registration
```

This isolates CAD parsing errors from DCC automation errors.

---

## 10. AI Order

Do not place AI inside the first worker execution path.

Recommended order:

```text
Deterministic SceneSpec
↓
Deterministic Validation
↓
Deterministic Worker
↓
Revision-safe SceneChangeSet
↓
Golden tests
↓
Then AI proposes structured inputs
```

AI remains upstream of validation.

---

## 11. Major Product Milestones

### Milestone A — Worker Proof

```text
SceneSpec → 3ds Max → .max
```

### Milestone B — Revision Proof

```text
Existing Scene + SceneChangeSet
→ deterministic object revision
→ new .max revision
```

### Milestone C — Render Proof

```text
Managed Scene + Camera
→ Corona preview
```

### Milestone D — CAD Proof

```text
Known DWG/DXF
→ normalized geometry
→ SceneSpec
→ matching 3ds Max scene
```

### Milestone E — Reference / AI Proof

```text
Plan + Reference
→ structured proposal
→ validation
→ managed scene revision
```

### Milestone F — Plan + Elevation Proof

```text
Plan + Elevation + Reference
→ registered architectural evidence
→ higher-confidence SceneSpec
→ targeted scene update
```

---

## 12. Documentation Rule Going Forward

Use:

- **Architecture documents** for system contracts and boundaries.
- **ADRs** for important decisions that are expensive to reverse.
- **Testing documents** for measurable correctness and golden cases.
- **Workflow documents** for operator/studio procedures.

When implementation disproves an assumption, update the document rather than forcing code to match an outdated plan.

---

## 13. Current Status

```text
FOUNDATION DOCUMENTATION   ✅ COMPLETE
GOLDEN TEST SPEC           ✅ COMPLETE
LOCAL IMPLEMENTATION       ▶ NEXT
AI PRODUCTION INTEGRATION  ⏸ NOT YET
CAD INGESTION              ⏸ AFTER WORKER PROOF
```

The next repository change should initialize the implementation skeleton and create the first machine-readable living-room golden SceneSpec fixture.
