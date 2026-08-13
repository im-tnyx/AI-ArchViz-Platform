# AI Evals & Golden Dataset Strategy

**Status:** Testing Architecture Draft  
**Version:** `0.1.0`  
**Project:** AI ArchViz Platform

---

## 1. Purpose

The platform must choose AI models based on measured ArchViz performance rather than brand preference, general benchmarks, or subjective impressions.

This document defines the evaluation system used to answer questions such as:

- Which model extracts floor-plan information most accurately?
- Which model understands elevations best?
- Which model follows reference images most reliably?
- Which model ranks assets correctly?
- Which model interprets revision instructions with the fewest dangerous mistakes?
- Which model gives the best camera or render critique?
- When should a cheaper/faster model be used instead of a larger model?
- Does a new model version improve our production workflow or regress it?

---

## 2. Core Principle

> A model is not promoted because it is newer. It is promoted because it performs better on our validated ArchViz tasks.

Every AI-assisted production task must eventually have:

```text
Task Definition
+
Input Dataset
+
Expected Output / Acceptance Rules
+
Scoring Function
+
Failure Classification
+
Baseline Model
```

---

## 3. Golden Dataset

A `Golden Dataset` is a curated set of project examples with trusted expected results.

The first dataset should contain real or carefully constructed ArchViz scenarios rather than generic AI tests.

Suggested initial structure:

```text
tests/golden/
├── floor-plan-vector/
├── floor-plan-raster/
├── plan-elevation/
├── references/
├── asset-ranking/
├── placement/
├── camera-ranking/
├── render-critique/
└── revision-intent/
```

---

## 4. Dataset Categories

### 4.1 Vector Floor Plans

Initial target: `10+` cases.

Each case should include:

```text
source.pdf or source.dxf
expected-spaces.json
expected-openings.json
expected-dimensions.json
notes.md
```

Measure:

- room detection
- dimension accuracy
- door/window association
- label extraction
- geometry relationship accuracy

### 4.2 Raster / Scanned Plans

Initial target: `10+` cases.

Include difficult examples:

- low contrast
- rotated page
- dimension clutter
- handwritten markups
- multiple line weights
- partial scans

Measure both extraction accuracy and uncertainty reporting.

A model should be penalized more for confidently inventing a wrong dimension than for correctly returning `unknown`.

### 4.3 Plan + Elevation

Initial target: `10+` projects.

Test:

- correct plan/elevation association
- wall identity matching
- height extraction
- opening heights
- joinery dimensions
- ceiling information
- evidence conflict handling

### 4.4 Reference Analysis

Initial target: `20+` reference sets.

Expected labels may include:

```text
style
palette
material categories
furniture characteristics
lighting mood
wall treatment
ceiling language
decor density
```

Avoid demanding false precision from subjective visual categories.

### 4.5 Asset Ranking

Initial target: `20+` tasks.

For each task provide:

- user/design intent
- room dimensions
- already hard-filtered asset candidates
- expected ranking bands

AI should only rank candidates after deterministic filters such as category, dimensions, renderer compatibility, and availability.

### 4.6 Placement

Initial target: `20+` scenarios.

Measure:

- no collision
- no door blockage
- circulation clearance
- room containment
- orientation toward focal point
- functional relationship with surrounding objects

Placement scoring must combine deterministic geometry checks with optional human design review.

### 4.7 Camera Ranking

Initial target: `20+` scenes with multiple candidate previews.

Measure agreement with approved architectural-photography choices:

```text
composition
verticals
subject visibility
room coverage
focal clarity
clutter
camera plausibility
```

### 4.8 Render Critique

Initial target: `20+` renders containing known defects.

Defect categories:

```text
missing texture
black material
asset collision
bad exposure
clipping
poor composition
reference mismatch
unrealistic scale
repeated assets
lighting imbalance
```

### 4.9 Revision Intent

Initial target: `20+` realistic revision instructions.

Example:

```text
"Sofa change कर दो लेकिन TV wall और camera same रहने चाहिए."
```

Expected structured interpretation:

```json
{
  "actions": [
    {
      "type": "replace_asset",
      "targetObjectId": "obj_sofa_main"
    }
  ],
  "locks": [
    "obj_tv_wall",
    "camera_current"
  ]
}
```

The most dangerous error is changing an explicitly protected object.

---

## 5. Scoring Dimensions

Each task can use a weighted subset of:

```text
Accuracy
Completeness
Hallucination Rate
Schema Validity
Evidence Grounding
Constraint Compliance
Safety / Protected-Field Compliance
Consistency
Latency
Cost
Retry Rate
Fallback Rate
```

---

## 6. Reliability Score

Conceptual score:

```text
Reliability =
  Successful Valid Outputs
  / Total Attempts
```

But production reliability must also track severity.

One architectural hallucination may be more serious than several harmless classification errors.

---

## 7. Severity-Weighted Errors

Suggested severity classes:

### `S0` Informational

Example:

- slightly different style label

### `S1` Minor

Example:

- lower-ranked decor candidate

### `S2` Production Quality

Example:

- poor camera ranking
- weak material classification

### `S3` Spatial Error

Example:

- furniture collision
- blocking circulation

### `S4` Architectural / Safety-Critical for Project Integrity

Example:

- wrong verified dimension
- moving locked wall
- ignoring approved door/window location
- applying revision to wrong object

A model with a lower average score but zero `S4` errors may be preferable to a model with higher average quality and occasional destructive errors.

---

## 8. Hallucination Metric

Track unsupported factual claims separately.

```text
HallucinationRate =
Unsupported Structured Facts
/
All Structured Facts
```

Important architectural examples:

- invented dimensions
- invented room labels
- invented elevation details
- claiming a source contains evidence that is absent

Models should be rewarded for explicit uncertainty.

---

## 9. Unknown Is a Valid Answer

Production prompts and schemas should allow:

```text
unknown
ambiguous
not_visible
not_provided
requires_confirmation
```

Do not force models to fill every field.

Example:

```json
{
  "ceilingHeight": {
    "value": null,
    "status": "not_provided",
    "requiresConfirmation": true
  }
}
```

This is safer than inventing `3000 mm` and presenting it as extracted truth.

---

## 10. Provider Benchmark Matrix

Maintain a generated comparison table per release cycle.

Conceptual format:

| Task | Model | Quality | Reliability | S4 Errors | Latency | Cost | Status |
|---|---|---:|---:|---:|---:|---:|---|
| Reference Analysis | Provider A / Model X | ... | ... | ... | ... | ... | Qualified |
| Plan Extraction | Provider B / Model Y | ... | ... | ... | ... | ... | Qualified |

Do not manually maintain scores in architecture documentation. Generate them from evaluation runs.

---

## 11. Qualification Levels

### `Research`

Can be tested but not used on production projects.

### `Shadow`

Runs beside production model but cannot influence scene changes.

### `Preview`

May create suggestions/previews only.

### `Production-Approved`

May be used for its qualified task under normal validators.

### `Auto-Apply-Approved`

Only for low-risk tasks with sufficient reliability evidence.

A model can be `Production-Approved` for reference analysis and only `Research` for plan extraction.

---

## 12. Task Qualification, Not Model Qualification

Never globally label a model as "production safe".

Qualification must be task-specific.

Example:

```text
Model X
ReferenceAnalysis: Production-Approved
RevisionIntent: Production-Approved
RasterPlanExtraction: Shadow
CameraCritique: Preview
```

---

## 13. Regression Gates

A provider/model/prompt/schema change fails promotion if it causes unacceptable regression.

Possible gates:

```text
No increase in S4 errors
No protected-field violations
Schema validity ≥ required threshold
Hallucination rate ≤ required threshold
Task quality ≥ baseline
Latency within operational budget
Cost within task budget
```

Exact thresholds should be decided from empirical testing rather than guessed now.

---

## 14. Prompt Versioning

Every eval run records:

```text
provider
model
promptTemplateVersion
schemaVersion
validatorVersion
datasetVersion
runDate
runtime settings
```

A model comparison without prompt/schema versions is not reproducible.

---

## 15. Evaluation Runner

Future package:

```text
packages/ai-evals/
```

Possible responsibilities:

```text
Load Dataset
Run Task Adapter
Validate Schema
Run Domain Grader
Compute Metrics
Store Results
Compare Baseline
Generate Report
```

Conceptual command:

```bash
pnpm ai-evals run --task reference-analysis --providers openai,gemini
```

---

## 16. Deterministic Graders First

Prefer deterministic grading when possible.

Examples:

```text
Numeric dimension tolerance
Exact object ID
Collision yes/no
Inside room polygon yes/no
Locked object modified yes/no
Schema valid yes/no
Material category in expected set
```

Use AI graders only for genuinely subjective dimensions such as visual composition or style similarity, and calibrate them against human ratings.

---

## 17. Human Review Dataset

Some ArchViz quality cannot be reduced to exact labels.

For subjective tasks maintain human-reviewed examples.

Possible rating dimensions:

```text
Reference fidelity
Composition
Design coherence
Material plausibility
Lighting quality
Professional usability
```

Use multiple reviews for important benchmark sets when practical.

---

## 18. Production Feedback Loop

With permission and proper privacy handling, production outcomes can improve future evals.

Useful signals:

```text
User accepted proposal
User rejected proposal
User replaced AI-selected asset
Manual correction after extraction
Validator rejection
Rollback after execution
Final approved camera
Final approved material
```

Do not silently treat every production action as training truth. Curate high-quality examples before adding them to golden data.

---

## 19. Failure Corpus

Maintain a dedicated set of past failures.

```text
tests/failures/
```

Whenever a meaningful bug occurs:

1. save a minimal reproducible input
2. record incorrect output
3. define expected behavior
4. add regression test

The system should become harder to break over time.

---

## 20. Initial Evaluation Milestone

Before AI is allowed to influence a real 3ds Max scene, complete at least these eval tracks:

```text
ReferenceAnalysis
RevisionIntent
AssetRanking
```

Plan/elevation AI extraction may initially operate in assisted or shadow mode until enough drawing data exists.

The first deterministic 3D pipeline should work independently of AI.

---

## 21. Provider Upgrade Procedure

When a new model is released:

```text
Register Model
↓
Run Golden Dataset
↓
Compare Baseline
↓
Inspect Severe Failures
↓
Shadow Mode
↓
Limited Preview
↓
Promote Per Task
```

No production provider swap should happen from marketing claims alone.

---

## 22. Final Principle

The question is not:

```text
Which AI company is best?
```

The useful question is:

```text
Which qualified model currently performs this specific ArchViz task best under our quality, reliability, latency and cost requirements?
```

The answer is allowed to change over time without changing the platform architecture.
