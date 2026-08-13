# ADR-0004: AI Proposes, Platform Validates, Deterministic Engines Execute

- **Status:** Accepted
- **Date:** 2026-08-13
- **Decision Type:** AI / Production Reliability Architecture

## Context

AI ArchViz Platform will use probabilistic AI models to understand drawings, references, design intent, natural-language revisions, asset intent, camera quality, and rendered output.

These models can be highly capable but their output is not equivalent to verified architectural data or deterministic program execution.

Even when an API supports structured JSON or tool/function calling, a syntactically valid response may still contain:

- incorrect dimensions
- unsupported assumptions
- impossible placements
- wrong object identity
- conflicting design decisions
- unsafe tool arguments
- changes that violate approved geometry

Professional ArchViz production requires revision safety, exact object identity, auditable changes, rollback, and predictable scene behavior.

## Decision

AI models will not directly own or mutate production scene truth.

The mandatory control flow is:

```text
Evidence / User Intent
        ↓
AI Analysis
        ↓
Typed Structured Proposal
        ↓
Schema Validation
        ↓
Domain + Evidence + Spatial Validation
        ↓
Risk / Approval Policy
        ↓
SceneChangeSet
        ↓
Deterministic Scene Compiler / Worker
        ↓
Verification
        ↓
Commit or Rollback
```

### AI is allowed to

- analyze visual references
- extract candidate observations from drawings
- classify style and materials
- interpret revision intent
- rank already-valid asset candidates
- propose layouts
- rank camera candidates
- critique preview renders
- suggest safe improvements

### AI is not allowed to directly

- overwrite verified dimensions
- execute arbitrary generated scripts in production
- mutate locked architecture
- delete approved objects
- silently resolve evidence conflicts
- commit architectural changes without required validation/approval
- bypass deterministic placement or collision rules

## Typed proposals

AI outputs must be normalized into task-specific proposal schemas such as:

```text
GeometryProposal
AssetSelectionProposal
PlacementProposal
MaterialProposal
LightingProposal
CameraProposal
RevisionProposal
```

Free-form prose is not a production scene mutation format.

## Scene mutations

Approved proposals are compiled into deterministic `SceneChangeSet` operations.

Examples:

```text
CreateObject
ReplaceAsset
MoveObject
UpdateMaterial
UpdateLight
UpdateCamera
UpdateArchitecture
```

Each change is versioned, validated, and traceable.

## Provider independence

The rule applies equally to every current or future AI provider.

Provider/model selection is handled by the AI Gateway and evaluation system. A more capable model does not receive more scene authority simply because its benchmark quality is higher.

## Consequences

### Positive

- greatly reduces random destructive scene changes
- supports safe provider switching
- creates auditable revisions
- enables rollback
- improves repeatability
- separates creativity from architectural authority
- allows automated testing of AI outputs
- keeps 3ds Max execution deterministic

### Costs

- more engineering than directly connecting an LLM to 3ds Max tools
- requires proposal schemas and validators
- requires scene versioning and change tracking
- requires an evaluation dataset
- some tasks may require explicit user approval

These costs are accepted because production reliability is a core product requirement.

## Related Documents

- `docs/architecture/PROJECT-PLAN.md`
- `docs/architecture/SCENE-SPEC-v0.1.md`
- `docs/architecture/INPUT-EVIDENCE-MODES.md`
- `docs/architecture/AI-ORCHESTRATION-RELIABILITY.md`
