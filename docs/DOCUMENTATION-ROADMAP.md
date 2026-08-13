# Documentation Roadmap

**Status:** Ready for Technical Spike
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
- [x] `decisions/0003-flexible-input-evidence-modes.md`
- [x] `decisions/0004-ai-proposes-platform-validates.md`

---

## 3. Contract Closure Gate

The deterministic contract gate requires the architecture documents plus the
machine-readable schemas and Golden fixtures:

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

Do not create another large architecture phase. Complete the contract checklist
and then begin only the deterministic technical spike.

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

Normative v0.1 fixture files:

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

---

## 6. Technical Spike Milestones

### Spike 01A — Environment Proof

Pass when:

```text
Worker finds configured 3ds Max executable
Worker records 3ds Max version
Worker starts controlled process
Trusted script executes
Structured success/failure report returns
```

### Spike 01B — Scene and Fresh-Reopen Proof

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
- exit build process and reopen candidate in a fresh second process
- extract and compare normalized semantic manifest

### Spike 01C — Idempotency, Failure, and Timeout Proof

Run the same input twice.

Pass when:

```text
No duplicated managed objects
Same logical scene state
Safe job replay
Durable replay survives worker restart
Forced failure leaves verified output untouched
Timeout terminates owned child processes
```

### Spike 02 — Minimal Revision Proof

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

### Spike 03 — Corona Preview Proof

Pass when:

```text
Managed scene + camera → preview render
```

Renderer automation must not block Spike 01 or the minimal revision proof.

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

## 13. Contract Closure Acceptance

- [x] One normative SceneSpec root
- [x] JSON Schema exists
- [x] `scene.id` exists
- [x] Revision ownership frozen
- [x] Shared Transform type frozen
- [x] Euler order frozen
- [x] Wall baseline semantics frozen
- [x] Thickness side frozen
- [x] Opening offset semantics frozen
- [x] Hinge/swing semantics frozen
- [x] Golden transforms are numeric
- [x] Camera A mathematically faces south
- [x] Golden `scene-spec.json` exists
- [x] `expected-scene-manifest.json` exists
- [x] `fixture-manifest.json` exists
- [x] Job Envelope schema exists
- [x] `idempotencyKey` exists
- [x] `requestHash` exists
- [x] Replay semantics frozen
- [x] DCC enum is `3ds_max`
- [x] Node prefix is `AVZ_`
- [x] `AIArchViz.LogicalObjectId` is authoritative in `.max`
- [x] `nodeHandle` is runtime-only
- [x] Fresh second-process reopen is mandatory
- [x] Semantic manifest verification is mandatory
- [x] Execution Report schema exists
- [x] Artifact naming is unified
- [x] Hard locks always `BLOCK`
- [x] Ad-hoc scene input contract removed
- [x] ADR filename reference corrected

## 14. Current Status

```text
FOUNDATION DOCUMENTATION   ✅ COMPLETE
MACHINE CONTRACTS          ✅ READY
GOLDEN FIXTURES            ✅ READY
LOCAL IMPLEMENTATION       ▶ NEXT
AI PRODUCTION INTEGRATION  ⏸ NOT YET
CAD INGESTION              ⏸ AFTER WORKER PROOF
```

After schema/fixture validation passes, the next repository change should
initialize only the minimal deterministic worker/toolchain skeleton.
