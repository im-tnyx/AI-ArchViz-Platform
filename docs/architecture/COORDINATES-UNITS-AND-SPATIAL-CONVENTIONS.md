# Coordinates, Units & Spatial Conventions

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Purpose:** Define one deterministic spatial language for CAD inputs, SceneSpec, asset libraries, 3ds Max, renderers, revisions, and future DCC integrations.

---

## 1. Why This Document Exists

AI ArchViz Platform will move spatial data between multiple systems:

- DWG / DXF
- PDF-derived geometry
- manual dimensions
- SceneSpec
- asset metadata
- placement engine
- 3ds Max
- Corona
- V-Ray
- future OpenUSD / Unreal / Blender integrations

These systems may use different units, axes, pivot conventions, rotation formats, transform orders, and coordinate origins.

Without one canonical convention, common failures include:

- furniture imported at the wrong scale
- objects rotated 90° or 180° unexpectedly
- doors and windows appearing on the wrong side of walls
- elevation geometry not aligning with plan geometry
- assets floating above or below the floor
- scene revisions moving objects unexpectedly
- CAD and 3ds Max coordinate drift
- mirrored geometry
- inconsistent camera transforms

The platform therefore defines one canonical spatial contract before any DCC-specific conversion occurs.

---

## 2. Core Rule

> All domain-level geometry and transforms are normalized into SceneSpec conventions before they are sent to 3ds Max or any other execution target.

External formats are adapters.

SceneSpec is the canonical spatial contract.

```text
DWG / DXF / PDF / Asset / Existing Scene
                  ↓
             Input Adapter
                  ↓
         Normalize Units + Axes
                  ↓
              SceneSpec
                  ↓
          DCC Output Adapter
                  ↓
               3ds Max
```

No business rule should depend on an unnormalized external coordinate system.

---

## 3. Canonical Linear Unit

The canonical SceneSpec unit is:

```text
millimeter (mm)
```

All stored architectural dimensions, asset dimensions, positions, offsets, clearances, elevations, camera positions, and geometry coordinates must be expressed in millimeters unless a field explicitly declares another physical quantity.

Examples:

```json
{
  "wallLength": 5200,
  "ceilingHeight": 3000,
  "doorWidth": 900,
  "cameraHeight": 1500
}
```

### 3.1 Why millimeters

Millimeters match common architectural and interior production workflows and avoid unnecessary floating-point fractions for typical room and furniture dimensions.

### 3.2 Input conversion

Incoming values must be converted before entering canonical SceneSpec.

Examples:

```text
2.4 m      → 2400 mm
8 ft       → 2438.4 mm
36 in      → 914.4 mm
0.9 m      → 900 mm
```

The original source unit must still be retained in provenance metadata when useful.

---

## 4. Precision Policy

Architectural values and computational geometry require different precision behavior.

### 4.1 Stored values

SceneSpec may store decimal millimeters where necessary.

Example:

```json
{
  "position": [1234.25, 600.0, 0.0]
}
```

### 4.2 Display values

User interfaces may round values for readability without modifying canonical data.

### 4.3 Comparison tolerance

Floating-point equality must never be used blindly for spatial validation.

Initial recommended tolerances:

```text
Exact architectural comparison: source-defined
General geometry epsilon:      0.01 mm
Placement contact tolerance:   1.0 mm
Visual alignment tolerance:    context-dependent
```

These values are defaults and may evolve through testing.

---

## 5. Canonical Coordinate System

SceneSpec uses a right-handed Cartesian coordinate system.

Canonical axes:

```text
+X → project east / local right
+Y → project north / local forward
+Z → up
```

`+Z` is always vertical up in canonical SceneSpec.

This convention must remain stable even when an external application uses different internal assumptions.

---

## 6. Project World Origin

Every project must define an explicit canonical world origin.

For initial interior projects, the preferred strategy is:

```text
Project local origin = a stable architectural reference point on Level 0
```

Examples:

- lower-left validated plan reference
- CAD project base point
- structural grid intersection
- manually approved project datum

The origin must not be chosen from a temporary furniture object, camera, reference image, or AI guess.

Example:

```json
{
  "coordinateSystem": {
    "unit": "mm",
    "handedness": "right",
    "upAxis": "Z",
    "origin": [0, 0, 0]
  }
}
```

---

## 7. Levels and Elevations

Vertical positions must be referenced to explicit project levels.

Example:

```json
{
  "levels": [
    {
      "id": "level_ground",
      "name": "Ground Floor",
      "elevation": 0
    },
    {
      "id": "level_first",
      "name": "First Floor",
      "elevation": 3300
    }
  ]
}
```

Objects may reference a level while still storing world-space or level-local transforms.

A future multi-storey scene must not infer storey elevation only from object bounding boxes.

---

## 8. Local Space vs World Space

The platform distinguishes:

```text
World Space
Object Local Space
Parent Local Space
Room Local Space
Level Local Space
```

### 8.1 Canonical storage rule

Critical production transforms must always be resolvable to world space.

A hierarchical object may store a local transform, but the platform must be able to calculate its world transform deterministically.

SceneSpec v0.1 does not support arbitrary transform hierarchies. `spaceId` and
`levelId` do not create transform parents. All stored transforms are
world-equivalent local values except opening transforms, which are explicitly
host-wall-local as `[offset, 0, sill]`. A future `parentId` contract requires a
schema version change and explicit composition tests.

### 8.2 Example

A pendant light may be positioned relative to a ceiling group, but its final world position must be calculable without opening 3ds Max.

---

## 9. Transform Representation

Every transform must be explicit.

Normative SceneSpec v0.1 representation:

```json
{
  "transform": {
    "position": [3200, 1800, 0],
    "rotationEuler": [0, 0, 180],
    "scale": [1, 1, 1]
  }
}
```

### 9.1 Position

Position values are in canonical millimeters.

### 9.2 Rotation

Human-facing SceneSpec v0.1 uses degrees.

The three components are `rotationEuler[0]=X`,
`rotationEuler[1]=Y`, and `rotationEuler[2]=Z`.

Canonical axis interpretation:

```text
rotation[0] → X
rotation[1] → Y
rotation[2] → Z
```

### 9.3 Scale

Scale is unitless.

Production assets should normally use:

```text
[1, 1, 1]
```

Non-uniform scale should be treated as exceptional and validated.

---

## 10. Rotation Convention

For common interior placement, heading around the vertical axis is the most frequent operation.

Canonical yaw:

```text
rotation around +Z
```

The normative right-handed v0.1 yaw mapping for asset forward `+Y` is:

```text
0 deg   = +Y
90 deg  = -X
180 deg = -Y
270 deg = +X
```

Adapters must implement this normative mapping and must not rely on
application-specific rotation defaults.

For advanced hierarchical or animation workflows, the platform may later use quaternions or transformation matrices internally while preserving a clear SceneSpec representation.

---

## 11. Transform Order

Transform order must never depend on implicit DCC defaults.

Canonical conceptual order:

```text
Local Geometry
    ↓
Scale
    ↓
Rotation
    ↓
Translation
    ↓
Parent Transform
    ↓
World Transform
```

For column vectors, the normative v0.1 composition is
`M = T * Rz(z) * Ry(y) * Rx(x) * S`. Components are applied X, then Y, then Z
using the right-hand rule. Adapters must test this mapping instead of relying
on DCC Euler defaults.

---

## 12. Asset Forward Direction

Every production asset in the asset library must declare a canonical forward direction.

Preferred normalized asset convention:

```text
Forward = +Y
Up      = +Z
```

Examples:

- sofa front faces `+Y`
- bed foot direction faces `+Y`
- chair sitting direction faces `+Y`
- TV front faces `+Y`
- cabinet front faces `+Y`

Assets that do not follow this convention must include import correction metadata.

Example:

```json
{
  "assetId": "SOFA_00124",
  "orientation": {
    "forwardAxis": "+Y",
    "upAxis": "+Z",
    "importRotationCorrection": [0, 0, 0]
  }
}
```

---

## 13. Asset Pivot Convention

Asset pivot quality is critical for deterministic placement.

Preferred furniture pivot:

```text
X = horizontal center
Y = footprint center unless category rules require rear reference
Z = lowest valid floor-contact point
```

However, category-specific anchors may also exist.

Examples:

```text
Sofa        → floor-center + rear alignment anchor
Bed         → floor-center + headboard anchor
Wall Light  → wall mounting point
Pendant     → ceiling mounting point
Door        → hinge axis anchor
Window      → opening reference anchor
Curtain     → track/rod anchor
```

SceneSpec must distinguish object pivot from semantic anchors.

---

## 14. Semantic Anchors

An asset may expose named anchor points.

Example:

```json
{
  "anchors": {
    "floor": [0, 0, 0],
    "back": [0, -520, 380],
    "front": [0, 520, 380],
    "left": [-1600, 0, 380],
    "right": [1600, 0, 380]
  }
}
```

Anchors support operations such as:

- align sofa back to wall
- align bed headboard to wall
- place lamp above table center
- snap curtain to opening
- position mirror above vanity

The placement engine should prefer semantic anchors over raw bounding-box guesses when available.

---

## 15. Architectural Wall Convention

Walls must be represented semantically rather than only as anonymous meshes.

A wall should include enough information to derive:

- baseline
- direction
- thickness
- height
- interior/exterior side where known
- openings
- level

Normative v0.1 wall contract:

```json
{
  "id": "wall_living_north",
  "type": "wall",
  "spaceId": "space_living_main",
  "start": [0, 5800, 0],
  "end": [7200, 5800, 0],
  "baseElevation": 0,
  "thickness": 150,
  "height": 3000,
  "referenceLine": "interior_face",
  "thicknessDirection": "exterior_right_of_u"
}
```

For every directed wall:

```text
u = normalize(end - start)
z = [0, 0, 1]
nExterior = cross(u, z)
nInterior = cross(z, u)
```

`start` and `end` are points on the finished room-interior face at
`baseElevation`. Local `+U` runs from `start` to `end`, local `+Z` is world
`+Z`, and the wall solid occupies offsets `[0, thickness]` along
`nExterior`. The associated room interior is always on the left of the
directed wall, along `nInterior`. Reversing a wall reverses its semantic sides;
v0.1 validation rejects a boundary edge that no longer follows its space's
counter-clockwise polygon.

Wall height occupies `[baseElevation, baseElevation + height]`. Spike 1 walls
are independent capped rectangular prisms. No automatic miter, junction
extension, boolean union, or curved-wall behavior is permitted. Openings
subtract only from their host prism.

For the Golden polygon, the south/east/north/west directions produce exterior
normals `-Y`, `+X`, `+Y`, and `-X`. The stored 6000 x 4500 polygon therefore
remains the exact finished interior size.

### 15.1 Geometry fields versus Transform

Spike 1 does not apply semantic coordinates and transforms twice:

- Wall `start`, `end`, and `baseElevation` are already world-equivalent
  canonical coordinates. Wall `transform` must be the identity transform and
  is preserved only for uniform manifest shape.
- A floor/ceiling `boundary` is local XY geometry at local Z=0.
  `transform.position` places that surface; `elevation` must equal
  `transform.position[2]` and is a semantic validation mirror, not an
  additional translation.
- An opening `transform` is a required derived verification mirror:
  `position=[offset,0,sill]`, identity rotation, unit scale. Placement uses the
  host-local opening equations once; the transform is not added again.
- Asset and camera transforms are direct world-equivalent local transforms.

Any equality violation is a semantic validation error before DCC launch.

---

## 16. Door Convention

Doors must not be represented only as visible meshes.

A door needs semantic data such as:

```text
host wall
authoritative opening width
opening height
sill / base elevation
hinge side
swing direction
leaf thickness where needed
```

Door swing must use host-wall-local orientation so that plan rotations do not corrupt hinge semantics.

Normative host-local opening fields are:

```json
{
  "hostGeometryId": "wall_west",
  "offset": 2400,
  "width": 900,
  "sill": 0,
  "height": 2100,
  "hingeSide": "start_jamb",
  "swingDirection": "into_room"
}
```

`offset` is measured from directed host `start` to the first jamb along `+U`:

```text
openingStart = wall.start + u * offset
openingEnd   = wall.start + u * (offset + width)
bottom       = wall.baseElevation + sill
top          = bottom + height
```

`hingeSide` is `start_jamb` or `end_jamb`, naming the jamb at
`openingStart` or `openingEnd`. `swingDirection` is `into_room` or
`out_of_room`; `into_room` means toward `nInterior`.

---

## 17. Window Convention

Windows require:

```text
host wall
opening width
opening height
sill elevation
head elevation
wall-relative offset
orientation
```

Elevation data should override inferred vertical window values according to the Evidence and Provenance policy.

Windows use the same `offset`, `width`, `sill`, and `height` equations. They do
not carry door hinge or swing fields. Head elevation is derived exactly as
`baseElevation + sill + height` and is not an independent input.

---

## 18. Room Coordinate Frames

A room may define a local coordinate frame for layout reasoning.

This is useful because architectural projects can be rotated relative to world north.

Example:

```json
{
  "roomFrame": {
    "origin": [12000, 6000, 0],
    "forward": [0.7071, 0.7071, 0],
    "up": [0, 0, 1]
  }
}
```

AI and placement logic may reason in room-local directions such as:

```text
front
back
left
right
```

but final transforms must resolve into canonical world space.

---

## 19. CAD Import Normalization

CAD input must pass through a normalization stage.

Required checks:

```text
Detect source units
Detect insertion scale
Resolve project origin
Resolve rotation / north direction
Preserve original layer data
Convert geometry to mm
Map Z values
Remove or flag extreme coordinate offsets
```

The CAD adapter must record the transformation used to normalize the drawing.

Example:

```json
{
  "sourceTransform": {
    "sourceUnit": "m",
    "position": [-45210, -78120, 0],
    "rotationEuler": [0, 0, 0],
    "scale": [1000, 1000, 1000]
  }
}
```

This transformation must be reversible where practical.

---

## 20. Large CAD Coordinate Handling

Some architectural drawings use survey or geographic coordinates far from the origin.

Rendering and DCC applications may experience precision issues with very large values.

Therefore the platform may use:

```text
Source World Coordinates
        +
Project Local Origin Offset
        ↓
Scene Local Coordinates
```

The original survey/base coordinates must remain preserved as metadata.

Do not permanently destroy georeferencing just to move geometry near `[0,0,0]`.

---

## 21. Plan and Elevation Registration

Plan and elevation drawings must be registered using deterministic anchors whenever possible.

Potential anchors:

- grid lines
- wall endpoints
- opening centers
- floor levels
- labeled dimensions
- explicit datums

Workflow:

```text
Plan
+
Elevation
↓
Find Shared Architectural Anchors
↓
Calculate Registration Transform
↓
Validate Error
↓
Accept / Flag Conflict
```

AI may suggest matching features, but the resulting registration transform must be numerically validated.

---

## 22. Reference Images Have No Automatic Metric Coordinate Authority

A visual reference image normally provides design intent, not exact geometry.

Reference images must not silently define:

- room length
- wall height
- opening width
- floor elevation
- exact furniture size

unless the image is part of a calibrated photogrammetry / scan workflow or a human explicitly approves inferred dimensions.

Perspective appearance is not a substitute for architectural measurement.

---

## 23. Bounding Boxes

Every asset should eventually expose a canonical local bounding box.

Example:

```json
{
  "bounds": {
    "min": [-1600, -525, 0],
    "max": [1600, 525, 780]
  }
}
```

Bounding boxes are useful for:

- rough collision detection
- room-fit filtering
- camera visibility tests
- asset previews

They are not sufficient for all final collision decisions.

---

## 24. Collision Geometry

The platform may support multiple geometry levels:

```text
AABB
OBB
Convex Hull
Simplified Collision Mesh
Production Mesh
```

Use the cheapest representation that safely answers the current question.

Example:

```text
Asset search       → dimensions / AABB
Placement proposal → OBB / simplified collision
Final validation   → category-specific geometry where required
```

---

## 25. Floor Contact Rule

Floor-standing assets should resolve to an explicit support surface.

They must not be positioned using arbitrary visual Z offsets.

Example:

```json
{
  "support": {
    "type": "floor",
    "surfaceId": "floor_living",
    "offset": 0
  }
}
```

This makes future floor thickness or level changes safer.

---

## 26. Wall-Mounted Object Rule

Wall-mounted objects should reference a host wall plus local wall coordinates where practical.

Example:

```json
{
  "host": {
    "type": "wall",
    "id": "wall_tv"
  },
  "wallPlacement": {
    "horizontalOffset": 2100,
    "elevation": 1450,
    "depthOffset": 0
  }
}
```

This is safer than storing only a world-space XYZ because wall revisions can then propagate predictably.

---

## 27. Ceiling-Mounted Object Rule

Ceiling-mounted objects should reference:

- host ceiling or ceiling zone
- plan position
- mounting elevation
- vertical drop

Example uses:

- pendants
- chandeliers
- downlights
- track lights
- ceiling fans

---

## 28. Camera Coordinates

Camera data must be fully reproducible.

Normative target-based camera fields:

```text
transform
target
orientationPolicy = look_at_target
focalLengthMm
sensorWidthMm
```

Example:

```json
{
  "camera": {
    "transform": {
      "position": [1200, 3800, 1500],
      "rotationEuler": [-2.844710, 0, 206.565051],
      "scale": [1, 1, 1]
    },
    "target": [3000, 200, 1300],
    "orientationPolicy": "look_at_target",
    "focalLengthMm": 24,
    "sensorWidthMm": 36
  }
}
```

For `look_at_target`, target is authoritative and `rotationEuler` is a
precomputed verification value. Let `d = target - position`,
`h = sqrt(dx^2 + dy^2)`, and use degrees:

```text
rotationEuler.x = atan2(dz, h)
rotationEuler.y = 0
rotationEuler.z = normalize_0_360(atan2(-dx, dy))
```

This formula assumes canonical forward `+Y` and the v0.1 matrix composition.
Validators reject `target == position` and reject a stored Euler value that
differs from the formula beyond `rotationToleranceDeg`.

---

## 29. Light Coordinates

Lights must use explicit transforms and semantic host relationships where relevant.

A downlight may reference ceiling position.

A wall light may reference a host wall.

A table lamp may reference an asset/support surface.

This enables geometry revisions without losing design intent.

---

## 30. 3ds Max Adapter Rules

3ds Max is an execution target, not the canonical coordinate authority.

The adapter must:

```text
Read canonical SceneSpec
Confirm system units
Convert transforms where required
Apply asset correction metadata
Create deterministic object transforms
Write logical IDs into object metadata
Avoid hidden scale conversions
```

A round-trip test must verify that a known SceneSpec transform results in the expected 3ds Max transform.

---

## 31. 3ds Max System Unit Policy

The local worker must explicitly inspect and configure 3ds Max unit behavior before scene generation.

Preferred intent:

```text
SceneSpec canonical unit = mm
3ds Max execution scene = millimeter-compatible deterministic scale
```

The implementation must not rely on whatever unit setting happened to be saved in the user's last 3ds Max session.

The worker should fail or normalize rather than silently render a wrongly scaled scene.

---

## 32. Existing 3ds Max Scene Import

When importing an existing `.max` project into the platform, the adapter must inspect:

```text
system units
display units
scene scale
object transforms
object pivots
parent hierarchy
negative scale
non-uniform scale
far-from-origin geometry
```

Objects that cannot be safely normalized must be flagged rather than silently altered.

---

## 33. Negative Scale Policy

Negative scale is dangerous because it may create mirrored geometry, reversed normals, and inconsistent renderer behavior.

SceneSpec v0.1 prohibits negative scale. Schema validation must reject it.

Mirroring should be expressed as an explicit semantic or geometry operation when possible.

Any imported asset with negative scale must be normalized or flagged.

---

## 34. Non-Uniform Scale Policy

Non-uniform scale may distort:

- furniture proportions
- material mapping
- normals
- child transforms
- collision geometry

Default v0.1 policy:

```text
Uniform scale → allowed with validation
Non-uniform scale → discouraged / requires explicit approval
```

Asset matching should prefer selecting the correct asset size rather than stretching production furniture arbitrarily.

Uniform positive scale is allowed. Non-uniform positive scale is allowed only
when the owning object explicitly sets `allowNonUniformScale: true`; otherwise
semantic validation rejects it.

---

## 35. Mirroring and Symmetry

Mirroring an architectural element must preserve semantic orientation.

Example:

A mirrored door must update:

```text
hinge side
swing direction
hardware orientation
local anchors
```

A raw geometric mirror is not enough.

---

## 36. Snapping Rules

Placement operations may use semantic snapping.

Examples:

```text
floor snap
wall-back snap
wall-center snap
opening-center snap
ceiling snap
asset-anchor snap
grid snap
```

Snapping must produce an explicit final transform rather than leaving hidden DCC constraints as the only source of truth.

---

## 37. Clearance Values

Clearance distances are physical values and therefore stored in millimeters.

Example:

```json
{
  "constraints": {
    "minFrontClearance": 900,
    "minSideClearance": 450
  }
}
```

Category-specific clearance rules belong to domain/placement policy, but they use the same canonical unit system.

---

## 38. Revision Safety

A spatial revision must describe intent relative to stable object identities and canonical coordinates.

Example:

```text
Move sofa 300 mm toward TV wall
```

must resolve into a deterministic SceneChangeSet operation.

The platform should not repeatedly ask AI to regenerate the sofa transform from scratch.

---

## 39. Spatial Change Example

Before:

```json
{
  "objectId": "obj_sofa_main",
  "position": [3200, 3800, 0],
  "rotation": [0, 0, 180]
}
```

Change:

```json
{
  "operation": "translate",
  "objectId": "obj_sofa_main",
  "delta": [0, -300, 0],
  "unit": "mm"
}
```

After:

```json
{
  "objectId": "obj_sofa_main",
  "position": [3200, 3500, 0],
  "rotation": [0, 0, 180]
}
```

The change is auditable and repeatable.

---

## 40. Spatial Validation Gates

Before execution, the platform should validate at minimum:

```text
valid units
finite coordinates
supported axis conventions
valid transforms
no NaN / Infinity
scale within allowed range
asset dimensions plausible
host object exists
object remains within required room/host context
collision constraints
floor/wall/ceiling attachment consistency
```

AI output that fails these rules must not reach production execution.

---

## 41. Plausibility Guards

The validator should detect obvious scale mistakes.

Examples:

```text
Sofa width = 3.2 mm       → reject / probable unit error
Door height = 2,100,000mm → reject / probable unit error
Room height = 300 mm      → reject / require review
Camera height = 15,000mm  → unusual / require context
```

Thresholds should be category-aware and configurable rather than globally hard-coded.

---

## 42. AI Spatial Output Policy

AI may propose spatial relationships such as:

```text
Place sofa facing TV wall
Center dining table in dining zone
Move chair closer to coffee table
Use elevation for window height
```

AI should not be trusted as the final authority for raw transforms.

Preferred flow:

```text
AI Intent
   ↓
Spatial Planner
   ↓
Constraint Solver
   ↓
Canonical Transform
   ↓
Validator
   ↓
SceneChangeSet
```

---

## 43. Deterministic Placement over Pixel Matching

The system should avoid reproducing reference-image furniture locations by approximate pixels when architectural geometry is available.

References may inform layout intent.

Actual placement should resolve against:

```text
room geometry
asset dimensions
clearance constraints
focal points
openings
circulation
approved user intent
```

---

## 44. OpenUSD Future Mapping

OpenUSD integration may later map SceneSpec transforms into USD xforms.

SceneSpec should remain semantic while USD provides scene interchange/composition capabilities.

The platform must maintain a documented conversion layer rather than making USD-specific transform behavior leak into domain rules.

---

## 45. Renderer Independence

Corona and V-Ray must receive equivalent world geometry from the same SceneSpec.

Renderer adapters may differ in:

- materials
- lights
- render settings

They must not independently reinterpret architectural scale or object transforms.

---

## 46. Spatial Metadata on DCC Objects

Generated 3ds Max objects should retain machine-readable metadata where practical.

Example metadata:

```text
sceneSpecObjectId
assetId
spaceId
hostId
sourceRevision
```

This supports synchronization and revision safety.

---

## 47. Round-Trip Testing

Spatial conversion requires automated fixtures.

Required test cases should include:

```text
1 m CAD line → 1000 mm SceneSpec → expected Max length
known wall coordinates → expected Max coordinates
asset +Y forward → correct rendered orientation
90° rotation → expected orientation
floor pivot → Z = floor elevation
wall-mounted anchor → correct wall position
plan + elevation registration → expected alignment
```

---

## 48. Golden Spatial Fixture

Create a small canonical test room such as:

```text
Room: 5000 × 4000 × 3000 mm
Door: 900 × 2100 mm
Window: 1800 × 1500 mm
Window sill: 750 mm
Sofa: 2200 × 900 × 800 mm
Camera height: 1500 mm
```

The same fixture should be represented in:

```text
SceneSpec
3ds Max
CAD fixture
optional USD fixture later
```

Automated tests must confirm consistent scale and orientation.

---

## 49. Failure Policy

If unit or coordinate interpretation is ambiguous, the platform must not silently guess for production geometry.

Allowed outcomes:

```text
resolved automatically with strong evidence
provisional with visible assumption
requires user confirmation
blocked from execution
```

Architectural correctness has higher priority than silently completing a scene.

---

## 50. Initial Implementation Decisions

For the first prototype:

```text
Canonical linear unit: mm
Canonical up axis: +Z
Canonical handedness: right-handed
Canonical asset forward: +Y
Rotation display unit: degrees
Default scale: [1,1,1]
Initial level elevation: 0 mm
Production transforms: deterministic and explicit
```

These decisions should be changed only through an ADR if implementation evidence shows a strong reason.

---

## 51. First Prototype Acceptance Criteria

Before moving beyond the initial SceneSpec → 3ds Max proof, the system must demonstrate:

- a 5000 mm wall becomes exactly 5000 mm in the generated scene
- a 3000 mm room height is preserved
- an asset with declared dimensions imports at expected scale
- an asset facing `+Y` appears in the expected direction
- a `90°` Z rotation behaves consistently
- floor-standing objects land on floor elevation
- camera position and target reproduce correctly
- rerunning the same SceneSpec produces equivalent transforms
- unit settings from a previous 3ds Max session do not change results

---

## 52. Relationship to Other Documents

This document depends on:

```text
SCENE-SPEC-v0.1.md
INPUT-EVIDENCE-MODES.md
EVIDENCE-PROVENANCE-AND-CONFIDENCE.md
AI-ORCHESTRATION-RELIABILITY.md
```

Future documents will build on these conventions:

```text
OBJECT-IDENTITY-AND-REVISION-MODEL.md
SCENE-CHANGESET-SPEC.md
VALIDATION-ENGINE.md
3DS-MAX-WORKER-ARCHITECTURE.md
ASSET-LIBRARY-ARCHITECTURE.md
PLACEMENT-AND-CONSTRAINT-ENGINE.md
```

---

## 53. Guiding Principle

> A spatial value should mean the same physical thing everywhere in the platform.

If a wall is `5000 mm` long in SceneSpec, it must remain `5000 mm` when extracted from CAD, validated by the platform, created in 3ds Max, revised later, and rendered through any supported renderer.
