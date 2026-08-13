# ADR-0002: SceneSpec Is the Canonical Scene Contract

- **Status:** Accepted
- **Date:** 2026-08-13
- **Decision Type:** System Architecture

## Context

AI ArchViz Platform must connect multiple systems over time:

- CAD input
- PDF analysis
- reference-image understanding
- AI providers
- asset search
- spatial placement
- 3ds Max
- Corona
- V-Ray
- future DCC applications
- future realtime engines

If project logic exists only inside 3ds Max files or provider-specific prompts, the platform becomes difficult to test, migrate, version, and automate.

The platform therefore needs a software-independent structured contract that describes the scene before it is compiled into a specific DCC or renderer.

## Decision

Create and maintain a versioned canonical scene contract named:

```text
SceneSpec
```

`SceneSpec` is the structured representation shared by the platform's domain services.

Initial representation will use JSON-compatible data structures and a versioned schema.

Normative v0.1 root vocabulary:

```json
{
  "sceneSpecVersion": "0.1.0",
  "project": {
    "id": "project_living_001"
  },
  "scene": {
    "id": "scene_living_main",
    "revisionId": "rev_0001",
    "headRevisionId": "rev_0001"
  },
  "coordinateSystem": {},
  "sources": [],
  "levels": [],
  "spaces": [],
  "geometry": [],
  "openings": [],
  "assets": [],
  "materials": [],
  "materialAssignments": [],
  "lights": [],
  "cameras": [],
  "references": [],
  "constraints": [],
  "render": {},
  "revisions": [],
  "extensions": {}
}
```

The strict machine contract is
`packages/scene-spec/schema/scene-spec-v0.1.schema.json`; the abbreviated root
above is not a valid fixture by itself.

## Responsibilities

`SceneSpec` should eventually represent:

- project identity
- schema version
- coordinate system
- unit system
- spaces and room boundaries
- walls, floors, ceilings, openings, columns and fixed architecture
- production asset references
- stable object IDs
- transforms
- spatial constraints
- logical materials
- lights
- cameras
- renderer intent
- revision metadata
- source provenance
- confidence for inferred values

## What SceneSpec Must Not Become

`SceneSpec` should not contain uncontrolled application-specific scripting.

Avoid making core fields depend directly on:

- MAXScript expressions
- arbitrary Python code
- Corona-only class names
- V-Ray-only node names
- OpenAI-specific response objects
- Gemini-specific response objects
- Claude-specific response objects

Renderer and application-specific details belong in adapters or extension namespaces when unavoidable.

## Compiler / Adapter Model

The intended direction is:

```text
CAD / AI / User Input
         ↓
      SceneSpec
         ↓
 ┌───────┼────────┐
 │       │        │
3ds Max Blender  Future DCC
 │
 ├── Corona Adapter
 └── V-Ray Adapter
```

In the initial MVP, only the 3ds Max path needs to be implemented.

## Object Identity

Every important mutable scene object must have a stable logical ID independent of the DCC application's temporary internal handles.

Example:

```json
{
  "objectId": "obj_living_sofa_main",
  "assetId": "SOFA_000124"
}
```

This enables targeted revisions and project history.

## Provenance

Values should eventually record where they came from when it matters.

Example sources:

```text
cad_geometry
cad_dimension
user_input
pdf_vector
pdf_vision
reference_image
ai_inference
system_default
```

For architectural measurements, provenance participates in conflict resolution.

A directly validated dimension should outrank a visual estimate.

## Versioning

SceneSpec must be explicitly versioned.

Example:

```json
{
  "sceneSpecVersion": "0.1.0"
}
```

Breaking schema changes require migration logic or an explicit compatibility strategy.

The platform should never assume that old project JSON can be interpreted using the latest schema without validation.

## Validation

SceneSpec input must be schema-validated before it reaches a production 3D worker.

Validation should eventually cover:

- required fields
- supported units
- valid IDs
- transform shapes
- references to known objects/assets
- invalid duplicate IDs
- unsupported renderer requests
- impossible or missing dimensions where required

Semantic/spatial validation belongs in domain-specific validators in addition to schema validation.

## Consequences

### Positive

- AI providers remain replaceable
- DCC applications remain replaceable
- domain behavior can be unit-tested without launching 3ds Max
- scenes can be diffed and versioned
- revisions can target stable identities
- automation jobs become reproducible
- future USD integration becomes easier

### Negative

- schema design requires discipline
- adapters must translate the canonical model into DCC-specific concepts
- schema migrations will eventually be necessary
- not every renderer feature will map perfectly to a common model

These costs are accepted to avoid long-term vendor and file-format lock-in.

## Initial Implementation Requirements

Before broad AI integration, create:

1. `packages/scene-spec`
2. `SceneSpec v0.1` TypeScript types
3. runtime schema validation
4. one example living-room scene JSON
5. unit and coordinate-system rules
6. stable ID rules
7. a 3ds Max compiler/bridge capable of reading a minimal SceneSpec

## Revisit Conditions

The serialization format may evolve or gain an OpenUSD representation, but the architectural requirement for a canonical, versioned, application-independent scene contract remains unless a superior shared representation satisfies the same revision, validation, and portability requirements.
