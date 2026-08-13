# AI ArchViz Platform

AI-assisted architectural visualization platform for generating **editable real 3D scenes** from architectural inputs such as DWG, DXF, PDF floor plans, reference images, existing 3ds Max scenes, dimensions, and text instructions.

The project is intentionally **not** a direct reference-image-to-final-image generator. The production source of truth is the real 3D scene so that client revisions, camera changes, materials, furniture, lighting, and future animation remain controllable and repeatable.

## Core Goal

```text
Architectural Inputs
        +
Design References
        +
User Intent
        ↓
Scene Understanding
        ↓
SceneSpec
        ↓
Editable 3D Scene
        ↓
3ds Max
        ↓
Corona / V-Ray
        ↓
Photorealistic Still Render
```

## Initial MVP

The first milestone focuses on interior still-image production for:

- Living rooms
- Bedrooms

Initial inputs:

- DWG / DXF floor plan
- PDF floor plan
- Reference images
- Manual dimensions
- Text instructions
- Existing 3ds Max scene where available

Initial outputs:

- Editable `.max` scene
- Real geometry
- Real asset placement
- Renderer materials
- Lighting setup
- Multiple cameras
- Preview renders
- Final still render

## Core Principles

1. **Real 3D is the source of truth.** Generated images may assist ideation and analysis, but they are not the production scene.
2. **Revisions must be deterministic.** Replacing a sofa or changing a material should update the existing scene, not regenerate the whole design.
3. **AI providers are replaceable.** OpenAI, Gemini, Claude, xAI, or future models sit behind provider adapters.
4. **3D applications and renderers are adapters.** The project should not become permanently locked to a single AI model, renderer, or DCC application.
5. **SceneSpec is the software-independent contract.** AI reasoning, CAD extraction, assets, 3ds Max automation, and revision history communicate through structured scene data.
6. **Human-verifiable architectural data wins.** Explicit dimensions, CAD geometry, constraints, and project rules take priority over AI guesses.

## Planned Architecture

```text
DWG / PDF / Images / Existing Scene
               ↓
          Input Layer
               ↓
       Understanding Layer
               ↓
            SceneSpec
               ↓
 ┌─────────────┼─────────────┐
 │             │             │
Geometry     Assets       Materials
 │             │             │
 └─────────────┼─────────────┘
               ↓
        Placement Rules
               ↓
         3ds Max Bridge
               ↓
      Corona / V-Ray Adapter
               ↓
        Preview / Final Render
               ↓
        AI + Rule-Based QC
```

## Repository Direction

Planned monorepo structure:

```text
AI-ArchViz-Platform/
├── apps/
│   ├── web/
│   ├── api/
│   ├── worker/
│   └── max-plugin/
├── packages/
│   ├── scene-spec/
│   ├── worker-contracts/
│   ├── ai-gateway/
│   ├── cad-parser/
│   ├── asset-engine/
│   ├── placement-engine/
│   ├── material-engine/
│   ├── lighting-engine/
│   ├── camera-engine/
│   ├── render-engine/
│   └── shared/
├── tools/
│   ├── maxscripts/
│   ├── python/
│   └── converters/
├── docs/
│   ├── architecture/
│   ├── decisions/
│   ├── research/
│   ├── testing/
│   └── workflows/
├── examples/
└── tests/
```

## Development Order

The first engineering milestone is deliberately **not AI integration**.

```text
SceneSpec JSON
      ↓
Local Windows Worker
      ↓
3ds Max Automation
      ↓
Room Geometry
      ↓
Proxy Assets + Cameras
      ↓
Candidate Editable .max
      ↓
Fresh-Process Reopen
      ↓
Semantic Manifest Verification
      ↓
Verified Editable .max Scene
```

Corona preview follows this base verification spine; it is not required for
Technical Spike 1. Once deterministic 3D and later renderer stages work, AI can
be added safely for reference analysis, floor-plan understanding, asset
selection, scene planning, camera ranking, and render critique.

## Documentation

- [Project Plan](docs/architecture/PROJECT-PLAN.md)
- [ADR-0001: Real 3D as Production Source of Truth](docs/decisions/0001-real-3d-source-of-truth.md)
- [ADR-0002: SceneSpec as Canonical Scene Contract](docs/decisions/0002-scenespec-canonical-contract.md)

## Status

**Stage:** Contract closure complete / ready for deterministic technical spike

Current priorities:

1. Initialize only the minimal local worker/toolchain skeleton.
2. Validate and consume the existing SceneSpec/worker schemas and Golden fixture.
3. Prove controlled communication with 3ds Max.
4. Generate, save, fresh-reopen, and semantically verify the Golden scene.
5. Prove durable idempotent replay and forced-failure safety.
6. Prove one minimal deterministic revision.
7. Add CAD, assets/lookdev, and Corona preview in the documented sequence.
8. Add AI only after the deterministic 3D pipeline is reliable.

## License

License has not yet been selected.
