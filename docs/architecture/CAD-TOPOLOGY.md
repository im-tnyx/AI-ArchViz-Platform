# CAD Multi-Space Topology (architectural-topology-v0.1)

## 1. Question answered

| Spike | Question | Output |
| --- | --- | --- |
| 10A ([CAD-INGESTION.md](CAD-INGESTION.md)) | What exactly exists in this CAD source? | `cad-document-v0.1` |
| 10B ([CAD-INTERPRETATION.md](CAD-INTERPRETATION.md)) | Which architectural candidates follow from it under an explicit profile? | `architectural-extraction-v0.1` |
| 10D (this document) | Which interpreted spaces touch, over what exact boundary interval, and which opening connects them? | `architectural-topology-v0.1` |

10D does **not** answer "how should one shared partition become one
canonical SceneSpec wall?". That decision is deliberately deferred to a
separate future spike that can rely on this proven topology evidence.

```text
cad-document-v0.1 + cad-interpretation-profile-v0.1
  + architectural-extraction-v0.1 (or null, see section 4)
  -> cad-topology-policy-v0.1 (software-owned algorithm)
  -> architectural-topology-v0.1 (status READY_FOR_REVIEW)
  -> cad-topology-evidence-v0.1
```

There is no AI, OCR, fuzzy classification, probability, or confidence; no
SceneSpec output; no DCC, Python, or renderer; no DWG adapter.

## 2. Why 10B wall candidates are per space

10B derives one wall candidate from every normalized counter-clockwise edge
of every space boundary. Two rooms that touch therefore each keep their own
candidate along the shared edge, traveling in opposite directions, and a
door on that edge matches both. 10B v0.1 correctly refuses to choose and
fails with `CAD_INTERPRET_OPENING_HOST_AMBIGUOUS`. That behavior is
historical and permanent; 10D resolves the topology in a separate layer and
never mutates 10B.

## 3. Package boundary

`packages/cad-topology/` (`@ai-archviz/cad-topology`) depends only on
`@ai-archviz/cad-interpreter` and `@ai-archviz/cad-parser` (never the
reverse), `ajv`, and `node:fs` for reading its own schema. It imports no
SceneSpec, `apps/worker`, DCC, renderer, process, network, or AI code;
static unit guards enforce this. The pure API is:

```ts
analyzeArchitecturalTopology({ cadDocument, interpretationProfile, architecturalExtraction })
```

`CAD_TOPOLOGY_EPSILON_MM = 0.001` is fixed by the implementation and used
only for numeric geometric equivalence; it is never profile or user input.

## 4. Input bundle and candidate basis

All three inputs are validated against their contracts first
(`CAD_TOPOLOGY_INPUT_INVALID`). The candidate basis is then:

- **`architectural_extraction`**: the supplied READY_FOR_REVIEW
  `architectural-extraction-v0.1`. Its embedded `sourceHash`,
  `cadDocumentHash`, `profileHash`, and `profileId` must equal the supplied
  CAD document and profile (`CAD_TOPOLOGY_INPUT_HASH_MISMATCH`). Its own
  level, spaces, walls, and openings are used as-is; nothing is re-derived.
- **`space_wall_stage`** (`architecturalExtraction: null`): 10B v0.1
  cannot produce an extraction for a source with an opening on a shared
  boundary. The analyzer then runs the shared 10B space/wall stage
  (`deriveSpaceWallStage`: passes 1-5 of cad-interpretation-policy-v0.1,
  the same code `interpretCadDocument` runs) on the bound CAD document and
  profile. This basis is allowed only when at least one opening actually
  resolves as an interior shared-boundary opening; if 10B would accept the
  source, analysis fails with `CAD_TOPOLOGY_EXTRACTION_REQUIRED`. Any 10B
  rejection surfaces as `CAD_TOPOLOGY_INTERPRETATION_REJECTED` with the
  original `interpretationErrorCode`.

The 10B refactor that exposes the stage is internal: `interpretCadDocument`
is exactly the stage plus v0.1 opening resolution, with identical outputs,
errors, and precedence; every 10B frozen hash is unchanged.

## 5. Shared boundary definition

Wall-candidate geometry (`start`, `end`, `spaceCandidateId`) is the only
boundary-edge authority; nothing is re-derived from DXF, space polygons,
SceneSpec, or DCC. Two wall candidates form a shared boundary only when:

1. they belong to different spaces;
2. they are collinear: every endpoint of each lies within epsilon of the
   other's line;
3. their finite segments overlap over a length greater than epsilon.

Point-only contact (corners, perpendicular T-junction endpoints, collinear
end-to-end touches) is not a shared boundary; parallel walls separated by
any gap (for example 150 mm) are not shared, and no wall-thickness
relationship is inferred. Supported: full edge against full reversed edge,
partial overlaps (the interval need not match either wall's endpoints), and
T-junctions (the positive collinear overlap is recorded; walls are never
split).

**Direction.** Normalized CCW rooms traverse a shared edge in opposite
directions (`directionRelationship: "opposite"`). Same-direction coincident
overlap means malformed topology and fails with
`CAD_TOPOLOGY_SHARED_EDGE_DIRECTION_INVALID`; candidate geometry is never
silently reversed.

**Multiple intervals.** One long wall may share several disjoint intervals
(with one or several neighbors). Any positive overlap between two intervals
on the same wall fails with `CAD_TOPOLOGY_SHARED_INTERVAL_CONFLICT`;
ownership is never guessed. The conflict check runs before the direction
check.

**Canonical interval direction.** `worldStart`/`worldEnd` are ordered
lexicographically (lower x, then lower y, first), independent of which wall
was visited first. Endpoints are always two of the four input endpoints,
copied verbatim. `wallIntervals` records the interval along each
participating wall's own direction.

## 6. Adjacency and wall classification

Every shared boundary contributes to exactly one space adjacency per
space pair: `spaceAdjacencies[]` lists the sorted pair, all its
`sharedBoundaryCandidateIds`, and `totalSharedLengthMm`, deriving solely
from those shared boundaries.

Every 10B wall candidate is classified; nothing disappears.
`shared_boundary_participant` walls list their shared intervals and shared
and unpaired lengths. `exterior_or_unpaired` means "no positive shared
overlap with any SUPPLIED space". It is intentionally not called an
exterior wall, because a neighboring space may simply be absent from the
extraction.

## 7. Openings

Door/window dimensions and hinge/swing semantics remain profile-owned; 10D
reuses the exact matched 10B rule, never block graphics or AI. An opening
center lies on a shared interval under the 10B host rule
(`CAD_INTERPRET_HOST_TOLERANCE_MM`, within the interval's extent).

| Opening center | Result |
| --- | --- |
| on exactly one shared interval, door | one `interior_shared_boundary` relation |
| on exactly one shared interval, window | `CAD_TOPOLOGY_WINDOW_ON_SHARED_BOUNDARY_UNSUPPORTED` |
| on more than one shared interval (junction) | `CAD_TOPOLOGY_OPENING_AMBIGUOUS` (never nearest) |
| on one shared interval and another wall | `CAD_TOPOLOGY_OPENING_AMBIGUOUS` |
| on no shared interval, one 10B host | one `single_space` relation |

**Interior doors.** One source INSERT becomes one topology relation
connecting exactly two spaces (`connectsSpaces`, sorted), never one door
per room. It records the source ordinal/handle, block, center,
`centerDistanceFromWorldStartMm`, `offsetFromWorldStartMm`, resolved
width/height/sill, and the matched `doorRule` (`ruleId`, `hingeSide`,
`swingDirection` verbatim). The whole width must lie inside the shared
interval, else `CAD_TOPOLOGY_OPENING_OUTSIDE_SHARED_BOUNDARY`. Resolving
hinge/swing against a shared partition (which room is "into") is deferred
to canonicalization. This is connectivity evidence, not a circulation
requirement.

**Single-space openings.** Uniquely hosted 10B openings are referenced
verbatim (`openingCandidate`) and never reinterpreted. In the stage basis
they are produced by the same 10B helpers, so they equal what 10B emits.

## 8. Identity

All IDs are topology-local and explicitly non-canonical
(`identityScope: "topology_local_non_canonical"`):
`shared_boundary_NNNN` (ordered by the sorted wall-candidate pair, then
`worldStart`), `space_adjacency_AAAA_BBBB` (the space pair), and
`topology_opening_NNNN` (source ordinal order). Candidate IDs are not future
SceneSpec wall or opening IDs; DXF handles are never used as IDs; no random
UUIDs.

## 9. Provenance

- Shared boundary: both `wall_candidate` references (wall, space,
  `basisHash`) plus `derived: shared_collinear_overlap_v0.1`.
  `basisHash` is `architecturalExtractionHash`, or `spaceWallStageHash` for
  the stage basis.
- Adjacency: `shared_boundary` references plus
  `derived: space_adjacency_v0.1`.
- Interior door: CAD source ordinal/handle, `shared_boundary`, profile rule
  fields, `derived: shared_opening_resolution_v0.1` /
  `shared_opening_offset_v0.1`.
- Single-space opening: the `opening_candidate` (extraction basis) or CAD
  source (stage basis) plus `derived: single_space_opening_v0.1`.

No confidence percentages.

## 10. Hash chain and evidence

| Link | Hash |
| --- | --- |
| raw DXF bytes | `sourceHash` |
| normalized CAD evidence | `cadDocumentHash` |
| interpretation profile | `profileHash` |
| 10B extraction (extraction basis) | `architecturalExtractionHash` (null for the stage basis) |
| exact 10B `{level, spaces, walls}` analyzed | `spaceWallStageHash` |
| topology | `architecturalTopologyHash` |

All are RFC 8785 semantic hashes except `sourceHash` (raw bytes). The worker
recomputes every upstream hash with `semanticJsonHash` (for the stage basis
by rerunning the shared stage) and fails with `CAD_TOPOLOGY_HASH_MISMATCH`
on any difference. `cad-topology-evidence-v0.1` (worker-contracts) carries
the chain, `candidateBasis`, the topology hash, and the summary, with no
geometry arrays and no paths.

## 11. Worker and CLI

`apps/worker/src/cad-topology.ts` provides `cadTopologyEvidence` (pure,
over loaded objects), `analyzeCadTopologyFiles`, and `writeCadTopology`,
using the lexical and physical containment helpers for every input and
output.

```bash
pnpm worker analyze-cad-topology tests/fixtures/cad/topology/two-room/cad-document-v0.1.json tests/fixtures/cad/topology/profile-v0.1.json none cad/two-room-topology.json
```

The third argument is the extraction JSON, or the literal `none` for the
stage basis. The command never re-parses DXF.

## 12. Fixtures

`tests/fixtures/cad/topology/` (shared `profile-v0.1.json`):

- `two-room/`: living and bedroom sharing the full x = 3000 edge, one
  interior door at [3000, 2000]. 10B rejects it (ambiguous); topology
  gives 2 spaces, 8 wall candidates, 1 shared boundary, 1 adjacency, 1
  interior door, 6 unpaired walls.
- `three-room/`: a hall whose 8000 mm east edge shares 0..3000 with one room
  and 5000..8000 with another (two disjoint relations, no conflict), plus a
  perpendicular T-junction that is not shared.
- `partial-share/`: a bedroom sharing x 2000..4500 of a 6000 mm living room
  edge.

## 13. What 10D does not do

No SceneSpec schema or generation change, and no decision on whether a
shared boundary becomes one wall, two walls, a centerline wall, or a
dual-space partition. No DCC, spatial, or circulation behavior change; the
DCC path is untouched. Those follow only in a future canonicalization
spike.
