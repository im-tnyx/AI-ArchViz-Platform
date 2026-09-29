# CAD Interpretation (architectural-extraction-v0.1)

## 1. Extraction vs interpretation

| Spike | Question | Output |
| --- | --- | --- |
| 10A ([CAD-INGESTION.md](CAD-INGESTION.md)) | What exactly exists in this CAD source? | `cad-document-v0.1` |
| 10B (this document) | Which architectural candidates follow deterministically from that evidence under an explicit, human-authored profile? | `architectural-extraction-v0.1` |

10B never answers "what should this drawing probably mean?". There is no
AI, no OCR, no fuzzy or case-insensitive matching, no layer-name guessing,
no DCC process, and no SceneSpec output.

```text
DXF bytes -> (10A) cad-document-v0.1
          -> + cad-interpretation-profile-v0.1 (human-authored)
          -> cad-interpretation-policy-v0.1 (software-owned algorithm)
          -> architectural-extraction-v0.1 (status READY_FOR_REVIEW)
          -> cad-interpretation-evidence-v0.1
```

## 2. Package boundary

`packages/cad-interpreter/` (`@ai-archviz/cad-interpreter`) depends only on
`@ai-archviz/cad-parser` (never the reverse), `ajv`, `json-canonicalize`,
and Node built-ins for reading its own schemas and hashing. It consumes only
`cad-document-v0.1`; it contains no DXF group-code, section, or table
parsing, and imports nothing from `apps/worker`, SceneSpec, DCC, renderers,
the network, or AI providers. Static unit guards enforce this.

The pure API is `interpretCadDocument(cadDocument, profile)`. It validates
both inputs against their schemas first, never mutates either, and returns
`architectural-extraction-v0.1`.

## 3. Policy vs profile

- **`cad-interpretation-policy-v0.1`** is the software-owned algorithm in
  this document. A profile names it exactly; there is no "latest".
- **`cad-interpretation-profile-v0.1`**
  (`schema/cad-interpretation-profile-v0.1.schema.json`) is declarative,
  human-authored data describing one CAD convention: `profileId`,
  `cadDocumentVersion: "0.1.0"`, exact layer roles (`spaceBoundary`,
  `spaceLabel`, `door`, `window`), one level (`levelCandidateId`, `name`,
  `elevationMm`, `defaultCeilingHeightMm`), `wallDefaults.wallThicknessMm`,
  exact label rules (`text` -> `spaceType`), and door/window block rules.
  Profile semantics also require one role per layer, unique rule IDs,
  unique label texts, and each block mapped at most once. Conventions are
  never discovered automatically.

## 4. Three authorities

Every candidate value carries field-level provenance with exactly one of
three authorities, and they are never mixed up:

| Authority | Meaning | Examples |
| --- | --- | --- |
| `cad` | read from cad-document evidence (`sourceOrdinal`, `sourceHandle`, `role`) | room boundary vertices, opening center, label text |
| `profile` | supplied by the human profile (`field`, `ruleId`) | ceiling height 3000, wall thickness 150, door width 900, window sill 900, space type mapping |
| `derived` | computed by the policy (`derivation`) | CCW normalization, wall edges, opening host, opening offset |

A profile default is never labeled as CAD-derived, and a derived host
relationship is never labeled as authored source data. No confidence
percentages exist.

## 5. Source classification

Every 10A entity is classified in `sourceOrdinal` order, and ends in
exactly one of: consumed evidence, `unconsumedEntities`, or a blocking
failure (`consumedEntityCount + unconsumedEntityCount == sourceEntityCount`).

- On a mapped layer, a 10A-unsupported entity fails closed
  (`CAD_INTERPRET_UNSUPPORTED_ENTITY_ON_MAPPED_LAYER`), and a supported
  entity of the wrong type for the role (for example a LINE on the
  boundary layer, or TEXT on the door layer) fails closed
  (`CAD_INTERPRET_ENTITY_ROLE_MISMATCH`).
- On an unmapped layer, entities are recorded in `unconsumedEntities` as
  `UNMAPPED_LAYER` (supported) or `UNSUPPORTED_SOURCE_ENTITY`
  (10A-unsupported), with ordinal, handle, type, and layer only.

## 6. Space boundaries

A space boundary is a closed LWPOLYLINE on the exact boundary layer with at
least 3 vertices, all bulges 0, CAD elevation equal to the profile level
elevation, and a simple, positive-area polygon:

- any nonzero bulge: `CAD_INTERPRET_SPACE_BOUNDARY_CURVED_UNSUPPORTED`
  (10A preserved bulges precisely so curves fail honestly instead of
  being flattened);
- open polyline, elevation mismatch, zero-length edge (including a repeated
  closing vertex), fewer than 3 distinct points, self-intersection or
  fold-back, zero area: `CAD_INTERPRET_SPACE_BOUNDARY_INVALID`;
- no boundary at all: `CAD_INTERPRET_SPACE_MISSING`.

**Winding.** Boundaries are normalized to counter-clockwise (positive
shoelace area, X east / Y north). A clockwise source is reversed keeping
its first vertex first (`[v0, vn-1, ..., v1]`), and the extraction records
`sourceWinding: "clockwise"` and `normalization:
"reversed_to_counter_clockwise"`; the transformation is never hidden.

**Multiple spaces.** Any number of spaces on the one configured level.
Candidates are ordered by the source boundary's `sourceOrdinal` (an
explicit rule; reordering source entities legitimately reorders
candidates). Positive-area overlap between any two spaces, including
identical or contained boundaries, is `CAD_INTERPRET_SPACE_OVERLAP`; no
"real room" is chosen. Touching along edges or at vertices is allowed.
Overlap is decided exactly by vertical slab decomposition of both edge
sets, so concave boundaries are handled without sampling heuristics.

## 7. Walls from boundary edges

Each normalized CCW edge `Pi -> Pi+1` produces one wall candidate with
`start = Pi`, `end = Pi+1`, `referenceLine: "interior_face"`, and
`thicknessDirection: "exterior_right_of_u"`.

Proof of the convention: for a counter-clockwise polygon the interior lies
to the LEFT of every directed edge `u = Pi+1 - Pi`. The edge is therefore
the interior face, and the wall body extends to its right, which is exactly
SceneSpec's `interior_face` / `exterior_right_of_u` wall convention.

Thickness comes only from `wallDefaults.wallThicknessMm`, height only from
`level.defaultCeilingHeightMm`, base elevation only from
`level.elevationMm`, all with profile provenance. Walls are never inferred
from LINE or open LWPOLYLINE linework (for example on an `A-WALL` layer),
parallel lines, hatching, or scale; parallel-line wall reconstruction is a
separate, harder problem. Adjacent spaces each keep their own edge walls;
merging shared walls is a later canonicalization concern.

## 8. Space labels

Labels are TEXT on the exact label layer. The TEXT content must equal a
profile rule's `text` exactly (case-sensitive, no trimming, no NLP). The
label's insertion point must be strictly inside exactly one space (more
than 0.001 mm from every boundary edge):

| Case | Code |
| --- | --- |
| text with no rule | `CAD_INTERPRET_SPACE_LABEL_UNMAPPED` |
| point on a space boundary | `CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS` |
| point inside no space | `CAD_INTERPRET_SPACE_LABEL_ORPHANED` |
| point inside several spaces | `CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS` |
| space with no label | `CAD_INTERPRET_SPACE_LABEL_MISSING` |
| space with several labels | `CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS` |

There is no generic fallback type. Overlap is checked before labels, so a
label inside two overlapping spaces reports `CAD_INTERPRET_SPACE_OVERLAP`.

## 9. Openings

Openings are INSERTs on the exact door/window layers. Checks, in order:

1. the block exists in the 10A inventory, else
   `CAD_INTERPRET_BLOCK_REFERENCE_INVALID`;
2. it is not an external reference, else
   `CAD_INTERPRET_EXTERNAL_BLOCK_UNSUPPORTED` (XREFs are never loaded);
3. a rule for that exact block name exists for that layer's role, else
   `CAD_INTERPRET_OPENING_RULE_MISSING` (no block-name guessing);
4. scale is `[1, 1, 1]`, else `CAD_INTERPRET_OPENING_SCALE_UNSUPPORTED`
   (mirrored, non-uniform, and scaled inserts never rescale profile
   dimensions).

Door rules supply `widthMm`, `heightMm`, `sillMm: 0`, `anchorPolicy:
"center"`, `hingeSide`, and `swingDirection`; window rules supply `widthMm`,
`heightMm`, `sillMm`, and `anchorPolicy: "center"`. Nothing is inferred from
block graphics. INSERT rotation is recorded as `sourceRotationDegrees`
provenance only and is never interpreted (it never changes wall geometry or
swing); insertion Z is not interpreted in v0.1.

**Host resolution.** The insertion point is the declared opening center.
It is projected onto every wall candidate; a wall is a host when the
perpendicular distance is at most `CAD_INTERPRET_HOST_TOLERANCE_MM = 1`
(fixed by the implementation, never user input) and the projection lies on
the finite segment. Exactly one host is required: zero is
`CAD_INTERPRET_OPENING_HOST_UNRESOLVED`, more than one is
`CAD_INTERPRET_OPENING_HOST_AMBIGUOUS` (the nearest is never chosen). A
center at a wall junction, or on an edge shared by two adjacent spaces
(interior doors), is therefore ambiguous in v0.1. The measured
perpendicular distance is recorded as `hostDistanceMm` for review.
This v0.1 behavior is permanent: shared-boundary openings are resolved
downstream by the separate topology layer (Spike 10D,
[CAD-TOPOLOGY.md](CAD-TOPOLOGY.md)), never by changing this rule.

**Offset.** With `centerDistance` measured along the host from its start,
`offsetMm = centerDistance - widthMm / 2`, which is SceneSpec's opening
offset convention. It must satisfy `offset >= 0` and `offset + width <=
wall length` within 0.001 mm, else `CAD_INTERPRET_OPENING_OUTSIDE_HOST`;
values within that epsilon are snapped into range.

## 10. Candidate identity

Candidate IDs are local interpretation identity only: `space_candidate_NNNN`,
`wall_candidate_SSSS_EEEE` (space, edge), `opening_candidate_NNNN`,
and the profile's `levelCandidateId`. **candidateId != SceneSpec logical
ID.** DXF handles and source ordinals are never used as logical IDs, and no
semantic names (`wall_south`, ...) are assigned geometrically. Canonical
logical identity is assigned later, after human approval.

## 11. Hash chain and evidence

| Link | Hash |
| --- | --- |
| raw DXF bytes | `sourceHash` (byte SHA-256, 10A) |
| normalized CAD evidence | `cadDocumentHash` (RFC 8785 semantic) |
| human interpretation profile | `profileHash` (RFC 8785 semantic; byte-different but equal JSON hashes the same) |
| architectural candidates | `architecturalExtractionHash` (RFC 8785 semantic) |

The extraction embeds `source.{cadDocumentVersion, sourceFormat, sourceHash,
cadDocumentHash}` and `profileHash`; the worker recomputes both with
`semanticJsonHash` and fails with `CAD_INTERPRET_HASH_MISMATCH` if they
differ. `cad-interpretation-evidence-v0.1` (worker-contracts) carries the
whole chain, `profileId`, the summary, and `status: "READY_FOR_REVIEW"`,
with no candidate arrays and no paths.

## 12. Worker and CLI

`apps/worker/src/cad-interpretation.ts` provides `cadInterpretationEvidence`
(pure, over loaded objects), `interpretCadFiles`, and
`writeCadInterpretation`. Inputs and outputs use the post-10A lexical and
physical containment helpers; lexical-only resolution is never used.

```bash
pnpm worker interpret-cad tests/fixtures/cad/interpretation/simple-living-room/cad-document-v0.1.json tests/fixtures/cad/interpretation/simple-living-room/profile-v0.1.json cad/simple-living-room.json
```

Inputs are repository-relative `.json` files; the output (plus
`.evidence.json`) is relative to the worker workspace root. The command
never re-parses DXF.

## 13. Review boundary and what 10B does not do

`status: "READY_FOR_REVIEW"` means deterministic candidates awaiting human
approval. It is never APPROVED, CANONICAL, or SceneSpec-ready. 10B creates no
floor/ceiling meshes, extrusions, or any 3D geometry (it only records
boundary, floor elevation, and ceiling height as candidate facts), emits no
SceneSpec structure, and assigns no canonical IDs.

**10C:** explicit human approval of an exact extraction, canonical logical IDs,
and approval-supplied non-CAD state produce a SceneSpec v0.4 seed; see
[CAD-SCENE-SEED.md](CAD-SCENE-SEED.md).

**10D:** passes 1-5 of this policy (validation through walls) are exposed
as the shared `deriveSpaceWallStage`, and opening rule/host resolution as
`resolveOpeningRule`, `findOpeningHosts`, and `buildOpeningCandidate`;
`interpretCadDocument` is exactly their composition, with unchanged outputs,
errors, and precedence. The multi-space topology analysis (shared
boundaries, adjacency, interior doors) reuses them; see
[CAD-TOPOLOGY.md](CAD-TOPOLOGY.md).
