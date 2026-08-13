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
Camera + Basic Lighting
      ↓
Corona Render
      ↓
Saved Editable .max Scene
```

Once this deterministic path works, AI can be added safely for reference analysis, floor-plan understanding, asset selection, scene planning, camera ranking, and render critique.

## Documentation

- [Project Plan](docs/architecture/PROJECT-PLAN.md)
- [ADR-0001: Real 3D as Production Source of Truth](docs/decisions/0001-real-3d-source-of-truth.md)
- [ADR-0002: SceneSpec as Canonical Scene Contract](docs/decisions/0002-scenespec-canonical-contract.md)

## Status

**Stage:** Foundation / documentation

Current priorities:

1. Finalize architecture documentation.
2. Define `SceneSpec v0.1`.
3. Define the Windows local worker contract.
4. Prove automated communication with 3ds Max.
5. Generate and save the first deterministic test room.
6. Add Corona preview rendering.
7. Integrate real CAD input.
8. Add AI only after the core 3D pipeline is reliable.

## License

License has not yet been selected.
