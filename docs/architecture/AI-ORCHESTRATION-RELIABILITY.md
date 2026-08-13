# AI Orchestration & Reliability Architecture

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Primary Goal:** Make AI useful without allowing probabilistic model output to corrupt architectural truth, approved design decisions, or production scenes.

---

## 1. Purpose

AI ArchViz Platform uses AI for understanding, planning, classification, reference analysis, asset search intent, design suggestions, camera critique, render critique, and natural-language revisions.

AI must **not** be treated as a trusted scene executor.

The platform must remain reliable even when:

- a model hallucinates a dimension
- a provider changes behavior
- structured output is syntactically valid but semantically wrong
- a tool call contains unsafe or impossible arguments
- two references conflict
- a floor plan and elevation disagree
- a provider is unavailable
- a newer model replaces the current model
- a user requests a revision that would break approved geometry

The architecture therefore separates **reasoning** from **authority**.

---

## 2. Core Rule

> **AI proposes. The platform validates. Deterministic engines execute. Verification decides whether the result is accepted.**

Canonical flow:

```text
User / Drawing / Reference
          ↓
      AI Analysis
          ↓
  Structured Proposal
          ↓
   Schema Validation
          ↓
 Evidence / Rule Validation
          ↓
 Constraint Validation
          ↓
   Risk / Approval Gate
          ↓
      Dry Run / Diff
          ↓
 Deterministic Execution
          ↓
  Scene / Render Verification
          ↓
     Commit or Rollback
```

AI output must never directly mutate an approved `.max` scene.

---

## 3. Architecture Layers

```text
┌─────────────────────────────────────────────┐
│ Input Layer                                 │
│ Plan / Elevation / PDF / Images / User      │
└──────────────────────┬──────────────────────┘
                       ↓
┌─────────────────────────────────────────────┐
│ Evidence Layer                              │
│ Extraction / Provenance / Confidence        │
└──────────────────────┬──────────────────────┘
                       ↓
┌─────────────────────────────────────────────┐
│ AI Gateway                                  │
│ Provider Routing / Prompt Registry / Models │
└──────────────────────┬──────────────────────┘
                       ↓
┌─────────────────────────────────────────────┐
│ Proposal Layer                              │
│ Strict Task-Specific Structured Output      │
└──────────────────────┬──────────────────────┘
                       ↓
┌─────────────────────────────────────────────┐
│ Validation Layer                            │
│ Schema / Domain / Spatial / Evidence Rules  │
└──────────────────────┬──────────────────────┘
                       ↓
┌─────────────────────────────────────────────┐
│ Change Engine                               │
│ SceneChangeSet / Risk / Dry Run / Diff      │
└──────────────────────┬──────────────────────┘
                       ↓
┌─────────────────────────────────────────────┐
│ Deterministic Execution                     │
│ Scene Compiler / 3ds Max / Renderer Adapter │
└──────────────────────┬──────────────────────┘
                       ↓
┌─────────────────────────────────────────────┐
│ Verification                                │
│ Geometry / Collision / Render / Regression  │
└─────────────────────────────────────────────┘
```

---

## 4. No Single "Best AI" Is Hard-Coded

The platform must not permanently declare one provider or one model as the best.

Models change. Prices change. latency changes. vision quality changes. APIs evolve.

Instead, maintain a `ModelRegistry` and route each task to the model that performs best on **our own ArchViz evaluation dataset**.

Example conceptual registry:

```ts
interface ModelCapabilityProfile {
  provider: string;
  model: string;
  supportsImages: boolean;
  supportsPdf: boolean;
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  tasks: Array<{
    task: string;
    qualityScore: number;
    reliabilityScore: number;
    latencyScore: number;
    costScore: number;
  }>;
}
```

Provider selection is a runtime/configuration concern, not core business logic.

---

## 5. Task-Specific Routing

Do not send the complete project to one giant agent and ask it to "make the room".

Split work into narrow tasks.

Examples:

```text
FloorPlanExtraction
ElevationExtraction
ReferenceStyleAnalysis
MaterialClassification
FurnitureIntentAnalysis
AssetCandidateRanking
LayoutProposal
CameraCandidateRanking
RenderCritique
RevisionIntentParsing
```

Each task should have:

- a dedicated input contract
- a dedicated output schema
- allowed evidence types
- validation rules
- risk classification
- evaluation dataset
- provider/model benchmark

This reduces uncontrolled behavior and makes failures diagnosable.

---

## 6. AI Gateway

Core domain modules never call OpenAI, Gemini, Claude, xAI, or another provider directly.

They call the platform `AIGateway`.

```ts
interface AIGateway {
  execute<TInput, TOutput>(
    task: AITask<TInput, TOutput>,
    input: TInput,
    context: AIExecutionContext
  ): Promise<AIExecutionResult<TOutput>>;
}
```

Conceptual provider adapter:

```ts
interface AIProviderAdapter {
  executeStructured<T>(request: StructuredAIRequest<T>): Promise<T>;
  supports(capability: AICapability): boolean;
  health(): Promise<ProviderHealth>;
}
```

Adapters may include:

```text
OpenAIAdapter
GeminiAdapter
ClaudeAdapter
XAIAdapter
FutureProviderAdapter
```

---

## 7. Strict Structured Output

Production AI tasks must not depend on free-form prose parsing.

Use provider-supported structured output / JSON Schema whenever available.

Bad:

```text
"The room appears to be about 4.5 meters wide and I think the sofa should go near the left wall."
```

Better:

```json
{
  "observations": [
    {
      "type": "room_width",
      "value": 4500,
      "unit": "mm",
      "sourceEvidenceIds": ["evidence_plan_12"],
      "confidence": 0.62,
      "status": "inferred"
    }
  ]
}
```

Important:

> Schema-valid output is not automatically domain-valid output.

Every response still passes application validation.

---

## 8. Typed Proposals, Not Scene Mutations

AI should emit proposal objects.

Examples:

```text
GeometryProposal
AssetSelectionProposal
PlacementProposal
MaterialProposal
LightingProposal
CameraProposal
RevisionProposal
```

Example:

```json
{
  "proposalId": "prop_01H...",
  "type": "replace_asset",
  "targetObjectId": "obj_living_sofa_main",
  "candidateAssetId": "SOFA_00812",
  "reason": "Closer match to approved reference style",
  "confidence": 0.91,
  "sourceEvidenceIds": [
    "ref_living_01",
    "instruction_004"
  ]
}
```

The proposal is not executed until validation succeeds.

---

## 9. SceneChangeSet

Every accepted revision is converted into a deterministic `SceneChangeSet`.

```ts
interface SceneChangeSet {
  id: string;
  projectId: string;
  baseSceneVersion: string;
  operations: SceneOperation[];
  affectedObjectIds: string[];
  affectedCameraIds: string[];
  riskLevel: RiskLevel;
  validationResults: ValidationResult[];
}
```

Possible operations:

```text
CreateObject
DeleteObject
ReplaceAsset
MoveObject
RotateObject
UpdateMaterial
UpdateLight
UpdateCamera
UpdateArchitecture
```

No arbitrary script text is accepted as a scene change.

---

## 10. Evidence Authority

AI must reason over evidence, but authority is deterministic.

Initial priority:

```text
Approved User Decision
    >
Verified Explicit Dimension
    >
Validated CAD / BIM Geometry
    >
Validated Elevation / Section Dimension
    >
Validated Vector Drawing Inference
    >
Reference Image Design Intent
    >
AI Visual Inference
    >
Default Assumption
```

This hierarchy is contextual. A reference image can be authoritative for approved style but not for a wall dimension when CAD provides that dimension.

Every important inferred value should carry:

```text
value
unit
sourceEvidenceIds
confidence
inferenceMethod
approvalState
```

---

## 11. Conflict Resolution

When evidence conflicts, the system must not silently choose.

Example:

```text
Plan wall length:      5200 mm
Manual instruction:   5000 mm
Elevation annotation: 5200 mm
```

The conflict resolver should:

1. classify each source
2. apply authority rules
3. detect whether values exceed tolerance
4. select only if policy allows
5. otherwise create an explicit unresolved conflict

```json
{
  "status": "conflict",
  "property": "wall.length",
  "candidates": [5000, 5200],
  "recommendedValue": 5200,
  "requiresApproval": true
}
```

---

## 12. Risk Levels

Not all AI proposals need the same approval policy.

### `R0` — Observational

No scene mutation.

Examples:

- style classification
- render critique
- material category suggestion

Can execute automatically.

### `R1` — Reversible Visual Change

Examples:

- decor replacement
- material candidate swap
- camera candidate generation

May auto-apply to preview branches after validation.

### `R2` — Spatial / Production Change

Examples:

- moving furniture
- replacing large furniture
- changing lighting layout
- changing camera used for final delivery

Requires stronger spatial validation and may require approval depending on project settings.

### `R3` — Architectural / Approved Geometry Change

Examples:

- wall modification
- door/window position
- ceiling height
- room boundary
- structural element

Never auto-commit from AI alone.

Requires authoritative evidence or explicit user approval.

---

## 13. Protected and Locked Fields

Approved scene properties can be locked.

```json
{
  "objectId": "wall_living_north",
  "locks": {
    "geometry": true,
    "transform": true,
    "material": false
  }
}
```

AI proposals that attempt to modify locked properties are rejected before execution.

---

## 14. Dry Run Before Execution

Every mutating `SceneChangeSet` should support a dry run.

Dry run returns:

```text
Objects to create
Objects to remove
Objects to move
Materials to change
Potential collisions
Missing assets
Broken references
Affected cameras
Affected renders
Estimated rebuild scope
```

This allows the platform to catch mistakes before opening or changing the production scene.

---

## 15. Deterministic Scene Executor

The AI model does not write MAXScript or Python that is immediately executed.

The executor receives validated operations and maps them to trusted internal commands.

Example:

```text
AI Proposal
    ↓
SceneChangeSet
    ↓
ReplaceAssetOperation
    ↓
Trusted Scene Compiler
    ↓
Known 3ds Max Command Implementation
```

Never:

```text
AI generates arbitrary script
    ↓
Execute directly in 3ds Max
```

This is a major safety and reliability boundary.

---

## 16. Tool Permissions

AI tools should be allow-listed and task-scoped.

Example permission model:

```json
{
  "task": "asset_ranking",
  "allowedTools": [
    "search_assets",
    "read_asset_metadata",
    "check_room_fit"
  ],
  "forbiddenTools": [
    "delete_scene_object",
    "modify_architecture",
    "render_final"
  ]
}
```

The model only sees tools required for the current task.

---

## 17. Validation Pipeline

A production proposal may pass through multiple validators.

```text
JSON Schema Validator
        ↓
Semantic Validator
        ↓
Evidence Validator
        ↓
Unit Validator
        ↓
Geometry Validator
        ↓
Constraint Validator
        ↓
Asset Availability Validator
        ↓
Renderer Compatibility Validator
        ↓
Approval / Lock Validator
```

Validation errors return structured failure codes instead of vague prose.

Example:

```json
{
  "code": "PLACEMENT_DOOR_SWING_COLLISION",
  "objectId": "obj_sofa_main",
  "severity": "error",
  "details": {
    "doorId": "door_entry_01"
  }
}
```

---

## 18. Retries Must Be Bounded

Do not create endless agent loops.

Retry policy should be explicit.

Example:

```text
Attempt 1: primary model
Attempt 2: same model with validator feedback
Attempt 3: fallback model
Then: unresolved / human review
```

Retry only when the error is recoverable.

Do not retry:

- hard evidence conflicts
- missing required dimensions
- locked property violations
- unavailable required asset with no allowed substitute

---

## 19. Provider Fallback

Provider outages or degraded quality must not block the architecture.

Example:

```text
Task Router
   ↓
Primary Qualified Model
   ↓ failure
Secondary Qualified Model
   ↓ failure
Deterministic Fallback / Manual Review
```

A fallback model must still pass the same output schema and validators.

---

## 20. Selective Multi-Model Verification

Using two models for every request wastes money and does not guarantee correctness.

Use multi-model verification only for high-value ambiguous tasks.

Possible cases:

- uncertain raster floor-plan extraction
- ambiguous elevation interpretation
- conflicting reference interpretation
- high-impact revision intent

Example:

```text
Model A Extraction
        +
Model B Extraction
        ↓
Deterministic Comparison
        ↓
Agreement → continue
Disagreement → conflict / targeted review
```

The platform compares structured facts, not prose opinions.

---

## 21. Confidence Is Not Authority

A model saying `confidence: 0.99` does not make a value correct.

Confidence is metadata only.

Acceptance depends on:

```text
Evidence Authority
+
Validation
+
Consistency
+
Project Policy
```

Confidence is useful for routing uncertain cases to review, not for bypassing validation.

---

## 22. Geometry Hallucination Prevention

AI must not invent architectural geometry just to complete a scene.

When geometry is missing, represent uncertainty explicitly.

Example:

```json
{
  "ceilingHeight": {
    "value": 3000,
    "status": "assumed",
    "source": "project_default",
    "requiresConfirmation": true
  }
}
```

If a missing value is safe to default for preview generation, use a documented project default.

If it affects production accuracy, block final approval until resolved.

---

## 23. Separate Design Freedom From Architectural Truth

The system should allow creativity where creativity is safe.

### Flexible

- decor selection
- furniture style candidates
- material variants
- lighting mood alternatives
- camera alternatives

### Controlled

- furniture placement
- custom joinery dimensions
- lighting positions
- ceiling design

### Protected

- wall boundaries
- door/window coordinates
- approved dimensions
- structural geometry
- locked client decisions

This lets AI contribute creatively without destabilizing production data.

---

## 24. Render Verification Loop

A successful 3ds Max command is not enough. The resulting scene can still be visually wrong.

Preview verification should combine deterministic checks and AI vision critique.

```text
Scene Built
   ↓
Preview Render
   ↓
Deterministic Checks
   +
Visual Critique
   ↓
Issue List
   ↓
Safe Auto-Fix / Proposal / Human Review
```

Deterministic checks may include:

- missing textures
- black materials
- invalid camera position
- clipping
- object collision
- objects outside room
- broken asset links
- renderer errors

AI visual critique may flag:

- poor composition
- visually implausible placement
- reference-style mismatch
- lighting imbalance
- obvious render artifacts

AI visual critique still cannot change protected architecture directly.

---

## 25. Scene Transactions and Rollback

Every mutating job should operate against a known scene version.

```text
Scene v12
  ↓
ChangeSet C105
  ↓
Validate
  ↓
Snapshot / transaction boundary
  ↓
Execute
  ↓
Verify
  ├── success → Scene v13
  └── failure → rollback to Scene v12
```

Do not leave partially mutated production scenes after failed jobs.

---

## 26. Idempotency

Re-running the same accepted change should not duplicate objects or corrupt the scene.

Every job and operation needs stable IDs.

```text
jobId
changeSetId
operationId
objectId
assetId
sceneVersion
```

The worker must be able to detect already-applied operations.

---

## 27. Prompt and Model Versioning

AI behavior must be reproducible enough to debug.

Store:

```text
taskType
provider
model
modelVersion when available
promptTemplateVersion
schemaVersion
inputHash
selected evidence IDs
responseHash
validator versions
execution result
```

Never rely on an unversioned hidden prompt as production business logic.

---

## 28. Observability

Every AI task should produce traceable telemetry.

Minimum fields:

```text
requestId
projectId
taskType
provider
model
latency
retryCount
fallbackUsed
schemaValid
semanticValid
confidence
riskLevel
approvalRequired
executionStatus
failureCode
```

This data will later drive provider selection and quality improvements.

---

## 29. Model Selection Score

Model routing should use measured performance.

Example conceptual score:

```text
TaskScore =
  QualityWeight      × Quality
+ ReliabilityWeight  × Reliability
+ LatencyWeight      × LatencyScore
+ CostWeight         × CostScore
```

Weights differ by task.

Example:

```text
Floor plan extraction:
quality and reliability dominate.

Render critique:
quality matters, latency may be secondary.

Interactive asset search:
latency matters more.
```

Do not select a model because of brand preference.

---

## 30. Golden Dataset

Before production, create an internal ArchViz evaluation dataset containing real examples.

Initial categories:

```text
10 clean DWG-derived plans
10 vector PDF plans
10 raster/scanned plans
10 plan + elevation projects
20 reference-image style sets
20 asset-selection tasks
20 furniture-placement scenarios
20 camera-ranking scenarios
20 render-critique scenarios
20 revision-intent scenarios
```

Each example should contain expected structured answers or measurable acceptance criteria.

Every candidate model/provider is evaluated against the same cases.

---

## 31. Regression Testing

When changing:

- model
- prompt
- schema
- validator
- placement rule
- CAD parser
- renderer adapter

run relevant golden tests.

A new model is not promoted because it is newer. It is promoted because it improves the measured task score without unacceptable regressions.

---

## 32. AI Feature Rollout

New AI capabilities should move through stages:

```text
Research
↓
Offline Evaluation
↓
Shadow Mode
↓
Preview-Only
↓
Human-Approved Production
↓
Controlled Auto-Apply
```

High-risk architectural changes may permanently remain human-approved.

---

## 33. Shadow Mode

Before allowing a new model to affect scenes, run it in shadow mode.

```text
Production Model → actual proposal
Candidate Model  → hidden comparison proposal
```

Compare:

- extraction accuracy
- validation failures
- disagreement rate
- latency
- cost

This makes provider upgrades safer.

---

## 34. Privacy and Local Project Data

Project drawings and client assets may be sensitive.

AI requests should send only the minimum required data for the task.

Prefer:

```text
Task-specific crop
Relevant PDF page
Relevant elevation
Selected reference images
Normalized structured geometry
```

Avoid uploading entire project folders when a small evidence subset is sufficient.

Provider data-handling requirements must be reviewed before production deployment.

Local-only processing paths should remain possible for sensitive or deterministic tasks.

---

## 35. What AI Must Never Be Allowed To Do Directly

```text
Execute arbitrary generated MAXScript
Execute arbitrary generated Python in production worker
Delete approved scene objects without a ChangeSet
Override verified CAD dimensions
Move locked architecture
Change a final scene without versioning
Silently resolve evidence conflicts
Invent missing dimensions and label them verified
Commit a high-risk change without required approval
Bypass domain validators because model confidence is high
```

---

## 36. Recommended MVP AI Roles

Do not start with a fully autonomous ArchViz agent.

Initial AI roles:

### Role 1 — Reference Analyzer

Input:

```text
Reference images
```

Output:

```text
style
palette
materials
furniture characteristics
lighting mood
confidence + evidence
```

### Role 2 — Drawing Assistant

Input:

```text
PDF / plan / elevation evidence
```

Output:

```text
structured observations
candidate dimensions
labels
relationships
confidence + provenance
```

Deterministic CAD extraction remains preferred where possible.

### Role 3 — Asset Ranker

AI ranks only candidates that already pass hard filters.

```text
Database Filter
→ Spatial Fit
→ Compatibility
→ AI Style Ranking
```

### Role 4 — Camera Critic

AI ranks rendered candidate views. It does not freely edit geometry.

### Role 5 — Render Critic

AI detects visual issues and creates structured improvement proposals.

### Role 6 — Revision Intent Parser

Natural language:

```text
"Main sofa थोड़ा छोटा कर दो और TV wall वही रहने दो."
```

becomes:

```text
Target: main sofa
Action: replace/resize candidate
Constraint: TV wall locked unchanged
```

The revision engine then validates the requested change.

---

## 37. Provider Strategy for Initial Experiments

The initial implementation should support at least two provider adapters so provider independence is real, not theoretical.

Suggested experiment set:

```text
Provider A: OpenAI
Provider B: Gemini
```

Then benchmark both on our own tasks.

Claude or other providers can be added when they improve a measured task or provide useful fallback capability.

This is an experiment strategy, not a permanent ranking.

---

## 38. Current API Capability Assumptions

As of the architecture draft date, major AI APIs expose capabilities useful for this platform, including multimodal inputs, structured output and/or function/tool calling.

These capabilities are **non-normative implementation assumptions** and must be reverified when code is written or models are upgraded.

Official references:

- OpenAI API documentation: `https://platform.openai.com/docs/`
- Google Gemini API documentation: `https://ai.google.dev/gemini-api/docs`
- Anthropic API documentation: `https://docs.anthropic.com/`
- xAI API documentation: `https://docs.x.ai/`

The platform contract must not depend on undocumented provider behavior.

---

## 39. Minimum Reliability Gate Before Production

An AI task may enter production only when:

```text
Schema defined
Golden tests exist
Primary + fallback behavior defined
Validation rules exist
Failure codes exist
Risk level assigned
Telemetry exists
Prompt/model versions are recorded
Unsafe direct execution is impossible
Rollback path exists for mutating tasks
```

---

## 40. Final Architecture Principle

The long-term competitive advantage is not access to an AI API.

It is the controlled system around AI:

```text
Evidence
+
SceneSpec
+
Typed Proposals
+
Domain Validators
+
Spatial Constraints
+
Asset Intelligence
+
Revision Engine
+
Deterministic 3D Automation
+
Evals
+
Production Data
```

AI models will improve and change. The platform should benefit from those improvements without becoming dependent on their randomness.
