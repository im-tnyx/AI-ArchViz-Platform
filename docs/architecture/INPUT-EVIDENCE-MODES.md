# Input Evidence Modes

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform

## 1. Purpose

AI ArchViz Platform must not require one fixed input package for every project.

Real architectural work arrives in different levels of completeness. Some projects may have only a floor plan and visual references, while others may include floor plans, elevations, sections, detailed dimensions, existing 3D files, or a combination of these.

The platform therefore treats project inputs as **evidence** with different authority levels rather than as a single mandatory file set.

The initial production workflows must support both:

```text
Mode A
Plan + Reference Images
```

and:

```text
Mode B
Plan + Elevation(s) + Reference Images
```

Reference images are valid in both conditions.

---

## 2. Core Principle

Different input types answer different questions.

```text
Plan
→ horizontal architectural geometry

Elevation
→ vertical architectural geometry and wall composition

Section
→ heights, levels, ceiling relationships, slabs and vertical construction

Reference Images
→ design intent, style, materials, furniture direction and visual language

User Instructions
→ explicit project decisions and overrides
```

No input type should silently replace another input type outside its area of authority.

Example:

```text
Plan says wall length = 5200 mm
Reference image visually suggests a shorter wall

Result:
Plan dimension wins.
```

Another example:

```text
Elevation says TV panel height = 2400 mm
Reference image shows a similar panel with a different proportion

Result:
Elevation dimension wins.
Reference still influences material, detailing and styling.
```

---

## 3. Mode A: Plan + Reference Images

This mode is intended for projects where a floor plan is available but elevations are not available.

### Inputs

Possible plan sources:

- DWG
- DXF
- vector PDF
- scanned PDF
- image floor plan
- manually entered dimensions

Design references may include:

- interior reference images
- Pinterest-style references
- previous project renders
- furniture references
- material references
- ceiling references
- lighting references
- joinery references

### What the system can determine strongly

From the plan:

- room boundaries
- wall lengths
- wall positions
- doors
- windows where represented
- columns
- circulation
- furniture blocks where represented
- room labels
- plan-level dimensions

### What may require inference or user confirmation

Without elevation data, the system may not know with architectural certainty:

- ceiling height
- exact window sill height
- exact window head height
- door height
- false ceiling drops
- wall panel heights
- TV unit vertical composition
- wardrobe height
- cornice details
- vertical grooves
- wall moulding proportions
- switch/socket positions

These values must be represented as one of:

```text
verified
inferred
assumed
user_confirmed
```

They must never be silently treated as verified architectural truth.

### Mode A pipeline

```text
Plan
  +
Reference Images
  +
User Instructions
      ↓
Plan Parsing
      ↓
Reference Analysis
      ↓
Horizontal Geometry
      ↓
Vertical Assumptions / Defaults / User Decisions
      ↓
SceneSpec
      ↓
Editable 3D Scene
```

### Recommended behaviour

The platform should be capable of generating a useful first 3D scene even when elevations are missing.

For uncertain vertical values, the system should prefer:

1. explicit user value
2. project standard/default supplied by the user
3. previously approved value in the same project
4. rule-based architectural default
5. AI inference from evidence

Any inferred or defaulted value must preserve provenance.

---

## 4. Mode B: Plan + Elevation(s) + Reference Images

This is the preferred higher-accuracy workflow when architectural elevations are available.

### Inputs

```text
Floor Plan
+
One or More Elevations
+
Reference Images
+
User Instructions
```

Elevations may arrive as:

- DWG
- DXF
- vector PDF
- scanned PDF
- image export
- manually annotated drawing

### Additional information elevations can provide

- floor-to-ceiling height
- door height
- window sill height
- window head height
- wall panel proportions
- false ceiling drops
- niches
- shelves
- cabinetry composition
- TV wall composition
- headboard wall composition
- wall moulding
- skirting
- decorative profiles
- vertical material boundaries
- light locations where documented

### Mode B pipeline

```text
Floor Plan
    +
Elevation(s)
    +
Reference Images
    +
User Instructions
        ↓
Plan Parsing
        ↓
Elevation Parsing
        ↓
Reference Analysis
        ↓
Cross-View Registration
        ↓
Validated Horizontal + Vertical Geometry
        ↓
SceneSpec
        ↓
Editable 3D Scene
```

### Accuracy rule

When plan and elevation both describe the same object, the platform should merge their responsibilities rather than choose one entire drawing over the other.

Example:

```text
Plan
→ wall location and length

Elevation
→ wall height and vertical design

Reference
→ material and style direction
```

---

## 5. Reference Images in Both Modes

Reference images are intentionally supported in both Mode A and Mode B.

Their purpose is not to replace architectural drawings.

References can influence:

- design style
- color palette
- furniture language
- wall finish
- flooring direction
- ceiling character
- lighting mood
- joinery design language
- decorative density
- curtains
- soft furnishings
- material combinations
- visual hierarchy

A project may contain multiple reference groups.

Example:

```json
{
  "referenceGroups": [
    {
      "id": "ref_group_tv_wall",
      "scope": "wall_tv_main",
      "purpose": ["design", "material", "composition"]
    },
    {
      "id": "ref_group_sofa",
      "scope": "asset_sofa_main",
      "purpose": ["asset_style", "fabric", "proportion"]
    },
    {
      "id": "ref_group_global",
      "scope": "space_living",
      "purpose": ["style", "palette", "lighting_mood"]
    }
  ]
}
```

This allows different references to control different parts of a project instead of averaging every image into one vague style.

---

## 6. Evidence Authority Model

The platform should use an explicit evidence hierarchy.

Suggested default priority:

```text
1. User-approved explicit dimensions
2. Verified CAD / drawing dimensions
3. Registered plan/elevation geometry
4. Existing approved 3D geometry
5. Project standards and approved defaults
6. Reference-image interpretation
7. AI inference
8. Generic fallback assumptions
```

Priority can vary by property.

For example:

### Wall length

```text
Plan dimension > CAD geometry > manual measurement > image inference
```

### Wall panel material

```text
User instruction > approved material reference > elevation note > style inference
```

### Ceiling height

```text
Section/elevation dimension > user value > project default > inference
```

The evidence system should therefore be property-aware rather than globally ranking complete files.

---

## 7. Confidence and Provenance

Every inferred project value should be traceable.

Example:

```json
{
  "value": 3000,
  "unit": "mm",
  "status": "inferred",
  "confidence": 0.78,
  "provenance": {
    "sourceType": "reference_image",
    "sourceId": "ref_living_03",
    "method": "visual_estimation"
  }
}
```

A verified drawing value may look like:

```json
{
  "value": 3150,
  "unit": "mm",
  "status": "verified",
  "confidence": 1.0,
  "provenance": {
    "sourceType": "elevation_dwg",
    "sourceId": "elevation_a_02",
    "entityId": "dim_8172"
  }
}
```

This becomes essential when client revisions arrive later.

---

## 8. Missing-Information Policy

Missing information should not always stop scene generation.

The platform should classify missing values into:

```text
BLOCKING
IMPORTANT
OPTIONAL
```

### BLOCKING

Scene cannot be reliably built without resolution.

Examples:

- unknown plan scale when no dimension is available
- ambiguous room boundary
- conflicting verified dimensions

### IMPORTANT

Scene may be generated with an assumption, but the assumption should be visible.

Examples:

- ceiling height
- window sill height
- door height

### OPTIONAL

Can safely use a design default or reference-driven choice.

Examples:

- decorative object selection
- cushion arrangement
- small decor placement

---

## 9. Progressive Accuracy

A key product capability should be **progressive accuracy**.

A user may begin with:

```text
Plan + References
```

The platform creates SceneSpec v1.

Later the user receives elevations:

```text
Plan + Elevations + References
```

The same project should be upgraded rather than recreated.

Expected flow:

```text
Existing SceneSpec
      +
New Elevation Evidence
      ↓
Evidence Reconciliation
      ↓
Affected Property Detection
      ↓
Revision Proposal
      ↓
Geometry Update
      ↓
Asset / Material Impact Check
      ↓
Re-render Affected Cameras
```

This is important for real-world workflows because architectural information often arrives gradually.

---

## 10. Revision Example

Initial project:

```text
Plan + References
```

The system assumes:

```text
ceilingHeight = 3000 mm
status = assumed
```

Later an elevation is uploaded showing:

```text
ceilingHeight = 3250 mm
status = verified
```

The platform should not rebuild the project blindly.

It should identify affected items:

- walls
- ceiling
- curtains
- wardrobes
- wall panels
- camera framing
- vertical lights

Then apply a controlled revision.

---

## 11. Future Evidence Modes

The same architecture should later support:

### Mode C

```text
Plan + Elevation + Section + References
```

### Mode D

```text
Existing 3D Scene + References + Revision Instructions
```

### Mode E

```text
IFC / Revit + References
```

### Mode F

```text
LiDAR / Point Cloud + Drawings + References
```

### Mode G

```text
Site Photos / 360 Capture + Plan + References
```

These should all normalize into the same `SceneSpec` evidence model.

---

## 12. SceneSpec Requirements

`SceneSpec` must be able to record:

- source files
- source type
- input mode
- reference groups
- drawing view type
- plan/elevation/section relationships
- evidence provenance
- confidence
- verification status
- assumptions
- unresolved conflicts
- user approvals
- affected properties after new evidence arrives

Suggested project input block:

```json
{
  "inputMode": "plan_elevation_references",
  "sources": [
    {
      "id": "src_plan_01",
      "type": "floor_plan",
      "format": "dwg"
    },
    {
      "id": "src_elev_01",
      "type": "elevation",
      "orientation": "north",
      "format": "pdf"
    },
    {
      "id": "ref_global_01",
      "type": "reference_image",
      "purpose": ["style", "materials"]
    }
  ]
}
```

---

## 13. Product UX Direction

The UI should not force users to understand technical input modes manually.

A project creation screen can simply accept:

```text
Upload Floor Plan
Upload Elevations (optional)
Upload Sections (optional)
Upload Reference Images
Add Instructions
```

The backend determines the active evidence mode automatically.

Example:

```text
Floor plan found
References found
No elevations found

Detected workflow:
PLAN + REFERENCES
```

or:

```text
Floor plan found
3 elevations found
5 references found

Detected workflow:
PLAN + ELEVATIONS + REFERENCES
```

---

## 14. Core Product Requirement

The platform must be useful at different documentation maturity levels.

It should not require full construction drawings before useful work can begin.

At the same time, it must automatically become more accurate when stronger architectural evidence is added.

The intended behaviour is:

```text
Less Drawing Evidence
→ More Explicit Assumptions

More Drawing Evidence
→ Fewer Assumptions
→ Higher Geometric Accuracy
```

This allows the same project to move from early design visualization to increasingly accurate production visualization without changing the underlying platform model.
