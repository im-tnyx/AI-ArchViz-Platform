# Evidence, Provenance & Confidence Architecture

**Status:** Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform  
**Purpose:** Define how the platform decides which architectural facts are trusted, inferred, disputed, provisional, or blocked from production execution.

---

## 1. Why This Exists

AI ArchViz Platform can receive project information from many different sources:

- DWG / DXF
- vector PDF plans
- scanned floor plans
- elevations
- sections
- manual dimensions
- user instructions
- reference images
- existing 3ds Max scenes
- asset metadata
- AI visual inference

These sources do not have equal authority.

The platform must never treat all detected values as equally correct.

A professional production system needs to answer:

- Where did this value come from?
- Was it explicitly stated or inferred?
- How reliable is the source?
- Has a human approved it?
- Does another source disagree?
- Is the value safe to use for production geometry?
- Can AI override it?

This document defines those rules.

---

## 2. Core Principle

> Every production-relevant fact must carry provenance, confidence, authority, and validation state.

The system must be able to explain why it believes a wall is 5200 mm long, why a ceiling is 3000 mm high, or why a TV panel should use travertine.

No important value should silently appear inside `SceneSpec` without traceable evidence.

---

## 3. Evidence Is Not the Same as Truth

An input is evidence.

Truth is the currently accepted project state after evidence is evaluated.

Example:

```text
Reference image visually suggests 2800 mm ceiling
Elevation explicitly dimensions ceiling at 3050 mm

Accepted architectural truth:
3050 mm
```

The reference remains useful for style, proportion, material, and visual intent, but it does not override measured architectural geometry.

---

## 4. Evidence Source Types

Initial source types:

```text
user_explicit
cad_dimension
cad_geometry
vector_drawing
manual_measurement
elevation_dimension
section_dimension
approved_existing_scene
approved_asset_metadata
pdf_text
pdf_geometry
reference_image
site_photo
ai_inference
system_default
```

Future sources may include:

```text
revit
ifc
point_cloud
lidar
photogrammetry
survey_data
bim_property
manufacturer_data
```

---

## 5. Authority Levels

Each piece of evidence receives an authority class.

### A0 — System Default

Fallback only.

Examples:

- default ceiling height
- default wall thickness
- default camera height

Must never silently override real project evidence.

### A1 — AI / Visual Inference

Estimated from images, incomplete drawings, visual reasoning, or probabilistic interpretation.

Examples:

- estimated ceiling height from reference image
- guessed material category
- inferred cabinet depth

Useful for proposals, not architectural truth unless explicitly approved.

### A2 — Derived Geometry

Calculated from reasonably reliable source geometry.

Examples:

- room width derived from validated plan geometry
- opening width calculated between known vertices

Can be production-usable when validation passes.

### A3 — Explicit Drawing Data

Directly represented by authoritative project documents.

Examples:

- CAD dimension entity
- elevation dimension
- section level
- written drawing note

High authority.

### A4 — Explicit User / Designer Decision

A user deliberately confirms or overrides a project value.

Examples:

- "Ceiling height is 3150 mm"
- approved TV wall width
- selected sofa asset

Must be recorded with timestamp and author identity where available.

### A5 — Locked / Approved Production Truth

Value has passed validation and been explicitly locked for production.

Examples:

- approved room boundary
- frozen door location
- approved final ceiling design
- client-approved material selection

AI cannot override this level automatically.

---

## 6. Default Evidence Priority

For architectural geometry, default priority is:

```text
Locked Production Truth
        >
Explicit User / Designer Decision
        >
Explicit Drawing Dimension
        >
Validated CAD Geometry
        >
Validated Derived Geometry
        >
Visual / AI Inference
        >
System Default
```

This priority can vary by domain.

For example, reference images may be stronger than CAD for **style intent**, but weaker for **wall length**.

---

## 7. Domain-Specific Authority

Evidence authority must depend on what question is being answered.

### Architectural Geometry

Preferred evidence:

```text
Plan / Elevation / Section / CAD / Explicit Dimensions
```

Reference images are low authority.

### Materials and Style

Preferred evidence:

```text
Explicit User Selection
Approved Material Schedule
Reference Images
Designer Instructions
```

CAD geometry usually has little authority here.

### Furniture Selection

Preferred evidence:

```text
Explicit Asset Selection
Approved Furniture Schedule
Reference Intent
Asset Library Match
```

### Lighting Mood

Preferred evidence:

```text
User Intent
Approved Reference
Lighting Design Data
AI Interpretation
```

### Exact Luminaire Location

Preferred evidence:

```text
Ceiling Plan
Elevation
Lighting Drawing
Explicit User Decision
```

---

## 8. Provenance Record

Every important value should be able to carry a provenance record.

Example:

```json
{
  "value": 3050,
  "unit": "mm",
  "provenance": {
    "sourceType": "elevation_dimension",
    "sourceId": "drawing_elevation_01",
    "page": 2,
    "entityId": "dim_4821",
    "authority": "A3",
    "confidence": 1.0,
    "validationState": "validated"
  }
}
```

For AI inference:

```json
{
  "value": 3000,
  "unit": "mm",
  "provenance": {
    "sourceType": "ai_inference",
    "sourceId": "reference_03",
    "authority": "A1",
    "confidence": 0.62,
    "validationState": "provisional",
    "modelTask": "estimate_ceiling_height"
  }
}
```

---

## 9. Confidence Is Not Authority

This distinction is mandatory.

A model may be 95% confident and still have low authority.

Example:

```text
AI confidence = 0.95
Source authority = A1

CAD dimension authority = A3

Result:
CAD wins.
```

Confidence answers:

> How certain is this extraction or inference?

Authority answers:

> How much power is this source allowed to have over project truth?

These must never be combined into one number.

---

## 10. Confidence Bands

Suggested initial interpretation:

```text
0.90 - 1.00  High confidence
0.75 - 0.89  Good confidence
0.50 - 0.74  Uncertain
0.25 - 0.49  Weak inference
0.00 - 0.24  Unreliable
```

These bands are not enough by themselves to decide execution.

Execution must consider:

```text
Authority
+
Confidence
+
Validation State
+
Conflict State
+
Risk Class
```

---

## 11. Validation States

Every important inferred or extracted fact can move through:

```text
unreviewed
provisional
validated
approved
locked
rejected
superseded
```

Typical lifecycle:

```text
Detected
  ↓
Provisional
  ↓
Validated
  ↓
Approved
  ↓
Locked
```

A later stronger source may mark older evidence as `superseded` without deleting its history.

---

## 12. Conflict Detection

The system must explicitly detect disagreement.

Example:

```text
Plan dimension: 5200 mm
CAD derived geometry: 5198 mm
```

This may be acceptable within tolerance.

But:

```text
Plan dimension: 5200 mm
Elevation dimension: 4800 mm
```

This is a real conflict and must not be silently averaged.

Conflict record example:

```json
{
  "conflictId": "conflict_wall_12_length",
  "property": "length",
  "candidates": [
    {
      "value": 5200,
      "source": "plan_01",
      "authority": "A3"
    },
    {
      "value": 4800,
      "source": "elevation_02",
      "authority": "A3"
    }
  ],
  "resolutionState": "needs_review"
}
```

---

## 13. Tolerance-Based Reconciliation

Not every numeric difference is a conflict.

Geometry engines should support tolerances.

Examples:

```text
5200 mm vs 5199.5 mm
→ likely same value

5200 mm vs 5190 mm
→ investigate based on source and drawing precision

5200 mm vs 4800 mm
→ material conflict
```

Tolerance must depend on data source and domain.

Do not use one global tolerance for everything.

---

## 14. Missing Evidence

Missing data must be represented explicitly.

Never invent a final value only because the schema requires one.

Example:

```json
{
  "ceilingHeight": {
    "state": "unknown",
    "recommendedDefault": 3000,
    "requiresConfirmation": true
  }
}
```

The platform may still continue in planning mode using a provisional value.

---

## 15. Provisional Geometry

Plan-only projects will often need provisional vertical geometry.

Example:

```text
Plan available
Elevation unavailable
Ceiling height unknown
```

Allowed workflow:

```text
Use configurable provisional height
Mark geometry as provisional
Allow design work and previews
Prevent silent promotion to locked production truth
Replace when elevation / confirmed dimension arrives
```

This supports real-world incomplete projects without pretending uncertain information is exact.

---

## 16. Reference Image Evidence

Reference images can be authoritative for design intent when explicitly approved.

They can strongly influence:

- style
- palette
- material family
- furniture character
- wall treatment language
- ceiling language
- lighting mood
- decor density

They should not automatically define:

- room dimensions
- wall lengths
- door sizes
- exact window positions
- structural geometry

unless no better evidence exists and the result is clearly marked provisional.

---

## 17. AI Output Rules

AI output must always identify what is:

```text
observed
extracted
inferred
assumed
recommended
```

These are different states.

Example:

```json
{
  "material": "travertine",
  "claimType": "inferred",
  "confidence": 0.84,
  "sourceIds": ["reference_01"]
}
```

AI must never phrase an inference as verified project fact inside machine-readable output.

---

## 18. User Override Rules

Users may override extracted or inferred values.

Every override should record:

```text
old value
new value
reason if available
user identity
Timestamp
affected objects
source evidence
```

An explicit user override should normally outrank automated inference.

However, dangerous structural inconsistencies should still trigger validation warnings.

---

## 19. Locked Facts

Some project facts become locked after approval.

Examples:

```text
room boundary
ceiling height
door position
window dimensions
approved furniture asset
approved material
camera selected for final render
```

A locked fact cannot be modified by AI automatically.

Change requires a deliberate revision operation.

---

## 20. Evidence Graph

Long term, project evidence should form a traceable graph.

```text
Drawing / Reference / User Decision
              ↓
            Claim
              ↓
         Validation
              ↓
      Accepted Scene Fact
              ↓
         Scene Object
              ↓
           Render
```

This allows the system to explain:

> Why is this wall here?

or:

> Why did this cabinet change after the elevation was uploaded?

---

## 21. Progressive Accuracy

The platform must support increasing evidence quality without rebuilding the project from zero.

Example:

```text
Stage 1
Plan + References
→ provisional vertical design

Stage 2
Elevation added
→ replace affected provisional heights/details

Stage 3
Section added
→ validate ceiling and level relationships

Stage 4
Client approval
→ lock accepted geometry
```

New evidence should produce a targeted `SceneChangeSet`, not an uncontrolled full regeneration.

---

## 22. Execution Gate

Before production mutation, the platform should evaluate:

```text
Does this value have sufficient authority?
Is confidence acceptable?
Is the claim validated?
Is there unresolved conflict?
Does the target object contain locked properties?
Is the proposed change reversible?
What downstream objects/renders are affected?
```

Only then should a deterministic engine execute the change.

---

## 23. Suggested SceneSpec Integration

A future `SceneSpec` property may support:

```json
{
  "height": {
    "value": 3050,
    "unit": "mm",
    "state": "approved",
    "provenance": {
      "sourceType": "elevation_dimension",
      "sourceId": "elev_01",
      "authority": "A3",
      "confidence": 1.0
    }
  }
}
```

Not every low-level property must carry the full object inline.

Implementation may use normalized provenance IDs to avoid duplication.

---

## 24. AI Provider Independence

Provenance must never depend on provider-specific response formats.

Provider adapters should normalize outputs into platform types.

Example:

```text
OpenAI
Gemini
Claude
xAI
Future Provider
    ↓
Provider Adapter
    ↓
Normalized Claim
    ↓
Evidence / Provenance Engine
```

This keeps project truth independent of AI vendor changes.

---

## 25. Auditability

For production projects, the system should eventually be able to answer:

- which input created a fact
- which AI model extracted or inferred it
- which validation rules ran
- whether a human approved it
- what changed it later
- which renders were created from which scene state

This will become increasingly valuable as automation increases.

---

## 26. Failure Policy

When evidence is insufficient, the system should prefer:

```text
Unknown
or
Provisional
```

over confidently invented project truth.

The platform is allowed to say:

```text
Ceiling height is not confirmed.
Using provisional 3000 mm for planning only.
```

It is not allowed to silently present the same value as verified architecture.

---

## 27. Initial MVP Rules

For the first Living Room / Bedroom MVP:

1. Plan dimensions and validated CAD geometry control horizontal architecture.
2. Elevation/section dimensions control vertical architecture when present.
3. Manual explicit dimensions override AI inference.
4. Reference images control design intent but not verified dimensions.
5. AI inference is provisional until validated.
6. Unknown dimensions remain explicitly unknown or provisional.
7. Conflicting high-authority inputs block automatic geometry mutation.
8. Approved objects and properties can be locked.
9. New stronger evidence generates targeted revisions.
10. Every production mutation must be reversible.

---

## 28. Relationship to Other Documents

This document works with:

```text
SCENE-SPEC-v0.1.md
INPUT-EVIDENCE-MODES.md
AI-ORCHESTRATION-RELIABILITY.md
ADR-0004 AI Proposes, Platform Validates
```

Future related documents:

```text
COORDINATES-UNITS-AND-SPATIAL-CONVENTIONS.md
OBJECT-IDENTITY-AND-REVISION-MODEL.md
SCENE-CHANGESET-SPEC.md
VALIDATION-ENGINE.md
```

---

## 29. Architecture Rule

> When the platform knows, it records the source. When it infers, it records uncertainty. When sources disagree, it records the conflict. When a user approves, it records the decision. Nothing important becomes production truth silently.
