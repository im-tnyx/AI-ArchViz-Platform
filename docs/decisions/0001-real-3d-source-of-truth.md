# ADR-0001: Real 3D Is the Production Source of Truth

- **Status:** Accepted
- **Date:** 2026-08-13
- **Decision Type:** Product Architecture

## Context

Modern image-generation models can produce high-quality interior and exterior concepts from reference images, sketches, or text prompts. However, a professional ArchViz workflow must support repeated client revisions, multiple camera views, exact dimensions, material changes, lighting changes, asset replacement, and future animation.

A generated still image does not reliably preserve the underlying spatial model needed for those operations.

Typical problems with direct image-first production include:

- room geometry changing between revisions
- inconsistent secondary views
- furniture identity changing unexpectedly
- exact architectural dimensions being lost
- non-repeatable camera positions
- material changes affecting unrelated areas
- difficulty creating animation from an approved still
- no deterministic object-level revision model

## Decision

The production source of truth for AI ArchViz Platform is a **real editable 3D scene represented through structured scene data**, not a generated image.

AI-generated or AI-edited imagery may be used for:

- concept exploration
- design-reference understanding
- material/style analysis
- mood exploration
- preview ideation
- quality critique

It must not silently replace production geometry.

The normal production path is:

```text
Input
  ↓
Understanding
  ↓
Structured Scene Definition
  ↓
Real Geometry + Real Assets
  ↓
Materials + Lights + Cameras
  ↓
Renderer
  ↓
Final Image
```

## Consequences

### Positive

- revisions can target individual objects or materials
- multiple camera views remain spatially consistent
- architectural dimensions can remain authoritative
- approved assets retain identity
- scenes remain editable by artists
- animation and realtime outputs remain possible later
- renderer output can be reproduced
- project state can be versioned and audited

### Negative

- initial engineering complexity is higher than direct image generation
- asset management becomes necessary
- CAD/geometry validation is required
- 3ds Max automation must be reliable
- scene construction takes more compute and time than a single image API request

These costs are accepted because revision safety is a fundamental product requirement.

## Rules Derived From This Decision

1. A generated JPEG/PNG is never the canonical project state.
2. Explicit dimensions override visual estimation.
3. Approved CAD geometry cannot be silently modified by AI.
4. Revisions should mutate existing identified scene objects where possible.
5. AI post-processing must not introduce untracked architectural changes.
6. Every final production render should be traceable to a scene version.
7. Direct image generation remains an optional concept tool, not the production pipeline.

## Revisit Conditions

This decision may be revisited if future generative systems can produce fully editable, deterministic, dimensionally accurate 3D scenes with stable object identity and revision semantics equal to or better than the real-3D pipeline.
