# SceneSpec v0.1

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Role:** Canonical scene contract between architectural inputs, AI systems, deterministic geometry/placement engines, DCC applications, renderers, and revision workflows.

---

## 1. Purpose

`SceneSpec` is the software-independent, versioned representation of an architectural visualization project.

It exists so that the platform does not depend on a `.max` file, a particular AI model, a single renderer, or a single CAD/DCC application as the only source of project truth.

The intended pipeline is:

```text
DWG / DXF / PDF / Reference Images / User Instructions / Existing Scene
                              ↓
                        Input Processing
                              ↓
                     AI + Rule Understanding
                              ↓
                          SceneSpec
                              ↓
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
 Geometry Engine        Asset Engine         Material Engine
        ↓                     ↓                     ↓
 Placement Engine      Lighting Engine       Camera Engine
        └─────────────────────┼─────────────────────┘
                              ↓
                     DCC / Renderer Adapter
                              ↓
              3ds Max + Corona / V-Ray
                              ↓
                     Editable Real 3D Scene
                              ↓
                       Final Render(s)
```

`SceneSpec` is not intended to replace `.max`, USD, FBX, IFC, DWG, or renderer-native formats. It is the platform's semantic and orchestration contract that explains what a scene means and how the platform should rebuild, validate, revise, and render it.

---

## 2. Core Design Principles

### 2.1 Real 3D remains the production source of truth

The final approved project must exist as editable 3D geometry with stable object identities.

AI-generated images may be used for:

- design exploration
- style analysis
- material inspiration
- render critique
- variation proposals
- visual references

They must not silently replace approved architectural geometry.

### 2.2 Deterministic before generative

Whenever an input can be resolved deterministically, deterministic data wins.

Priority example:

```text
Verified CAD dimension
    >
Verified manual dimension
    >
Vector drawing inference
    >
AI visual inference
    >
Unverified assumption
```

AI is allowed to propose missing information, but uncertainty must remain visible in the data model.

### 2.3 Stable identity

Every meaningful scene entity must have a stable ID.

Example:

```text
space_living_main
wall_living_north
opening_living_window_01
asset_living_sofa_main
mat_wall_travertine_main
light_living_cove_01
camera_living_hero_01
```

A revision should modify an entity whenever possible instead of deleting and recreating unrelated scene content.

### 2.4 Renderer independence

Scene intent should not be encoded only as Corona or V-Ray properties.

A semantic material may describe:

```json
{
  "type": "stone",
  "subtype": "travertine",
  "roughness": 0.35,
  "physicalScaleMm": 1200
}
```

Renderer adapters may compile this into:

```text
CoronaPhysicalMtl
VRayMtl
FutureRendererMaterial
```

### 2.5 DCC independence

3ds Max is the initial production application, but the core schema must not assume that all scenes will always be built in 3ds Max.

Future adapters may target:

- OpenUSD
- Blender
- Unreal Engine
- Omniverse
- Revit
- other DCC/rendering systems

### 2.6 Revision safety

A valid `SceneSpec` must make it possible to answer:

```text
What changed?
Which object changed?
Why did it change?
What depends on it?
Which renders are now stale?
Can the previous state be restored?
```

### 2.7 Explicit uncertainty

The system must not convert guesses into facts.

Any inferred value may carry:

```json
{
  "confidence": 0.72,
  "source": "ai_inference",
  "requiresReview": true
}
```

---

## 3. SceneSpec Responsibilities

`SceneSpec` should describe:

- project metadata
- coordinate system
- units
- source inputs
- floors / levels
- spaces / rooms
- architectural geometry
- walls
- floors
- ceilings
- doors and windows
- structural elements
- assets and furniture
- transforms
- materials
- material assignments
- lighting
- cameras
- render intent
- design references
- semantic style information
- placement constraints
- relationships
- revisions
- provenance
- confidence
- validation state
- renderer overrides
- DCC mappings
- extension data

`SceneSpec` should **not** attempt to embed complete production mesh data for high-poly assets in JSON.

Heavy geometry should live in external files or scene packages and be referenced by URI, asset ID, content hash, or DCC-specific mapping.

---

## 4. Top-Level Structure

### 4.1 Normative status

The machine-readable schema at
`packages/scene-spec/schema/scene-spec-v0.1.schema.json` is the **normative
SceneSpec v0.1 contract**. This document defines the matching semantic rules.
JSON examples elsewhere in the repository are illustrative unless they
explicitly state that they conform to that schema. A parser must not accept an
alternate root vocabulary such as `version`, `walls`, `surfaces`, or `objects`.

Normative `v0.1` root vocabulary:

```json
{
  "sceneSpecVersion": "0.1.0",
  "project": {},
  "scene": {},
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

The first deterministic profile requires the fields marked as required by the
schema. Optional root fields are omitted when they have no semantic content;
empty arrays are not placeholders for a second contract.

### 4.2 Required cross-field validation

JSON Schema validation runs first. The deterministic profile then performs
these mandatory semantic checks before any DCC launch:

| Check | Deterministic error |
|---|---|
| `scene.revisionId == scene.headRevisionId` for a committed snapshot | `REVISION_STATE_MISMATCH` |
| Logical IDs are unique across geometry, openings, assets, lights, and cameras | `DUPLICATE_LOGICAL_ID` |
| Every referenced project/scene/level/space/host/material ID exists | `UNRESOLVED_REFERENCE` |
| Space polygon is counter-clockwise and wall directions follow its edges | `WALL_BOUNDARY_DIRECTION_MISMATCH` |
| Opening interval satisfies `0 <= offset` and `offset + width <= host length` | `OPENING_OUT_OF_HOST_RANGE` |
| Wall/surface/opening derived Transform equalities hold | `DERIVED_TRANSFORM_MISMATCH` |
| Negative scale is absent and non-uniform scale is explicitly supported | `NON_UNIFORM_SCALE_UNSUPPORTED` |
| Target-based camera Euler values match the normative look-at formula | `CAMERA_ORIENTATION_MISMATCH` |

These checks are part of the v0.1 contract even where JSON Schema cannot
express reference equality or vector math.

The same project may move through states such as:

```text
Imported
→ Parsed
→ Interpreted
→ Geometry Ready
→ Furnished
→ Lookdev Ready
→ Lighting Ready
→ Camera Ready
→ Preview Ready
→ Approved
→ Final Rendered
```

---

## 5. Versioning

`SceneSpec` uses semantic-style schema versions:

```text
MAJOR.MINOR.PATCH
```

Example:

```text
0.1.0
0.2.0
1.0.0
```

Guidelines:

- `PATCH`: clarification or backward-compatible schema correction
- `MINOR`: backward-compatible feature addition
- `MAJOR`: breaking structural change

**Spike 6A version decision:** canonical Golden fixtures use `0.2.0` because
`assetDefinitions` is a required root collection and intrinsic proxy properties
move from instances to immutable definitions. `0.1.0` remains readable for
historical compatibility; all active deterministic fixtures use `0.2.0`.

Every canonical document must declare its applicable schema version. The active
deterministic fixture set uses:

```json
{
  "sceneSpecVersion": "0.2.0"
}
```

Parsers must reject unsupported major versions unless an explicit migration path exists.

---

## 6. Project Metadata

Example:

```json
{
  "project": {
    "id": "project_villa_001",
    "name": "Villa Living Room",
    "type": "interior",
    "status": "design",
    "createdAt": "2026-08-13T06:30:00Z",
    "updatedAt": "2026-08-13T06:30:00Z",
    "defaultRenderer": "corona",
    "tags": ["residential", "living-room", "modern-luxury"]
  }
}
```

Possible future project types:

```text
interior
exterior
landscape
retail
hospitality
commercial
product
mixed
```

### 6.1 Scene and revision identity

Canonical SceneSpec state owns these values:

```json
{
  "project": {
    "id": "project_golden_living_001"
  },
  "scene": {
    "id": "scene_golden_living_001",
    "revisionId": "rev_golden_0001",
    "headRevisionId": "rev_golden_0001"
  }
}
```

- `project.id` is immutable for the project workspace.
- `scene.id` is immutable for one scene/design branch and survives rebuilds.
- `scene.revisionId` identifies the exact state serialized by this snapshot.
- `scene.headRevisionId` identifies the current committed head when the
  snapshot was written.
- A normal committed snapshot requires
  `scene.revisionId == scene.headRevisionId`.
- Transition/request identifiers such as `baseRevisionId` and
  `requestedRevisionId` do not belong at the SceneSpec root; they belong to a
  SceneChangeSet or worker Job Envelope.

---

## 7. Coordinate System and Units

This decision must be explicit from the beginning because CAD, 3ds Max, USD, imported assets, and AI-derived measurements may use different conventions.

Initial canonical convention:

```text
Linear unit: millimeter
Angle unit: degree
World up axis: Z
Right-handed semantic coordinate system
Origin: project-defined
```

Example:

```json
{
  "coordinateSystem": {
    "linearUnit": "mm",
    "angularUnit": "degree",
    "upAxis": "Z",
    "handedness": "right",
    "originPolicy": "project_origin",
    "worldOrigin": [0, 0, 0]
  }
}
```

Adapters are responsible for converting canonical coordinates to application-native coordinates when necessary.

### 7.1 Transform convention

```json
{
  "transform": {
    "position": [3200, 1750, 0],
    "rotationEuler": [0, 0, 90],
    "scale": [1, 1, 1]
  }
}
```

For `v0.1`, Euler rotation is sufficient for authoring and debugging.

This `Transform` shape is normative everywhere, including SceneChangeSet:

- `position`: parent-local millimeters.
- `rotationEuler`: parent-local degrees in `[x, y, z]` order.
- `scale`: unitless positive values; default `[1, 1, 1]`.
- Root-level objects have no transformed parent, so their parent-local values
  are world-equivalent.
- In the v0.1 schema, `spaceId` and `levelId` are semantic membership/host
  references, not transform parents. Spaces, walls, surfaces, assets, and
  cameras therefore store world-equivalent local transforms. Only openings
  store host-wall-local transforms: `[offset, 0, sill]` relative to directed
  host axes. Arbitrary transform parenting is outside v0.1.
- Euler composition uses column vectors and
  `M = T * Rz(z) * Ry(y) * Rx(x) * S`; local X rotation is applied first,
  followed by local Y, then local Z.
- Positive rotations follow the right-hand rule. With asset forward `+Y`, a
  positive `90` degree Z rotation faces `-X`.
- Negative scale is invalid. Non-uniform scale is valid only when the owning
  object explicitly sets `allowNonUniformScale: true`; otherwise semantic
  validation rejects it.
- Missing transforms are not inferred in the deterministic profile. The
  explicit identity transform is `position=[0,0,0]`,
  `rotationEuler=[0,0,0]`, `scale=[1,1,1]`.

A later version may add quaternions and matrices for interchange-heavy workflows.

### 7.2 Asset pivot convention

Assets should define semantic pivots where possible:

```text
floor_center
back_center_floor
bounding_box_center
custom
```

Example:

```json
{
  "pivotPolicy": "back_center_floor"
}
```

This is important for furniture placement against walls.

---

## 8. Source Inputs and Provenance

Every important source should be recorded.

Example:

```json
{
  "sources": [
    {
      "id": "source_floorplan_dwg_01",
      "type": "dwg",
      "uri": "project://inputs/ground-floor.dwg",
      "contentHash": "sha256:...",
      "role": "architectural_geometry",
      "verified": true
    },
    {
      "id": "source_reference_01",
      "type": "image",
      "uri": "project://references/living-room-01.jpg",
      "role": "design_reference",
      "verified": true
    }
  ]
}
```

Supported source types may include:

```text
dwg
dxf
pdf
image
max
fbx
obj
usd
ifc
revit
sketchup
manual
api
scan
lidar
```

### 8.1 Provenance block

Any generated or interpreted entity may store provenance:

```json
{
  "provenance": {
    "sourceIds": ["source_floorplan_dwg_01"],
    "method": "cad_parser",
    "confidence": 0.99,
    "requiresReview": false
  }
}
```

Possible methods:

```text
cad_parser
vector_pdf_parser
manual_input
ai_inference
rule_engine
constraint_solver
asset_metadata
human_approved
imported_scene
```

---

## 9. Levels

Buildings may contain one or many levels.

Example:

```json
{
  "levels": [
    {
      "id": "level_ground",
      "name": "Ground Floor",
      "elevation": 0,
      "defaultCeilingHeight": 3000
    }
  ]
}
```

Future projects may contain:

```text
Basement
Ground
First Floor
Second Floor
Roof
Site
```

---

## 10. Spaces / Rooms

A `space` is a semantic architectural area.

Example:

```json
{
  "spaces": [
    {
      "id": "space_living_main",
      "levelId": "level_ground",
      "name": "Main Living Room",
      "type": "living_room",
      "boundary": [
        [0, 0],
        [7200, 0],
        [7200, 5800],
        [0, 5800]
      ],
      "floorElevation": 0,
      "ceilingHeight": 3000,
      "style": {
        "primary": "modern_luxury",
        "secondary": ["warm_minimal"]
      }
    }
  ]
}
```

Possible room types:

```text
living_room
bedroom
kitchen
bathroom
dining_room
foyer
corridor
office
wardrobe
utility
balcony
terrace
lobby
restaurant
retail
custom
```

A space may later support multiple polygons, holes, sloped ceilings, and complex topology.

---

## 11. Architectural Geometry

Architectural geometry should remain semantically typed instead of being reduced immediately to anonymous meshes.

Common types:

```text
wall
floor
ceiling
column
beam
stair
slab
partition
bulkhead
custom_architecture
```

### 11.1 Wall example

```json
{
  "id": "wall_living_north",
  "type": "wall",
  "levelId": "level_ground",
  "spaceIds": ["space_living_main"],
  "path": [
    [0, 5800, 0],
    [7200, 5800, 0]
  ],
  "thickness": 150,
  "height": 3000,
  "alignment": "center",
  "materialRole": "wall_finish_main",
  "provenance": {
    "sourceIds": ["source_floorplan_dwg_01"],
    "method": "cad_parser",
    "confidence": 0.99,
    "requiresReview": false
  }
}
```

### 11.2 Floor example

```json
{
  "id": "floor_living_main",
  "type": "floor",
  "spaceIds": ["space_living_main"],
  "boundary": [
    [0, 0, 0],
    [7200, 0, 0],
    [7200, 5800, 0],
    [0, 5800, 0]
  ],
  "thickness": 100,
  "materialRole": "floor_finish_main"
}
```

### 11.3 Ceiling example

```json
{
  "id": "ceiling_living_main",
  "type": "ceiling",
  "spaceIds": ["space_living_main"],
  "elevation": 3000,
  "boundary": [
    [0, 0],
    [7200, 0],
    [7200, 5800],
    [0, 5800]
  ],
  "materialRole": "ceiling_finish_main"
}
```

---

## 12. Openings

Doors and windows should be first-class entities, not just boolean holes.

Example door:

```json
{
  "id": "opening_living_door_01",
  "type": "door",
  "hostId": "wall_living_west",
  "width": 1000,
  "height": 2400,
  "sillHeight": 0,
  "offsetAlongHost": 850,
  "operation": "hinged_single",
  "swing": "inward_left",
  "assetId": "asset_door_standard_01"
}
```

Example window:

```json
{
  "id": "opening_living_window_01",
  "type": "window",
  "hostId": "wall_living_north",
  "width": 3200,
  "height": 2400,
  "sillHeight": 300,
  "offsetAlongHost": 1900,
  "assetId": "asset_window_slim_01"
}
```

This enables later reasoning about:

- daylight
- visibility
- furniture conflicts
- door swing clearance
- curtain placement
- camera composition
- facade consistency

---

## 13. Assets

An `asset` represents a reusable scene object or asset instance.

Examples:

```text
sofa
chair
table
bed
wardrobe
lamp
plant
artwork
decor
sanitary fixture
kitchen appliance
curtain
rug
custom furniture
```

Example:

```json
{
  "id": "asset_living_sofa_main",
  "type": "asset_instance",
  "category": "sofa",
  "libraryAssetId": "SOFA_000124",
  "spaceId": "space_living_main",
  "transform": {
    "position": [3600, 3900, 0],
    "rotationEuler": [0, 0, 180],
    "scale": [1, 1, 1]
  },
  "dimensions": {
    "width": 3200,
    "depth": 1050,
    "height": 780
  },
  "locked": false,
  "revisionPolicy": "preserve_identity"
}
```

### 13.1 Canonical proxy asset identity (SceneSpec 0.2)

`assetDefinitions` owns immutable intrinsic proxy data. An `asset` is a stable
logical scene object that references its definition with `assetDefinitionId`.
The two IDs must never be conflated, and a definition that changes category,
dimensions, pivot, or source semantics receives a new identity/version.

```json
{
  "assetDefinitions": [
    {
      "id": "assetdef_sofa_proxy_standard_v1",
      "version": "1",
      "category": "sofa",
      "sourceType": "procedural_proxy",
      "dimensions": [2400, 950, 780],
      "pivotPolicy": "floor_center",
      "allowNonUniformScale": false
    }
  ],
  "assets": [
    {
      "id": "asset_living_sofa_main",
      "type": "proxy_asset",
      "assetDefinitionId": "assetdef_sofa_proxy_standard_v1",
      "spaceId": "space_living_main"
    }
  ]
}
```

Definitions are pure procedural data in this spike: no file paths, URLs,
renderer dependencies, scripts, or executable content are permitted. Category,
dimensions, pivotPolicy, and allowNonUniformScale are definition-owned fields;
instances own only placement/context and locks.

Future `ReplaceAsset` semantics are frozen but not implemented: it preserves
the logical object ID and canonical transform under `preserve_anchor`, requires
exact category and pivotPolicy equality, revalidates scale and spatial fit, and
keeps material assignment separate. No `ReplaceAsset` SceneChangeSet operation
or material-default policy is part of the machine contract yet.

---

## 14. Object Locks and Approval State

Approved objects must be protectable from later AI-driven modification.

Example:

```json
{
  "locks": {
    "geometry": true,
    "transform": true,
    "material": false,
    "visibility": false
  }
}
```

Possible approval states:

```text
proposed
selected
approved
locked
rejected
superseded
```

This is essential for client revisions.

Example:

> Keep the approved sofa position. Change only the wall finish and lighting.

The platform should be able to enforce that request structurally.

---

## 15. Materials

Materials should contain semantic and physical properties.

Example:

```json
{
  "materials": [
    {
      "id": "mat_wall_travertine_main",
      "name": "Warm Travertine",
      "category": "stone",
      "subtype": "travertine",
      "physical": {
        "roughness": 0.38,
        "ior": 1.52,
        "metalness": 0
      },
      "maps": {
        "baseColor": "asset://materials/travertine_01/basecolor.jpg",
        "roughness": "asset://materials/travertine_01/roughness.jpg",
        "normal": "asset://materials/travertine_01/normal.jpg",
        "displacement": "asset://materials/travertine_01/displacement.jpg"
      },
      "physicalScaleMm": 1200,
      "rendererOverrides": {}
    }
  ]
}
```

### 15.1 Material assignments

Assignment is separate from material definition.

```json
{
  "materialAssignments": [
    {
      "id": "assign_wall_north_travertine",
      "targetId": "wall_living_north",
      "materialId": "mat_wall_travertine_main",
      "slot": "surface"
    }
  ]
}
```

This separation enables a single material to be reused across multiple objects.

---

## 16. Lighting

Lights should contain real-world or renderer-independent intent wherever possible.

Example:

```json
{
  "lights": [
    {
      "id": "light_living_pendant_01",
      "type": "area",
      "spaceId": "space_living_main",
      "transform": {
        "position": [3600, 2900, 2600],
        "rotationEuler": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "intensity": {
        "value": 1800,
        "unit": "lumen"
      },
      "colorTemperatureK": 3000,
      "shape": "disc",
      "enabled": true,
      "rendererOverrides": {}
    }
  ]
}
```

Lighting types may include:

```text
sun
sky
area
point
spot
ies
mesh
cove
emissive
environment
```

---

## 17. Cameras

Cameras are first-class revision-safe entities.

Example:

```json
{
  "cameras": [
    {
      "id": "camera_living_hero_01",
      "name": "Living Hero 01",
      "spaceId": "space_living_main",
      "transform": {
        "position": [1000, 900, 1500],
        "rotationEuler": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "target": [4300, 3400, 1350],
      "lens": {
        "focalLengthMm": 24,
        "sensorWidthMm": 36
      },
      "verticalCorrection": true,
      "compositionRole": "hero",
      "approvalState": "proposed"
    }
  ]
}
```

Possible composition roles:

```text
hero
wide
feature
material_detail
furniture_detail
symmetrical
corner
client_requested
```

Camera identity must survive lighting and material revisions.

---

## 18. Design References

References are not geometry truth by default.

Example:

```json
{
  "references": [
    {
      "id": "reference_living_01",
      "sourceId": "source_reference_01",
      "role": "style_reference",
      "weight": 0.8,
      "applyTo": ["space_living_main"],
      "analysis": {
        "style": ["modern_luxury", "warm_minimal"],
        "palette": ["warm_beige", "walnut", "brass"],
        "materials": ["travertine", "wood_veneer", "boucle"],
        "lighting": ["warm_cove", "soft_daylight"]
      }
    }
  ]
}
```

Reference roles:

```text
style_reference
material_reference
furniture_reference
lighting_reference
composition_reference
architecture_reference
client_approval_reference
```

A reference may influence a subset of the scene instead of everything.

---

## 19. Constraints

Constraints convert architectural and design rules into machine-checkable requirements.

Example:

```json
{
  "constraints": [
    {
      "id": "constraint_sofa_inside_room",
      "type": "inside_boundary",
      "subjectId": "asset_living_sofa_main",
      "targetId": "space_living_main",
      "severity": "error"
    },
    {
      "id": "constraint_sofa_door_clearance",
      "type": "minimum_clearance",
      "subjectId": "asset_living_sofa_main",
      "targetId": "opening_living_door_01",
      "distance": 900,
      "severity": "error"
    }
  ]
}
```

Constraint severities:

```text
info
warning
error
blocking
```

Potential constraint types:

```text
inside_boundary
minimum_clearance
maximum_distance
face_target
align_to_wall
attach_to_surface
avoid_opening
avoid_collision
maintain_walkway
maintain_visibility
maintain_symmetry
preserve_transform
preserve_geometry
preserve_material
```

This layer is one of the major differences between a professional 3D production system and an unconstrained image generator.

---

## 20. Relationships

Some objects depend on others.

Examples:

```text
Curtain → Window
Wall light → Wall
Pendant → Ceiling
TV → TV wall
Dining chairs → Dining table
Door opening → Host wall
Material assignment → Material + target object
```

Example:

```json
{
  "relationships": [
    {
      "type": "hosted_by",
      "sourceId": "opening_living_window_01",
      "targetId": "wall_living_north"
    }
  ]
}
```

Relationships will later support dependency-aware revisions.

If a host wall moves, the system can determine which openings, lights, finishes, cameras, and renders may be affected.

---

## 21. Render Configuration

Render intent should be separated from scene geometry.

Example:

```json
{
  "render": {
    "engine": "corona",
    "mode": "preview",
    "resolution": {
      "width": 1600,
      "height": 1200
    },
    "cameraIds": ["camera_living_hero_01"],
    "qualityPreset": "preview_medium",
    "output": {
      "format": "exr",
      "directory": "project://renders/preview"
    },
    "passes": [
      "beauty",
      "albedo",
      "normal",
      "depth",
      "object_id"
    ],
    "rendererOverrides": {}
  }
}
```

Future rendering modes:

```text
clay
preview
review
final
animation
interactive
```

---

## 22. Renderer Overrides

Renderer-specific values are sometimes unavoidable.

They must live under clearly isolated namespaces.

Example:

```json
{
  "rendererOverrides": {
    "corona": {
      "someFutureProperty": "value"
    },
    "vray": {}
  }
}
```

Rules:

1. Semantic property first.
2. Renderer override only when necessary.
3. Core business logic must not depend on a renderer-specific value unless explicitly documented.

---

## 23. DCC Mapping

The platform must be able to map semantic IDs to native objects created in 3ds Max.

Example runtime mapping:

```json
{
  "dccMappings": {
    "3ds_max": {
      "wall_living_north": {
        "nodeHandle": "12345",
        "nodeName": "AVZ_wall_living_north"
      },
      "asset_living_sofa_main": {
        "nodeHandle": "12891",
        "nodeName": "AVZ_asset_living_sofa_main"
      }
    }
  }
}
```

This mapping is runtime/cache/diagnostic state, not canonical design intent.
`nodeHandle` is volatile and may change after reopen. The authoritative logical
identity inside a generated `.max` file is node metadata
`AIArchViz.LogicalObjectId`. `nodeName` uses `AVZ_<logicalId>` for human
debugging but is not authoritative.

Normative node naming convention for 3ds Max:

```text
AVZ_<SceneSpec ID>
```

Example:

```text
AVZ_wall_living_north
AVZ_asset_living_sofa_main
AVZ_camera_living_hero_01
```

---

## 24. Revision Model

Revisions should be object-level and explicit.

Example user revision:

> Replace the main sofa with a smaller curved beige sofa. Do not change its approved orientation, the TV wall, camera, or lighting.

Desired change set:

```json
{
  "revision": {
    "id": "revision_0007",
    "parentRevisionId": "revision_0006",
    "requestedBy": "user",
    "instruction": "Replace main sofa with smaller curved beige sofa",
    "changes": [
      {
        "operation": "replace_asset_reference",
        "targetId": "asset_living_sofa_main",
        "from": "SOFA_000124",
        "to": "SOFA_000812"
      }
    ],
    "preserve": [
      "asset_living_sofa_main.transform.rotationEuler",
      "wall_living_tv",
      "camera_living_hero_01",
      "lighting:*"
    ]
  }
}
```

A revision engine may later use JSON Patch internally, but the domain-level revision model should remain understandable and auditable.

---

## 25. Change Impact Tracking

Every revision should calculate impact.

Example:

```json
{
  "impact": {
    "geometryChanged": false,
    "assetPlacementChanged": true,
    "materialsChanged": true,
    "lightingChanged": false,
    "cameraChanged": false,
    "staleRenderIds": [
      "render_living_hero_01_final"
    ]
  }
}
```

This enables selective re-rendering instead of rebuilding an entire project after every revision.

---

## 26. Validation

Before compiling a scene into 3ds Max, `SceneSpec` should pass structural and domain validation.

### 26.1 Structural validation

Examples:

```text
Required IDs exist
IDs are unique
Referenced IDs exist
Units are valid
Transforms are numeric
Asset references resolve
Material references resolve
```

### 26.2 Architectural validation

Examples:

```text
Doors are hosted by valid walls
Openings fit within host walls
Furniture stays inside room boundaries
Objects do not intersect blocking openings
Minimum circulation clearance is maintained
Ceiling lights are located at valid elevations
```

### 26.3 Rendering validation

Examples:

```text
At least one camera exists
Camera is not inside solid geometry
Renderer adapter is available
Missing textures are reported
Missing assets are reported
Output path is writable
```

### 26.4 Confidence validation

Example rule:

```text
Any structural dimension inferred with confidence < 0.85
→ requires human review before Production status
```

Thresholds should become configurable rather than hard-coded.

---

## 27. Processing State

Entities may move through processing states.

Example:

```text
raw
parsed
inferred
validated
approved
compiled
rendered
```

At the project level:

```json
{
  "state": {
    "input": "validated",
    "geometry": "approved",
    "assets": "selected",
    "materials": "approved",
    "lighting": "preview",
    "cameras": "approved",
    "render": "pending"
  }
}
```

This will later power UI progress and job orchestration.

---

## 28. Human Approval Boundaries

Production automation must distinguish between safe automatic changes and approval-required changes.

Example policy:

```text
Automatic:
- regenerate preview
- repair missing texture path
- reapply approved transform
- calculate camera score

Approval Required:
- move structural wall
- change door/window location
- change verified dimension
- replace approved furniture
- materially change design direction
```

The exact policy may later be configurable per project or organization.

---

## 29. AI Interaction Contract

AI should normally return proposals that can be validated before they modify the scene.

Bad pattern:

```text
LLM directly manipulates random 3ds Max nodes.
```

Preferred pattern:

```text
User Intent
    ↓
AI Proposal
    ↓
Structured SceneSpec Change
    ↓
Schema Validation
    ↓
Constraint Validation
    ↓
Approval Policy
    ↓
Scene Compiler
    ↓
3ds Max
```

Example AI proposal:

```json
{
  "proposal": {
    "type": "asset_replacement",
    "targetId": "asset_living_sofa_main",
    "candidateAssetIds": [
      "SOFA_000812",
      "SOFA_000948",
      "SOFA_001102"
    ],
    "recommendedAssetId": "SOFA_000812",
    "reason": "Matches requested curved beige style and fits available wall clearance.",
    "confidence": 0.91
  }
}
```

This design keeps AI useful without giving it uncontrolled authority over production geometry.

---

## 30. Extension Namespace

Future modules need a safe place for experimental or application-specific data.

Example:

```json
{
  "extensions": {
    "com.aiarchviz.experimental": {},
    "com.aiarchviz.energy": {},
    "com.aiarchviz.unreal": {}
  }
}
```

Extension rules:

1. Extensions must not redefine core IDs.
2. Extensions must not silently change canonical geometry semantics.
3. Important stable extensions should eventually graduate into the core schema.
4. Unknown extension namespaces should be preserved where possible.

---

## 31. File Organization

Initial project package proposal:

```text
project-root/
├── scene/
│   ├── scene-spec.json
│   ├── revisions/
│   │   ├── revision-0001.json
│   │   └── revision-0002.json
│   └── validation.json
│
├── inputs/
│   ├── drawings/
│   ├── pdf/
│   └── references/
│
├── assets/
│   └── project-specific/
│
├── textures/
│
├── scenes/
│   ├── 3dsmax/
│   └── usd/
│
├── renders/
│   ├── preview/
│   └── final/
│
└── logs/
```

The exact physical storage system may later be local filesystem, network storage, object storage, or a hybrid.

Logical URIs should prevent business logic from depending directly on Windows drive paths.

Example:

```text
project://inputs/drawings/ground-floor.dwg
asset://furniture/sofas/SOFA_000124.max
texture://materials/travertine_01/basecolor.jpg
```

Adapters resolve logical URIs to actual local or remote paths.

---

## 32. Complete Living Room Example

The following legacy example is **illustrative and non-normative**. It
demonstrates how broad concepts connect, but the executable Golden fixture at
`tests/fixtures/living-room-golden/scene-spec.json` is the only v0.1 living-room
machine example. Implementations must validate against the normative schema.

```json
{
  "sceneSpecVersion": "0.1.0",

  "project": {
    "id": "project_living_test_001",
    "name": "Living Room Test 001",
    "type": "interior",
    "status": "design",
    "defaultRenderer": "corona"
  },

  "coordinateSystem": {
    "linearUnit": "mm",
    "angularUnit": "degree",
    "upAxis": "Z",
    "handedness": "right",
    "originPolicy": "project_origin",
    "worldOrigin": [0, 0, 0]
  },

  "sources": [
    {
      "id": "source_dwg_01",
      "type": "dwg",
      "uri": "project://inputs/drawings/living-room.dwg",
      "role": "architectural_geometry",
      "verified": true
    },
    {
      "id": "source_ref_01",
      "type": "image",
      "uri": "project://inputs/references/ref-01.jpg",
      "role": "design_reference",
      "verified": true
    }
  ],

  "levels": [
    {
      "id": "level_ground",
      "name": "Ground Floor",
      "elevation": 0,
      "defaultCeilingHeight": 3000
    }
  ],

  "spaces": [
    {
      "id": "space_living_main",
      "levelId": "level_ground",
      "name": "Main Living Room",
      "type": "living_room",
      "boundary": [
        [0, 0],
        [7200, 0],
        [7200, 5800],
        [0, 5800]
      ],
      "floorElevation": 0,
      "ceilingHeight": 3000,
      "style": {
        "primary": "modern_luxury"
      }
    }
  ],

  "geometry": [
    {
      "id": "wall_living_north",
      "type": "wall",
      "levelId": "level_ground",
      "spaceIds": ["space_living_main"],
      "path": [[0, 5800, 0], [7200, 5800, 0]],
      "thickness": 150,
      "height": 3000
    },
    {
      "id": "floor_living_main",
      "type": "floor",
      "spaceIds": ["space_living_main"],
      "boundary": [
        [0, 0, 0],
        [7200, 0, 0],
        [7200, 5800, 0],
        [0, 5800, 0]
      ],
      "thickness": 100
    }
  ],

  "openings": [
    {
      "id": "opening_living_window_01",
      "type": "window",
      "hostId": "wall_living_north",
      "width": 3200,
      "height": 2400,
      "sillHeight": 300,
      "offsetAlongHost": 1900
    }
  ],

  "assets": [
    {
      "id": "asset_living_sofa_main",
      "type": "asset_instance",
      "category": "sofa",
      "libraryAssetId": "SOFA_000124",
      "spaceId": "space_living_main",
      "transform": {
        "position": [3600, 3900, 0],
        "rotationEuler": [0, 0, 180],
        "scale": [1, 1, 1]
      },
      "approvalState": "selected",
      "locks": {
        "geometry": false,
        "transform": false,
        "material": false
      }
    }
  ],

  "materials": [
    {
      "id": "mat_floor_marble_01",
      "name": "Warm Large Format Marble",
      "category": "stone",
      "subtype": "marble",
      "physicalScaleMm": 1200
    }
  ],

  "materialAssignments": [
    {
      "id": "assign_floor_marble",
      "targetId": "floor_living_main",
      "materialId": "mat_floor_marble_01",
      "slot": "surface"
    }
  ],

  "lights": [
    {
      "id": "light_living_key_01",
      "type": "area",
      "spaceId": "space_living_main",
      "transform": {
        "position": [3600, 2900, 2800],
        "rotationEuler": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "intensity": {
        "value": 1800,
        "unit": "lumen"
      },
      "colorTemperatureK": 3000,
      "enabled": true
    }
  ],

  "cameras": [
    {
      "id": "camera_living_hero_01",
      "name": "Living Hero 01",
      "spaceId": "space_living_main",
      "transform": {
        "position": [900, 900, 1500],
        "rotationEuler": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "target": [4400, 3500, 1400],
      "lens": {
        "focalLengthMm": 24,
        "sensorWidthMm": 36
      },
      "verticalCorrection": true,
      "compositionRole": "hero",
      "approvalState": "proposed"
    }
  ],

  "references": [
    {
      "id": "reference_living_style_01",
      "sourceId": "source_ref_01",
      "role": "style_reference",
      "weight": 0.85,
      "applyTo": ["space_living_main"],
      "analysis": {
        "style": ["modern_luxury"],
        "palette": ["warm_beige", "walnut", "brass"],
        "materials": ["travertine", "wood", "boucle"]
      }
    }
  ],

  "constraints": [
    {
      "id": "constraint_sofa_inside_space",
      "type": "inside_boundary",
      "subjectId": "asset_living_sofa_main",
      "targetId": "space_living_main",
      "severity": "error"
    }
  ],

  "render": {
    "engine": "corona",
    "mode": "preview",
    "resolution": {
      "width": 1600,
      "height": 1200
    },
    "cameraIds": ["camera_living_hero_01"],
    "qualityPreset": "preview_medium",
    "output": {
      "format": "exr",
      "directory": "project://renders/preview"
    }
  },

  "revisions": [],
  "extensions": {}
}
```

---

## 33. Scene Compiler Responsibilities

`SceneSpec` itself does not open 3ds Max.

A separate scene compiler / adapter is responsible for:

```text
Read SceneSpec
↓
Validate Schema
↓
Resolve Assets
↓
Resolve Textures
↓
Convert Coordinates
↓
Create / Update Architecture
↓
Create / Update Assets
↓
Create Materials
↓
Assign Materials
↓
Create Lights
↓
Create Cameras
↓
Apply Renderer Configuration
↓
Maintain DCC Mapping
↓
Save .max
```

The compiler should support two important modes.

### Build Mode

Create a scene from an empty or template `.max` file.

### Sync Mode

Compare the current DCC scene to `SceneSpec` and apply only required changes.

`Sync Mode` is critical for long-term revision performance.

---

## 34. Idempotency Goal

Applying the same valid `SceneSpec` twice should not create duplicate walls, duplicate sofas, duplicate lights, or duplicate cameras.

Desired behavior:

```text
Compile SceneSpec A
→ Scene A

Compile SceneSpec A again
→ Scene A remains logically equivalent
```

This requires stable IDs and DCC mappings.

---

## 35. Asset and Texture Integrity

Scene compilation should never silently substitute missing assets in Production mode.

Example states:

```text
Resolved
Missing
Version Mismatch
Hash Mismatch
Substituted
Deprecated
```

Preview mode may allow controlled fallback assets, but all substitutions must be reported.

---

## 36. SceneSpec and OpenUSD

`SceneSpec` and OpenUSD solve related but different problems.

`SceneSpec` focuses on:

```text
Product semantics
User intent
Approval state
AI provenance
Constraints
Revision intent
Asset selection
Workflow state
```

OpenUSD is better suited for:

```text
Scene composition
Geometry interchange
Transforms
Materials
Instancing
DCC interoperability
Large scene graphs
```

Long-term direction:

```text
SceneSpec
    +
OpenUSD
    ↓
Production Scene Package
```

The platform should avoid forcing either format to contain information better owned by the other.

---

## 37. Security and Trust Boundaries

Scene files, scripts, downloaded assets, and external references can be untrusted.

Future implementation must account for:

- malicious or broken MAXScript/Python embedded in assets
- unsafe archive extraction
- path traversal
- external network paths
- missing dependencies
- unexpected plugins
- corrupted geometry
- oversized assets
- unsupported renderer materials

`SceneSpec` should store data, not executable scripts from AI responses.

Execution should happen only through controlled, versioned worker code.

---

## 38. Observability

Every automated scene build should be traceable.

Recommended job metadata:

```json
{
  "jobId": "job_01J...",
  "projectId": "project_living_test_001",
  "sceneSpecVersion": "0.1.0",
  "workerVersion": "0.1.0",
  "adapter": "3dsmax",
  "renderer": "corona",
  "startedAt": "...",
  "completedAt": "...",
  "status": "success",
  "warnings": [],
  "errors": []
}
```

This becomes essential when renders are generated across multiple local or cloud workers.

---

## 39. Testing Strategy

Every schema feature should eventually have fixture scenes.

Initial fixtures:

```text
01-empty-room
02-room-with-door
03-room-with-window
04-room-with-sofa
05-room-with-materials
06-room-with-lights
07-room-with-camera
08-living-room-complete
09-sofa-revision
10-material-revision
```

For each fixture, test:

```text
Schema validation
3ds Max compilation
Idempotent recompilation
Object count
Object identity
Transforms
Material assignment
Camera creation
Scene save
Revision sync
```

Render quality testing will be separate from deterministic scene correctness testing.

---

## 40. What v0.1 Intentionally Does Not Solve

`SceneSpec v0.1` does not attempt to fully solve:

- arbitrary NURBS/BREP authoring
- complete BIM semantics
- detailed MEP systems
- structural engineering analysis
- parametric families equivalent to Revit
- animation timelines
- character animation
- procedural vegetation ecosystems
- full USD schema replacement
- collaborative CRDT editing
- multi-user merge conflict resolution
- final renderer-specific schema coverage

These can be added when real production requirements justify them.

---

## 41. Implementation Order

Recommended implementation sequence:

```text
1. SceneSpec TypeScript types
2. Runtime schema validation
3. ID conventions
4. Unit and coordinate helpers
5. Minimal room geometry
6. 3ds Max node mapping
7. Scene compiler Build Mode
8. Save .max
9. Camera creation
10. Corona test render
11. Asset resolution
12. Material assignment
13. Constraint validation
14. Sync Mode
15. Revision changesets
16. AI proposal layer
```

AI integration comes after deterministic compilation works.

---

## 42. Initial Package Proposal

Repository package:

```text
packages/scene-spec/
```

Suggested future structure:

```text
packages/scene-spec/
├── src/
│   ├── index.ts
│   ├── schema/
│   │   ├── project.ts
│   │   ├── coordinates.ts
│   │   ├── source.ts
│   │   ├── level.ts
│   │   ├── space.ts
│   │   ├── geometry.ts
│   │   ├── opening.ts
│   │   ├── asset.ts
│   │   ├── material.ts
│   │   ├── light.ts
│   │   ├── camera.ts
│   │   ├── reference.ts
│   │   ├── constraint.ts
│   │   ├── render.ts
│   │   └── revision.ts
│   │
│   ├── validation/
│   ├── ids/
│   ├── units/
│   └── migrations/
│
├── fixtures/
├── tests/
└── package.json
```

The exact validation library should be selected during implementation rather than embedded into the architectural contract.

---

## 43. Open Questions for v0.2

These questions should be decided using real scene tests rather than theory alone:

1. How should complex wall joins and curved walls be represented beyond the
   v0.1 independent-prism rule?
2. Should room boundaries be derived from walls after the deterministic v0.1
   profile is proven?
3. How much mesh-level data should be allowed directly in SceneSpec?
4. What is the best material abstraction shared by Corona and V-Ray?
5. How should layered ceilings and custom joinery be modeled semantically?
6. What confidence thresholds require human approval?
7. Which data belongs in SceneSpec versus OpenUSD versus durable project state?
8. How should external asset versions and licensing metadata be tracked?
9. How should custom client assets override global asset-library metadata?

These questions are intentionally deferred until the first real Living Room test exposes practical requirements.

---

## 44. Definition of Done for SceneSpec v0.1

`SceneSpec v0.1` will be considered proven when a fixture JSON can reliably drive the following local workflow:

```text
scene-spec.json
      ↓
Schema Validation
      ↓
Local Windows Worker
      ↓
3ds Max
      ↓
Room Geometry
      ↓
Real Asset Placement
      ↓
Material Assignment
      ↓
Lighting
      ↓
Camera
      ↓
Corona Preview Render
      ↓
Save Editable .max
```

Then a second SceneSpec revision must be able to change one selected object without unnecessarily recreating the complete scene.

That second requirement is as important as the first render because revision safety is a primary product goal.

---

## 45. Long-Term Principle

The value of `SceneSpec` is not the JSON syntax itself.

The long-term value is that every part of the platform can communicate through a stable architectural language:

```text
CAD understands geometry.
AI understands intent.
Asset Engine understands products.
Constraint Engine understands rules.
3ds Max understands production geometry.
Corona / V-Ray understand rendering.
Revision Engine understands change.

SceneSpec connects them without making any one system the entire product.
```

This separation is what allows AI ArchViz Platform to evolve as AI models, renderers, DCC applications, and workflows change over time.
