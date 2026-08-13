# ADR-0003: Flexible Input Evidence Modes

- **Status:** Accepted
- **Date:** 2026-08-13
- **Decision Type:** Product Architecture

## Context

Architectural visualization projects do not arrive with one consistent drawing package.

A project may begin with only a floor plan and visual references. Later, elevations, sections, revised drawings, or additional dimensions may become available.

If AI ArchViz Platform requires a complete plan + elevation + section package before scene generation, it becomes impractical for early design work. If it ignores stronger drawings when they become available, it becomes unreliable for production work.

Reference images are useful in both early and detailed workflows, but references communicate design intent rather than authoritative architectural dimensions.

## Decision

AI ArchViz Platform will support flexible evidence-driven input modes.

The first two supported modes are:

```text
Mode A
Plan + Reference Images
```

and:

```text
Mode B
Plan + Elevation(s) + Reference Images
```

Reference images are valid in both modes.

The platform will not require elevation drawings for every project.

When elevations are unavailable, vertical values may be supplied by:

1. explicit user input
2. approved project defaults
3. architectural rules
4. controlled inference

Any non-verified values must preserve provenance and verification status.

When elevations become available later, they must be added as stronger evidence to the existing project rather than forcing a complete project recreation.

## Authority by Evidence Type

Evidence authority is property-specific.

General responsibilities are:

```text
Plan
→ horizontal geometry

Elevation
→ vertical geometry and wall composition

Section
→ levels and vertical construction relationships

Reference Images
→ style, materials, furniture and visual direction

User-approved values
→ explicit project decisions
```

A reference image must not silently override verified drawing dimensions.

## Progressive Accuracy

The platform will support progressive accuracy.

Example:

```text
Stage 1
Plan + References
→ usable editable scene with documented assumptions

Stage 2
Plan + Elevations + References
→ existing scene upgraded with stronger vertical evidence

Stage 3
Plan + Elevations + Sections + References
→ additional construction accuracy
```

The same `SceneSpec` project identity remains active across these stages.

## Consequences

### Positive

- early-stage projects can begin before complete drawing packages exist
- references remain useful throughout the workflow
- production accuracy improves as stronger evidence arrives
- real-world drawing revisions map naturally to scene revisions
- the platform supports both design visualization and production visualization
- users do not need to recreate projects when elevations arrive later

### Costs

- SceneSpec must store provenance and verification state
- evidence reconciliation is required
- conflicting drawings need explicit resolution rules
- scene updates must detect which objects and renders are affected
- UI must surface important assumptions without overwhelming users

## Required Architecture

The following platform capabilities become mandatory:

- source registry
- input mode detection
- evidence provenance
- confidence / verification state
- plan-to-elevation registration
- conflict detection
- assumption tracking
- progressive project upgrades
- affected-object detection
- revision-safe scene synchronization

## Related Documents

- `docs/architecture/PROJECT-PLAN.md`
- `docs/architecture/SCENE-SPEC-v0.1.md`
- `docs/architecture/INPUT-EVIDENCE-MODES.md`
- `docs/decisions/0001-real-3d-source-of-truth.md`
- `docs/decisions/0002-scenespec-canonical-contract.md`
