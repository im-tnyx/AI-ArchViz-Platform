# AI ArchViz Platform Project Plan

**Version:** 0.1  
**Status:** Foundation  
**Primary Environment:** Windows + AutoCAD + 3ds Max + Corona / V-Ray

## 1. Vision

Build an AI-assisted ArchViz production system that converts architectural inputs into an **editable, revision-safe, real 3D scene** and then produces photorealistic still renders.

The system should understand project intent from drawings, references, dimensions, and instructions, but it must preserve deterministic 3D structure throughout the workflow.

The intended long-term flow is:

```text
Architectural Input
        +
Design References
        +
User Intent
        ↓
AI + Rule-Based Understanding
        ↓
SceneSpec
        ↓
Real Geometry + Real Assets
        ↓
Materials + Lighting + Cameras
        ↓
3ds Max
        ↓
Corona / V-Ray
        ↓
Final Still / Future Animation / Realtime
```

## 2. Product Boundary

This project is **not** primarily an AI image generator.

Reference images can guide:

- style
- palette
- furniture direction
- materials
- lighting mood
- composition
- joinery language
- decor direction

However, the production deliverable remains the actual 3D scene.

This prevents the common direct-generation problems:

- inconsistent second views
- geometry drift during revision
- loss of exact dimensions
- furniture changing unintentionally
- non-repeatable camera angles
- unreliable material specifications
- difficulty moving from still image to animation

## 3. Source of Truth

The project has two levels of truth:

### 3.1 Architectural truth

Highest priority inputs are:

1. explicit project dimensions
2. CAD geometry
3. validated room boundaries
4. architectural rules and constraints
5. approved asset dimensions
6. user-approved design decisions

AI inference must never silently override these.

### 3.2 Scene truth

The canonical scene representation is `SceneSpec` plus associated 3D asset references.

The `.max` scene is an execution target and editable production artifact, but business logic should not exist only inside a `.max` file.

## 4. Initial Inputs

Phase 1 should support:

- DWG
- DXF
- vector PDF floor plans
- raster/scanned PDF floor plans
- reference images
- manual room dimensions
- text instructions
- existing 3ds Max scenes where useful

Future input support may include:

- Revit
- IFC
- SketchUp
- FBX
- OBJ
- OpenUSD
- point clouds
- 360 images
- phone scans
- LiDAR

## 5. Initial Outputs

The first production output package should be able to contain:

```text
project.max
scene-spec.json
preview-01.jpg
preview-02.jpg
preview-03.jpg
final-01.jpg
assets.json
materials.json
textures/
```

Later, the same project may export `USD`, `FBX`, renderer packages, animation scenes, or realtime formats.

## 6. MVP Scope

The MVP should solve a narrow production problem well.

### Included

- interior still images
- living room
- bedroom
- one project at a time
- one validated floor plan
- reference-driven design intent
- editable 3ds Max scene
- Corona first
- real asset placement
- basic material automation
- basic lighting automation
- three useful cameras
- preview renders
- revision-safe scene changes

### Excluded initially

- complete multi-storey buildings
- exterior automation
- walkthrough animation
- Unreal Engine pipeline
- Revit automation
- automatic generation of every custom furniture model
- cloud render farm
- mobile application
- full Photoshop automation

These are future phases, not abandoned goals.

## 7. SceneSpec

`SceneSpec` is the central software-independent contract.

Example:

```json
{
  "version": "0.1",
  "project": {
    "id": "project_living_001",
    "name": "Living Room 001",
    "units": "mm"
  },
  "spaces": [
    {
      "id": "space_living",
      "type": "living_room",
      "height": 3000
    }
  ],
  "objects": [],
  "materials": [],
  "lights": [],
  "cameras": [],
  "render": {
    "engine": "corona",
    "quality": "preview"
  }
}
```

`SceneSpec` should eventually describe:

- project metadata
- coordinate system
- units
- spaces
- walls
- floors
- ceilings
- openings
- fixed architecture
- assets
- transforms
- constraints
- materials
- lights
- cameras
- render settings
- revision metadata
- provenance of detected values
- confidence where AI inference is involved

## 8. CAD Processing

AutoCAD and CAD parsing are used for architectural extraction rather than visualization.

Desired extraction:

```text
Layers
Polylines
Walls
Doors
Windows
Columns
Beams
Room Boundaries
Dimensions
Text Labels
Blocks
Units
Coordinates
```

Target flow:

```text
DWG / DXF
    ↓
CAD Extraction
    ↓
Normalized Geometry
    ↓
Validation
    ↓
SceneSpec
```

The parser should preserve provenance. For example, a wall dimension obtained directly from a CAD dimension entity is stronger evidence than a value estimated from an image.

## 9. PDF Processing

Two PDF paths are required.

### Vector PDF

Preferred because geometry and text may be extracted more reliably.

Potential data:

- linework
- text
- dimensions
- room labels
- scale
- boundaries

### Raster / scanned PDF

Requires computer vision and AI assistance.

```text
PDF Page
   ↓
Image Analysis
   ↓
Detected Geometry / Text / Dimensions
   ↓
Scale Reconstruction
   ↓
Rule Validation
   ↓
Human Confirmation Where Ambiguous
```

AI guesses must carry confidence and provenance and should not silently become final architectural dimensions.

## 10. Reference Analysis

Reference images provide design intent, not geometry truth.

The reference analysis module may extract:

- style
- color palette
- material categories
- furniture categories
- furniture characteristics
- ceiling language
- wall treatments
- flooring
- lighting type
- approximate color temperature
- decor density
- visual mood

Example result:

```json
{
  "style": ["modern", "luxury"],
  "palette": ["warm_beige", "walnut", "brass"],
  "materials": ["travertine", "wood_veneer", "boucle"],
  "lighting": {
    "mood": "warm",
    "estimatedKelvin": 3000
  }
}
```

## 11. Asset Library

The production pipeline should prefer real, curated assets rather than generate every object from scratch.

Initial categories:

- sofas
- chairs
- beds
- tables
- TV units
- wardrobes
- lights
- curtains
- decor
- plants
- doors
- windows
- bathroom assets
- kitchen assets
- materials

Each asset should eventually have metadata such as:

```json
{
  "id": "SOFA_000124",
  "category": "sofa",
  "dimensions": {
    "width": 3200,
    "depth": 1050,
    "height": 780,
    "unit": "mm"
  },
  "styles": ["modern", "luxury"],
  "materials": ["fabric", "boucle"],
  "source": "internal",
  "rendererCompatibility": ["corona", "vray"]
}
```

## 12. Asset Search

Asset search should combine:

```text
User / AI Intent
      ↓
Category Filter
      ↓
Semantic Search
      ↓
Dimension Filter
      ↓
Style Filter
      ↓
Renderer Compatibility
      ↓
Room Fit Check
      ↓
Candidate Ranking
```

A language model can assist search intent, but final candidates must satisfy deterministic constraints.

## 13. Placement Engine

Furniture placement cannot depend on unconstrained LLM coordinates.

The engine combines:

```text
AI Planning
+
Architectural Rules
+
Spatial Constraints
+
Collision Detection
```

Example sofa constraints:

- remain inside room polygon
- avoid wall intersections
- do not block door swing
- maintain circulation clearance
- orient toward focal point when applicable
- maintain usable relationship with tables and seating

Example bed constraints:

- headboard against a valid wall
- preserve side clearance
- avoid door conflict
- avoid wardrobe circulation conflict
- respect windows where required

## 14. Object Identity

Every important scene object receives a permanent logical ID.

```json
{
  "objectId": "obj_living_sofa_main",
  "assetId": "SOFA_000124",
  "transform": {
    "position": [3200, 3800, 0],
    "rotation": [0, 0, 180],
    "scale": [1, 1, 1]
  }
}
```

This makes revisions targetable and auditable.

## 15. Revision Engine

Revision safety is a core product requirement.

Example request:

```text
Replace the main living room sofa.
```

Expected flow:

```text
Resolve Project
      ↓
Resolve Object ID
      ↓
Find Replacement Candidates
      ↓
Select Asset
      ↓
Validate Dimensions
      ↓
Validate Placement / Collision
      ↓
Update Existing Scene
      ↓
Re-render Affected Views
```

The full project should not be regenerated when a local revision is sufficient.

## 16. 3ds Max Integration

3ds Max is the initial production DCC.

Responsibilities:

- geometry creation
- loading production assets
- transforms
- materials
- lighting
- cameras
- renderer setup
- scene saving
- preview rendering
- final rendering

Possible automation layers:

- MAXScript
- Python
- `pymxs`
- .NET
- C++ SDK when justified

The first integration should use the simplest reliable interface and only move to lower-level SDK work when required.

## 17. Renderer Strategy

Renderer integration should use adapters.

Conceptual interface:

```ts
interface RenderEngine {
  setupScene(): Promise<void>;
  createMaterial(input: MaterialSpec): Promise<void>;
  createLight(input: LightSpec): Promise<void>;
  renderPreview(input: RenderRequest): Promise<RenderResult>;
  renderFinal(input: RenderRequest): Promise<RenderResult>;
}
```

Initial adapters:

```text
CoronaAdapter
VRayAdapter
```

Corona should be implemented first for the MVP, while the architecture remains renderer-neutral.

## 18. Material Engine

Material generation should be based on structured physical properties rather than arbitrary shader scripting.

A material may include:

```text
Base Color
Roughness
IOR
Metalness
Normal
Bump
Displacement
Opacity
Texture Scale
UV Strategy
```

The same logical material can later be compiled into:

- Corona Physical Material
- V-Ray Material
- USD material representation
- future renderer adapters

## 19. Lighting Engine

Lighting should use architectural and photographic rules.

Potential light sources:

- sun
- sky
- HDRI
- IES
- cove
- spotlight
- pendant
- floor lamp
- table lamp
- decorative lighting

Important structured values include:

- intensity
- units
- Kelvin
- direction
- IES profile
- exposure intent
- sun angle
- time-of-day intent

## 20. Camera Engine

Camera generation should optimize architectural composition rather than produce random angles.

Important values:

- position
- target
- camera height
- focal length
- vertical correction
- composition score
- visible room percentage
- focal subject
- collision safety

Possible flow:

```text
Generate Candidate Cameras
        ↓
Validate Geometry
        ↓
Low Resolution Preview
        ↓
AI + Rule-Based Critique
        ↓
Rank
        ↓
Select Best Cameras
        ↓
Final Render
```

## 21. AI Gateway

No business logic should depend directly on one AI vendor.

Conceptual interface:

```ts
interface AIProvider {
  analyzeFloorPlan(input: FloorPlanInput): Promise<FloorPlanAnalysis>;
  analyzeReference(input: ReferenceInput): Promise<ReferenceAnalysis>;
  generateScenePlan(input: ScenePlanningInput): Promise<ScenePlan>;
  critiqueRender(input: RenderCritiqueInput): Promise<RenderReview>;
}
```

Potential providers:

- OpenAI
- Gemini
- Claude
- xAI
- future providers

Provider output must be normalized before entering core domain logic.

## 22. AI Responsibilities

Good uses of AI:

- reference understanding
- style classification
- floor-plan assistance
- scene planning
- asset search intent
- material identification
- camera critique
- render critique
- anomaly detection
- natural-language revision interpretation

AI should not directly own:

- validated architectural dimensions
- unconstrained object transforms
- silent geometry changes
- final collision decisions
- revision identity
- renderer-specific business logic

## 23. Local Worker

The first production execution environment is the existing Windows workstation.

```text
Web / CLI / Future Desktop UI
           ↓
       Backend API
           ↓
        Job Queue
           ↓
   Local ArchViz Worker
           ↓
        3ds Max
           ↓
     Corona / V-Ray
```

Initial worker responsibilities:

- receive local job
- validate job payload
- read SceneSpec
- launch or communicate with 3ds Max
- build scene
- save scene
- render preview
- return job status and outputs

Cloud execution can be added after local reliability is proven.

## 24. Suggested Repository Structure

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
├── assets/
│   └── metadata/
├── docs/
│   ├── architecture/
│   ├── decisions/
│   ├── research/
│   ├── testing/
│   └── workflows/
├── examples/
└── tests/
```

## 25. Suggested Technology Direction

These are starting assumptions, not permanent commitments.

### Monorepo

- pnpm
- Turborepo

### Web

- Next.js
- React
- TypeScript
- Three.js where browser-side scene visualization becomes useful

### Backend

- TypeScript
- Node.js
- Fastify or NestJS after requirements are clearer

### 3D / CAD processing

- Python where ecosystem support is stronger
- .NET for AutoCAD integration when needed
- MAXScript / Python / `pymxs` for initial 3ds Max automation

### Data

- PostgreSQL
- Redis + BullMQ if distributed job execution becomes necessary

### Storage

- local filesystem during early development
- S3-compatible object storage later

Do not introduce infrastructure until a real requirement appears.

## 26. Development Phases

### Phase 0: Foundation

- repository initialization
- documentation
- architecture decisions
- SceneSpec v0.1
- local development conventions

### Phase 1: 3ds Max proof

Prove that external structured data can cause 3ds Max to:

- create a primitive
- create a wall
- create a camera
- save a `.max` scene
- execute a render

### Phase 2: SceneSpec to 3ds Max

```text
scene.json
   ↓
Worker
   ↓
3ds Max
   ↓
Generated Room
```

### Phase 3: CAD

```text
DWG / DXF
   ↓
Geometry Extraction
   ↓
SceneSpec
   ↓
3ds Max Geometry
```

### Phase 4: Asset engine

- asset metadata
- local search
- asset loading
- transforms
- collision validation

### Phase 5: Materials

- logical material schema
- Corona material compiler
- texture path management

### Phase 6: Lighting and cameras

- architectural lighting rules
- camera candidate generation
- preview rendering

### Phase 7: AI integration

- reference analysis
- scene planning
- asset ranking
- camera critique
- render critique

### Phase 8: Revision engine

- object replacement
- material changes
- lighting changes
- camera changes
- affected-view rerendering
- revision history

## 27. First Technical Milestone

The first milestone should be completely achievable without an external AI API.

```text
SceneSpec JSON
      ↓
Local Windows Worker
      ↓
3ds Max
      ↓
Generated Room
      ↓
Camera
      ↓
Basic Lighting
      ↓
Corona Preview
      ↓
Saved Editable .max Scene
```

This proves the production spine before introducing probabilistic AI behavior.

## 28. First Real Test Project

**Test:** `Living Room Test 001`

Inputs:

- one real floor plan
- known room dimensions
- known ceiling height
- 3-5 reference images
- a small curated asset set

Expected output:

- correct room envelope
- correct door and window positions
- one valid furniture layout
- basic materials
- basic lighting
- three useful cameras
- Corona preview renders
- editable `.max` file

## 29. Definition of MVP Success

The MVP is successful when it can reliably:

1. ingest a validated room definition
2. construct correct editable room geometry
3. place production assets without invalid collisions
4. assign renderer-ready materials
5. configure basic lighting
6. produce useful architectural cameras
7. generate Corona previews
8. save an editable `.max` scene
9. apply targeted revisions without rebuilding the complete design

## 30. Future Expansion

After the production core is stable:

- kitchen
- bathroom
- office
- commercial spaces
- exterior
- landscape
- multi-room apartment
- villa
- hotel
- restaurant
- retail
- animation
- walkthrough
- Unreal Engine
- realtime configurator
- VR
- cloud render farm
- collaboration
- client review portal

## 31. Immediate Next Work

1. Define `SceneSpec v0.1` in detail.
2. Document coordinate-system and units rules.
3. Document object identity and revision semantics.
4. Build the local Windows worker skeleton.
5. Create the smallest possible 3ds Max automation experiment.
6. Generate a room and camera from static JSON.
7. Save the first automatically generated `.max` scene.
8. Validate Corona preview rendering.
9. Add a real floor-plan test fixture.
10. Only then start provider-specific AI integrations.
