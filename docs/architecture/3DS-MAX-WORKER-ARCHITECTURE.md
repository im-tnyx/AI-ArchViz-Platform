# 3ds Max Worker Architecture

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Purpose:** Define the deterministic Windows execution layer that converts validated platform jobs into controlled 3ds Max operations, editable `.max` scenes, and render outputs.

---

## 1. Why This Document Exists

AI ArchViz Platform needs a reliable bridge between platform-level scene data and the real production environment installed on a Windows workstation.

The worker must eventually coordinate:

- `SceneSpec`
- validated `SceneChangeSet`
- local asset files
- texture files
- 3ds Max
- Corona
- V-Ray
- project `.max` files
- preview renders
- final renders
- logs and diagnostics

The worker is an **execution system**, not an AI agent.

It must behave predictably when:

- 3ds Max is not running
- 3ds Max crashes
- a plugin is missing
- a texture path is invalid
- an asset file cannot be loaded
- a render fails
- a job is retried
- the workstation restarts
- the same job arrives twice
- a scene has been manually changed
- a previous revision must be restored

---

## 2. Core Rule

> The worker executes validated deterministic instructions. It does not decide architectural intent.

Canonical production boundary:

```text
User / AI / Drawings
        ↓
SceneChangeSet / SceneSpec
        ↓
Validation Engine
        ↓
Approved Execution Job
        ↓
3ds Max Worker
        ↓
DCC Command Plan
        ↓
3ds Max
        ↓
Verification
        ↓
Artifacts + Execution Report
```

The worker must never accept an arbitrary AI-generated Python, MAXScript, PowerShell, shell command, or executable payload as a production job.

---

## 3. Worker Responsibilities

The Windows worker is responsible for:

```text
Job Intake
Job Validation
Environment Inspection
Project Workspace Preparation
3ds Max Process Management
DCC Command Execution
Scene Save / Checkpoint
Preview Rendering
Output Collection
Post-execution Verification
Structured Logging
Failure Classification
Retry / Recovery
Artifact Reporting
```

The worker is **not** responsible for:

```text
Design Reasoning
Reference Interpretation
Choosing Architectural Dimensions
Unconstrained Furniture Decisions
AI Model Routing
Ignoring Scene Locks
Silently Repairing Conflicting Evidence
```

---

## 4. Initial Deployment Model

The first implementation runs on the existing Windows workstation.

```text
Local / Web UI
      ↓
Platform API
      ↓
Job Queue / Local Job Store
      ↓
Windows ArchViz Worker
      ↓
3ds Max
      ↓
Corona / V-Ray
      ↓
Project Outputs
```

The architecture must later support multiple workers without changing the scene domain model.

Future:

```text
Platform
   ↓
Scheduler
   ├── Workstation 01
   ├── Workstation 02
   ├── Render Node 01
   └── Cloud Worker
```

---

## 5. Worker Service

Recommended application boundary:

```text
apps/worker/
```

Initial implementation may run as a normal foreground process during development.

Later production options:

- Windows Service for orchestration
- tray application for operator visibility
- worker daemon plus optional desktop monitor

The actual 3ds Max process should remain separate from the orchestration service.

```text
Worker Service
     ↓
Process Supervisor
     ↓
3dsmax.exe / 3dsmaxbatch.exe
```

This separation allows the worker to detect, kill, restart, or quarantine a failed DCC process.

---

## 6. Execution Modes

The worker supports two explicit execution modes.

### 6.1 Batch Mode

Preferred for deterministic unattended jobs.

Conceptually:

```text
Job
 ↓
Prepare Workspace
 ↓
Generate Trusted Runner Input
 ↓
Launch 3dsmaxbatch.exe
 ↓
Load Scene
 ↓
Execute DCC Commands
 ↓
Save / Render
 ↓
Exit
```

Use cases:

- test automation
- scene generation
- batch revisions
- preview rendering
- validation jobs
- CI-like local conformance tests

Benefits:

- clean process per job or job group
- easier crash isolation
- easier timeout handling
- repeatable environment
- no dependency on user's current interactive Max session

### 6.2 Interactive Session Mode

Used when an artist/operator is actively working in 3ds Max.

```text
Operator opens project.max
          ↓
Worker establishes controlled bridge
          ↓
Validated SceneChangeSet
          ↓
Apply controlled revision
          ↓
Artist reviews scene
```

Use cases:

- supervised client revisions
- manual review
- development debugging
- approved interactive workflows

Interactive mode must not silently change a scene that contains unsaved unmanaged manual edits.

---

## 7. Initial Recommendation

For MVP technical reliability:

```text
Primary Automation Path = Batch Mode
Secondary Path          = Interactive Mode later
```

The first technical spike should prove batch execution before building a persistent interactive plugin bridge.

This reduces variables during early testing.

---

## 8. Autodesk Automation Surface

The initial implementation may use:

```text
Python + pymxs
MAXScript where pymxs coverage is inconvenient
3ds Max Batch
3ds Max command-line launch
```

`pymxs` should be the preferred scene scripting API for new Python automation where practical.

MAXScript remains valid for:

- APIs exposed more naturally through MAXScript
- compatibility helpers
- renderer-specific integration where examples/support are stronger
- bootstrap scripts

C++ / .NET plugins should only be introduced when a measurable requirement cannot be met reliably with scripting.

---

## 9. Trusted Runner Model

A critical security boundary is required.

The platform sends **data**, not executable source code.

Unsafe:

```json
{
  "script": "delete all objects; run arbitrary command"
}
```

Not allowed.

Allowed concept:

```json
{
  "jobType": "applySceneChangeSet",
  "sceneSpecPath": "...",
  "changeSetPath": "...",
  "outputPath": "..."
}
```

A trusted, version-controlled runner inside the repository interprets this data.

```text
Validated Job Data
       ↓
Trusted Worker Runner
       ↓
Known DCC Operations
       ↓
3ds Max API
```

The runner code is developed, reviewed, versioned, and shipped with the platform.

---

## 10. Job Envelope

Every worker job must have a stable envelope.

Example:

```json
{
  "jobId": "job_01JABC...",
  "projectId": "project_living_001",
  "sceneId": "scene_main",
  "jobType": "buildScene",
  "requestedRevisionId": "rev_0007",
  "baseRevisionId": "rev_0006",
  "workerRequirements": {
    "os": "windows",
    "dcc": "3ds_max",
    "dccVersion": "2026",
    "renderer": "corona"
  },
  "inputs": {
    "sceneSpec": "workspace/input/scene-spec.json"
  },
  "outputs": {
    "scene": "workspace/output/project.max",
    "report": "workspace/output/execution-report.json"
  },
  "policy": {
    "mode": "batch",
    "timeoutSeconds": 900,
    "retryPolicy": "safe"
  }
}
```

Exact schemas will eventually live in code, not only documentation.

---

## 11. Supported Job Types

Initial worker jobs:

```text
healthCheck
inspectEnvironment
createScene
buildScene
applySceneChangeSet
verifyScene
saveScene
renderPreview
```

Later:

```text
renderFinal
reconcileScene
extractSceneMetadata
importAsset
convertAsset
materialCompile
cameraPreviewBatch
renderElements
packageProject
```

Each job type must have a dedicated typed input contract.

---

## 12. Job State Machine

A job moves through explicit states.

```text
QUEUED
  ↓
CLAIMED
  ↓
PREPARING
  ↓
ENVIRONMENT_CHECK
  ↓
LAUNCHING_DCC
  ↓
EXECUTING
  ↓
VERIFYING
  ↓
SAVING_OUTPUTS
  ↓
SUCCEEDED
```

Failure paths:

```text
FAILED_RETRYABLE
FAILED_PERMANENT
BLOCKED_ENVIRONMENT
BLOCKED_VALIDATION
TIMED_OUT
CANCELLED
QUARANTINED
```

A job must never remain indefinitely in an ambiguous `RUNNING` state.

---

## 13. Project Workspace

Every job runs inside an isolated workspace.

Example:

```text
.workspaces/
└── job_01JABC/
    ├── input/
    │   ├── job.json
    │   ├── scene-spec.json
    │   └── change-set.json
    ├── project/
    │   └── working.max
    ├── assets/
    ├── textures/
    ├── temp/
    ├── logs/
    └── output/
        ├── project.max
        ├── preview-01.jpg
        └── execution-report.json
```

Production asset libraries should normally remain referenced from managed library locations rather than copied for every job unless packaging is requested.

---

## 14. Project File Safety

The worker must never directly overwrite the only known-good project scene.

Recommended pattern:

```text
Approved Scene
     ↓
Create Working Copy / Checkpoint
     ↓
Apply Changes
     ↓
Verify
     ↓
Save Candidate Scene
     ↓
Atomic Promote
```

Conceptual filenames:

```text
project.rev0006.max
project.rev0007.candidate.max
project.rev0007.max
```

A failed job leaves the last approved revision untouched.

---

## 15. Atomic Promotion

A scene becomes the active revision only after:

```text
DCC Execution Success
+
Scene Save Success
+
Post-save Verification
+
Required Render/Geometry Checks
```

Then:

```text
candidate → approved revision artifact
```

Database/project metadata should only move the active revision pointer after successful artifact promotion.

---

## 16. Process Lifecycle

For batch execution:

```text
Worker claims job
↓
Validate required files
↓
Check license/environment prerequisites
↓
Prepare isolated workspace
↓
Launch 3dsmaxbatch.exe
↓
Capture PID
↓
Stream/capture logs
↓
Execute trusted runner
↓
Wait for structured completion marker
↓
Collect exit code
↓
Verify outputs
↓
Terminate process if still alive
↓
Finalize job
```

The worker must track the OS process ID for every DCC execution.

---

## 17. 3ds Max Process Isolation

Initial safest policy:

```text
One mutable scene job per 3ds Max batch process
```

Do not reuse a long-running Max process for unrelated production jobs until strong cleanup and isolation tests exist.

Why:

- plugin state can leak
- globals can leak
- renderer state can leak
- scene callbacks can remain registered
- memory fragmentation can grow
- a bad job can poison the session

Process reuse may be optimized later after benchmarks.

---

## 18. Environment Manifest

Every worker has an environment manifest.

Example:

```json
{
  "workerId": "workstation_archviz_01",
  "os": "Windows 11",
  "dcc": {
    "name": "3ds_max",
    "version": "2026",
    "executable": "C:/Program Files/Autodesk/3ds Max 2026/3dsmax.exe",
    "batchExecutable": "C:/Program Files/Autodesk/3ds Max 2026/3dsmaxbatch.exe"
  },
  "renderers": {
    "corona": {
      "available": true,
      "version": "detected-at-runtime"
    },
    "vray": {
      "available": true,
      "version": "detected-at-runtime"
    }
  }
}
```

Do not hardcode renderer versions into platform assumptions.

Detect and report them.

---

## 19. Capability Discovery

Before accepting a job, the worker should report capabilities such as:

```text
3ds Max installed
3ds Max version
Batch executable available
Python runtime available
Required platform runner available
Corona installed
V-Ray installed
Asset library reachable
Texture roots reachable
Disk space
Memory
CPU
GPU metadata where relevant
```

Job scheduling later uses these capabilities.

---

## 20. Environment Compatibility Gate

Example:

```text
Job requires:
3ds Max 2026 + Corona

Worker has:
3ds Max 2026 + Corona

→ eligible
```

Another example:

```text
Job requires:
Corona material compilation

Worker has:
V-Ray only

→ BLOCKED_ENVIRONMENT
```

No silent renderer substitution.

---

## 21. DCC Command Plan

The worker should not translate high-level AI intent inside 3ds Max.

Before DCC execution, the platform/compiler produces deterministic operations.

Example conceptual plan:

```json
{
  "commands": [
    {
      "type": "CreateWall",
      "objectId": "wall_living_north",
      "start": [0, 0, 0],
      "end": [5200, 0, 0],
      "height": 3000,
      "thickness": 150
    },
    {
      "type": "CreateCamera",
      "objectId": "camera_living_01",
      "position": [1800, -900, 1500],
      "target": [3000, 2800, 1400],
      "focalLengthMm": 24
    }
  ]
}
```

This command plan is generated by trusted platform code.

---

## 22. DCC Adapter Boundary

Conceptual interface:

```ts
interface DccAdapter {
  inspectEnvironment(): Promise<DccEnvironment>;
  buildScene(input: BuildSceneJob): Promise<DccExecutionResult>;
  applyChangeSet(input: ApplyChangeSetJob): Promise<DccExecutionResult>;
  verifyScene(input: VerifySceneJob): Promise<SceneVerificationResult>;
  saveScene(input: SaveSceneJob): Promise<ArtifactResult>;
  renderPreview(input: RenderPreviewJob): Promise<RenderResult>;
}
```

Initial implementation:

```text
ThreeDsMaxAdapter
```

Future:

```text
BlenderAdapter
UnrealAdapter
USDAdapter
```

---

## 23. 3ds Max Logical Object Mapping

Every managed node in 3ds Max must carry platform identity metadata.

Conceptually:

```text
SceneSpec objectId
       ↕
3ds Max managed node
```

Do not rely only on node names.

A managed node should retain fields equivalent to:

```json
{
  "projectObjectId": "asset_living_sofa_main",
  "sceneRevisionId": "rev_0007",
  "managedBy": "ai-archviz-platform"
}
```

The exact storage mechanism will be determined during implementation tests.

---

## 24. Managed vs Unmanaged Objects

A 3ds Max scene may contain artist-created objects.

The worker must distinguish:

```text
Managed Object
→ owned by platform identity and revision system

Unmanaged Object
→ manually created / not yet adopted
```

Default rule:

> Automation must not delete or mutate unmanaged objects unless an explicit adoption or authorized operation exists.

This is critical for real studio workflows.

---

## 25. Manual Edit Detection

Before applying an automated revision to an existing scene, the worker should eventually detect divergence.

Conceptual states:

```text
IN_SYNC
DIVERGED_MANAGED_OBJECTS
UNMANAGED_CHANGES_PRESENT
SCENE_REVISION_MISMATCH
```

If managed scene state differs from expected revision:

```text
do not silently overwrite
```

Instead:

```text
reconcile
require approval
or rebuild from canonical SceneSpec
```

depending on policy.

---

## 26. Scene Build Modes

### 26.1 Fresh Build

```text
Empty scene
+
SceneSpec
↓
Generate complete managed scene
```

Useful for deterministic conformance tests.

### 26.2 Incremental Sync

```text
Existing managed scene
+
SceneChangeSet
↓
Change affected objects only
```

Useful for revisions.

### 26.3 Rebuild Managed Layer

```text
Existing scene
↓
Preserve allowed unmanaged content
↓
Rebuild platform-managed objects
```

This may become useful for recovery.

---

## 27. Idempotency

Re-running the same approved job must not duplicate scene objects or apply movement twice.

Example:

```text
Apply changeSet cs_010 once
→ sofa moves +300 mm

Retry cs_010
→ sofa remains at target transform
→ it does NOT move another +300 mm
```

Therefore mutations should primarily encode desired state or unique operation IDs rather than blind relative commands without guards.

Each executed operation must be traceable by:

```text
jobId
changeSetId
operationId
baseRevisionId
targetRevisionId
```

---

## 28. Retry Policy

Retries must be classified.

### Safe retry examples

```text
3ds Max failed to launch
Temporary file lock
Transient renderer startup failure
Temporary output write error
```

### Not automatically retryable

```text
Invalid SceneSpec
Missing required asset
Scene lock violation
Revision mismatch
Unsupported plugin
Deterministic script exception caused by bad input
```

Retrying a permanent input failure wastes time and can create damage.

---

## 29. Timeout Policy

Every job declares a timeout appropriate to its operation type.

Examples:

```text
healthCheck       → short
create test scene → short
preview render    → medium
final render      → long
```

Timeout behavior:

```text
deadline reached
↓
request graceful termination when possible
↓
wait bounded grace period
↓
terminate child DCC process
↓
mark TIMED_OUT
↓
preserve logs and diagnostic workspace
```

Never leave orphaned `3dsmax.exe` processes indefinitely.

---

## 30. Crash Recovery

The worker must assume 3ds Max can crash.

Required recovery data:

```text
job state
process id
input hashes
last completed operation
checkpoint path
logs
candidate output path
```

After worker restart:

```text
find jobs in non-terminal states
↓
inspect whether DCC process still exists
↓
classify interrupted job
↓
recover or fail safely
```

A crash must not automatically promote a candidate scene.

---

## 31. Checkpoints

Longer mutation jobs may create checkpoints.

Conceptual:

```text
checkpoint_00_input.max
checkpoint_01_geometry.max
checkpoint_02_assets.max
checkpoint_03_materials.max
candidate.max
```

MVP should keep checkpointing simple to avoid unnecessary disk overhead.

Use checkpoints where recovery value is high.

---

## 32. Structured Logging

Every log entry should contain machine-readable context.

Example:

```json
{
  "timestamp": "2026-08-13T09:30:00Z",
  "level": "info",
  "jobId": "job_01JABC",
  "workerId": "workstation_archviz_01",
  "component": "three-ds-max-adapter",
  "event": "OBJECT_CREATED",
  "objectId": "wall_living_north"
}
```

Logs should exist at multiple levels:

```text
worker.log
process.log
3ds-max-runner.log
renderer.log
execution-report.json
```

---

## 33. Execution Report

Every completed DCC job returns a structured report.

Example:

```json
{
  "jobId": "job_01JABC",
  "status": "SUCCEEDED",
  "dcc": {
    "name": "3ds_max",
    "version": "2026"
  },
  "operations": {
    "requested": 8,
    "completed": 8,
    "failed": 0
  },
  "managedObjects": {
    "created": 5,
    "updated": 3,
    "deleted": 0
  },
  "artifacts": [
    "project.rev0007.max",
    "preview-01.jpg"
  ],
  "warnings": []
}
```

The report is part of the audit trail.

---

## 34. Error Taxonomy

Errors must be structured rather than arbitrary strings.

Top-level classes:

```text
WORKER_CONFIGURATION_ERROR
ENVIRONMENT_ERROR
DCC_LAUNCH_ERROR
DCC_CRASH
DCC_SCRIPT_ERROR
ASSET_ERROR
TEXTURE_ERROR
SCENE_MISMATCH_ERROR
RENDERER_ERROR
RENDER_ERROR
OUTPUT_ERROR
TIMEOUT_ERROR
CANCELLED_ERROR
UNKNOWN_EXECUTION_ERROR
```

Each error should include:

```text
code
message
jobId
operationId when applicable
retryable
technical details
human-readable resolution hint
```

---

## 35. Asset Resolution

The worker should receive resolved asset references from the platform.

Preferred:

```text
assetDefinitionId
assetVersion
validated local/native path
expected checksum
```

The worker verifies availability before launching expensive DCC work.

Example:

```text
Asset missing
→ fail during PREPARING
→ do not launch 3ds Max
```

---

## 36. Texture Resolution

Texture path validation should happen before rendering.

Classify textures:

```text
AVAILABLE
MISSING
UNSUPPORTED_PATH
VERSION_MISMATCH
```

Missing critical textures should not silently produce a final approved render.

Preview policy may allow controlled placeholders with warnings.

---

## 37. Renderer Integration Boundary

The worker manages DCC execution but renderer-specific logic belongs in renderer adapters.

```text
Worker
  ↓
3ds Max Adapter
  ↓
Renderer Adapter
     ├── CoronaAdapter
     └── VRayAdapter
```

The worker must not scatter Corona-specific or V-Ray-specific business rules throughout generic orchestration code.

---

## 38. Preview Render Pipeline

MVP preview job:

```text
Validated Scene
↓
Select managed camera
↓
Apply preview renderer preset
↓
Render low/medium resolution
↓
Verify output image exists
↓
Record render metadata
↓
Return artifact
```

Preview renders are diagnostic artifacts as well as visual outputs.

---

## 39. Render Verification

A renderer returning without process failure does not automatically mean success.

Verification may check:

```text
output file exists
file size > minimum threshold
expected dimensions
camera ID matches request
renderer matches request
scene revision matches request
render is not completely empty/black where detectable
```

AI visual critique can be added later, after deterministic checks.

---

## 40. Scene Verification

After scene build or revision, verify at least:

```text
expected managed object count
required logical IDs present
no duplicate logical IDs
scene units correct
managed transforms within tolerance
required camera exists
required renderer available
output scene saved successfully
scene revision metadata correct
```

Later verification can include geometry hashes and bounding-box comparisons.

---

## 41. Preflight Checks

Before launching 3ds Max:

```text
Job schema valid
Validation approval present
SceneSpec compatible
Base revision matches
Inputs exist
Output directory writable
Disk space sufficient
3ds Max executable exists
Required renderer available
Required asset roots reachable
No conflicting active project lock
```

Fail early whenever possible.

---

## 42. Project Locks

To prevent two jobs from mutating the same project scene simultaneously:

```text
Project Revision Mutation Lock
```

At most one mutation job for the same scene branch may be active at a time.

Render-only jobs may later execute concurrently when they operate on immutable scene artifacts.

---

## 43. Concurrency Model

MVP:

```text
1 worker machine
1 mutable DCC job at a time
```

This is deliberately conservative.

Later:

```text
multiple render jobs
multiple worker machines
scene branch isolation
capability-based scheduling
```

Correctness comes before throughput.

---

## 44. Cancellation

Cancellation must be explicit.

States:

```text
CANCELLATION_REQUESTED
CANCELLING
CANCELLED
```

For mutable jobs:

- do not promote candidate scene
- preserve last approved scene
- clean temporary files when safe
- keep diagnostic logs

---

## 45. Secrets and Credentials

The 3ds Max runner should not receive AI API keys unless a specific trusted renderer/plugin workflow requires them.

Preferred separation:

```text
AI credentials → backend AI gateway
DCC worker      → execution-only credentials/resources
```

Local worker secrets should use OS/environment secret storage rather than SceneSpec files.

---

## 46. File Path Security

Job paths must be resolved against approved workspace roots and asset-library roots.

Reject unexpected traversal such as:

```text
../../../../...
```

Do not allow a job payload to request arbitrary deletion or overwrite of OS/user files.

---

## 47. Arbitrary Execution Prevention

Production worker payloads must never expose general-purpose fields such as:

```text
shellCommand
powershell
pythonCode
maxscriptCode
executablePathFromAI
```

Internal development tools may execute scripts, but production job contracts should reference trusted runner versions and known typed operations.

---

## 48. Runner Versioning

Every execution report records platform runner versions.

Example:

```json
{
  "workerVersion": "0.1.0",
  "maxRunnerVersion": "0.1.0",
  "sceneCompilerVersion": "0.1.0"
}
```

This makes historical revisions reproducible and diagnosable.

---

## 49. Reproducibility Metadata

For important scene builds, record:

```text
SceneSpec version
SceneSpec hash
ChangeSet hash
asset versions
worker version
runner version
3ds Max version
renderer version
material compiler version
job ID
revision ID
```

This helps answer:

> Why does the same scene render differently six months later?

---

## 50. Initial Repository Structure

Recommended implementation areas:

```text
apps/
└── worker/
    ├── src/
    │   ├── jobs/
    │   ├── supervisor/
    │   ├── workspace/
    │   ├── environment/
    │   ├── logging/
    │   └── adapters/
    └── tests/

packages/
├── worker-contracts/
├── scene-spec/
├── scene-changeset/
├── validation/
└── scene-compiler/

tools/
└── 3ds-max/
    ├── bootstrap/
    ├── python/
    ├── maxscript/
    └── diagnostics/
```

Names may evolve during implementation.

---

## 51. Health Check

Before any real scene creation, build a worker health-check command.

Expected response:

```json
{
  "worker": "ok",
  "3dsMax": "ok",
  "python": "ok",
  "pymxs": "ok",
  "corona": "available",
  "vray": "available",
  "filesystem": "ok"
}
```

The health check should use actual executable/runtime inspection rather than configuration-only assumptions.

---

## 52. First Technical Spike

The first real implementation should be intentionally small.

### Input

```json
{
  "room": {
    "width": 5000,
    "length": 4000,
    "height": 3000
  },
  "camera": {
    "position": [2500, -1500, 1500],
    "target": [2500, 2000, 1400]
  }
}
```

### Worker must

```text
1. Validate input
2. Create job workspace
3. Launch 3ds Max Batch
4. Execute trusted Python runner
5. Create floor / walls
6. Create camera
7. Save .max
8. Exit cleanly
9. Verify .max exists
10. Return execution-report.json
```

No AI is involved.

---

## 53. Second Technical Spike

After scene creation works:

```text
Existing .max
+
SceneChangeSet
↓
Move one managed object
↓
Save new revision
↓
Verify object identity remained stable
```

This proves revision infrastructure.

---

## 54. Third Technical Spike

Add Corona preview rendering:

```text
Generated room
+
Camera
+
Basic light/environment
↓
Corona preview
↓
preview.jpg
```

Only after this deterministic pipeline works should AI-driven planning enter production execution.

---

## 55. MVP Acceptance Criteria

Worker foundation is successful when all of these are repeatable:

```text
[ ] Worker detects installed 3ds Max
[ ] Worker can launch 3ds Max Batch
[ ] Trusted Python script runs through pymxs
[ ] Scene unit normalization is correct
[ ] Scene can be created from structured input
[ ] Logical object IDs can be written/read
[ ] Camera can be created deterministically
[ ] .max can be saved to candidate path
[ ] Candidate can be verified
[ ] Failed job does not overwrite approved scene
[ ] Same job can be retried safely
[ ] Timeout kills orphan process safely
[ ] Structured execution report is produced
[ ] Logs identify failed operation
[ ] Corona preview can be produced when renderer adapter is enabled
```

---

## 56. Testing Requirements

Worker tests should include:

### Unit tests

- job state transitions
- workspace path rules
- timeout logic
- retry classification
- capability matching
- artifact promotion rules

### Integration tests

- launch 3ds Max Batch
- execute Python
- save `.max`
- reopen scene
- read logical IDs
- perform deterministic revision

### Failure tests

- invalid executable path
- missing asset
- invalid SceneSpec
- forced script exception
- forced timeout
- renderer unavailable
- output path failure
- stale revision

---

## 57. Observability

Development UI or CLI should eventually show:

```text
Worker: Online
3ds Max: 2026
Corona: Available
Active Job: job_01JABC
Stage: EXECUTING
Elapsed: ...
Current Operation: CreateCamera
```

This is especially important because DCC automation can otherwise feel opaque.

---

## 58. Development Principle

Avoid building a large plugin before proving external batch automation.

Recommended progression:

```text
CLI script
↓
Worker process
↓
3ds Max Batch integration
↓
Scene build
↓
Revision sync
↓
Renderer integration
↓
Interactive 3ds Max plugin/panel
```

This keeps early failures easy to isolate.

---

## 59. Future Interactive Plugin

After the worker is stable, a 3ds Max plugin/panel can provide:

```text
Project status
Current SceneSpec revision
Sync status
Pending revisions
Apply approved revision
Lock selected object
Adopt unmanaged object
Render preview
Show validation issues
Reconnect missing assets
```

The plugin should use the same platform contracts as batch mode rather than invent a second scene-control model.

---

## 60. Future Multi-Worker Architecture

Later scheduler flow:

```text
Job
↓
Requirements
↓
Capability Matcher
↓
Eligible Workers
↓
Lease Job
↓
Heartbeat
↓
Execute
↓
Return Artifacts
```

Workers should lease jobs with expiration so crashed workers do not permanently own queued work.

---

## 61. Worker Trust Model

The local worker is a high-trust component because it can control installed production software and files.

Therefore:

- only authenticated platform jobs should reach it
- only typed operations should execute
- asset/file paths must be constrained
- scripts must come from trusted installed runner code
- every mutation must have a job and revision identity
- destructive filesystem behavior must not be exposed as generic job functionality

---

## 62. Relationship to Validation Engine

The worker does not re-decide architectural validity.

However, it must verify that execution authorization is present and current.

```text
Validation Engine
→ approves target ChangeSet/revision

Worker
→ verifies approval token/revision context
→ performs execution-level preflight
```

Execution-level failures remain possible even after domain validation.

---

## 63. Relationship to Scene Compiler

The worker orchestrates execution.

The Scene Compiler decides **what DCC operations are needed**.

```text
SceneSpec / ChangeSet
        ↓
Scene Compiler
        ↓
Typed DCC Command Plan
        ↓
Worker
        ↓
3ds Max Adapter
```

Do not mix compilation/planning logic with process supervision.

---

## 64. Relationship to Renderer Adapter

The renderer adapter converts renderer-neutral intent into specific renderer operations.

Example:

```text
Logical Material
↓
CoronaAdapter
↓
CoronaPhysicalMtl operations
```

The worker only coordinates when and where that compilation is executed.

---

## 65. Design Decision Summary

For MVP:

```text
Windows local worker
3ds Max as first DCC
3ds Max Batch as primary unattended execution path
Python + pymxs as preferred automation layer
MAXScript as supported compatibility/bootstrap layer
one mutable DCC job at a time
isolated job workspace
candidate-scene save before promotion
structured job state machine
structured execution reports
strict idempotency
no arbitrary AI-generated code execution
Corona integration after base scene automation works
```

---

## 66. Implementation Gate

With this architecture document complete, the documentation foundation required for the first deterministic technical spike is satisfied.

The next step is **not another large architecture phase**.

The next step is to prepare a small golden test and start implementation:

```text
SceneSpec Test Fixture
        ↓
Worker Skeleton
        ↓
3ds Max Batch Health Check
        ↓
Create Room
        ↓
Create Camera
        ↓
Save .max
        ↓
Verify Artifact
```

Further documentation should evolve alongside real implementation findings.
