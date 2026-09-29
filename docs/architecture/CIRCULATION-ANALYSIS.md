# Circulation Analysis (circulation-policy-v0.1)

## 1. Why this document exists

Technical Spike 9B adds the platform's first deterministic answer to "can a
walking agent move through this canonical room configuration?" It builds on
[SPATIAL-VALIDATION.md](SPATIAL-VALIDATION.md) (spatial-policy-v0.1, Spike
9A) without changing it: placement validity and circulation analysis are
separate questions, so circulation has its own policy,
`circulation-policy-v0.1`, rather than a `spatial-policy-v0.2`.

```text
SceneSpec
  -> spatial-policy-v0.1 occupancy (must PASS)
  -> circulation-policy-v0.1 walkable grid per space
  -> stable connected components
  -> interior door portals
  -> same-space route query
  -> PASS / CIRCULATION_NO_ROUTE / deterministic reason
```

Circulation is a derived analysis capability. It adds no SceneSpec or
SceneChangeSet field, no schema version, and no Golden revision.

9B remains generic analysis: it answers route queries but does not decide
which routes matter. Canonical required routes are declared separately in
SceneSpec v0.4 `circulationRequirements[]` and evaluated through this
engine; see [CIRCULATION-REQUIREMENTS.md](CIRCULATION-REQUIREMENTS.md)
(Spike 9C).

## 2. Package boundary

The implementation lives in `packages/spatial-engine/src/circulation.ts`,
inside the same pure, dependency-free package as 9A, reusing its geometry
primitives (`packages/spatial-engine/src/geometry.ts`). It never touches 3ds
Max, pymxs, Corona, a renderer, an AI provider, the filesystem, the network,
environment variables, or process execution. There is no Python or 3ds Max
circulation script; every circulation test runs under `pnpm test`.

## 3. Policy constants

| Constant | Value |
| --- | --- |
| `CIRCULATION_POLICY_VERSION` | `circulation-policy-v0.1` |
| `CIRCULATION_GRID_STEP_MM` | `100` |
| `CIRCULATION_AGENT_RADIUS_MM` | `300` (600 mm diameter) |
| `CIRCULATION_SNAP_DISTANCE_MM` | `100 * sqrt(2)` |
| Route distance normalization | 6 decimal places |
| Geometric epsilon | `SPATIAL_EPSILON_MM = 0.001` (shared with 9A) |

These are deterministic engineering policy parameters for a software access
probe. Grid step and agent radius are policy dimensions, not numerical
tolerances; no circulation-specific epsilon exists.

## 4. Not a building-code or accessibility claim

circulation-policy-v0.1 does NOT establish minimum corridor width, fire
egress, ADA or other accessibility compliance, NBC/IBC compliance,
wheelchair turning radii, occupancy load, or emergency escape. A `NO_ROUTE`
or `PORTAL_BLOCKED` result means only "the v0.1 probe cannot pass", never
"this design violates a code".

## 5. Agent model

The agent is a floor-plan disc of radius 300 mm in XY only: no height, head
clearance, stairs, ramps, elevators, body orientation, or multi-level
routing.

## 6. Source spatial validation

`validateSpatialScene(sceneSpec)` must PASS first. If it fails, no graph is
built and the result carries `CIRCULATION_SOURCE_SPATIAL_INVALID`. 9A
occupancy rules are reused, never duplicated.

## 7. Enclosure and obstacles

- Each `space.boundary` is the walkable enclosure, with 9A's polygon
  semantics (convex and simple concave polygons).
- Each space graph uses only 9A asset footprints whose canonical `spaceId`
  matches that space (`validateSpatialScene`'s `assetFootprints`, derived by
  `deriveAssetFootprint`) — the real oriented rectangles, never an AABB and
  never inflated geometry. Ownership comes only from
  `AssetFootprint.spaceId`, never from coordinates, geometric overlap,
  `hostGeometryId`, DCC nodes, or array order. Spaces may share XY
  (stacked floors, overlapping or nested boundaries), so furniture in one
  space never obstructs another. A footprint referencing a space that does
  not exist joins no graph; 9A's own handling of it is unchanged. This
  mirrors the same-space-only routing rule (section 15).
- 9A doorway access-clearance zones are NOT obstacles; they are free space
  used to derive door portals.
- Windows produce no portal, node, or opening into another space.

## 8. Grid and node identity

Per space, the grid is anchored to that space's XY bounding box:

```text
x = minX + (ix + 0.5) * 100
y = minY + (iy + 0.5) * 100
```

with zero-based integer `ix`, `iy`. Node identity is
`spaceId::ix::iy` — integer indices only, never floating-point coordinates.
Frozen node order is `spaceId` (code-point order), then `ix`, then `iy`
(numeric).

## 9. Walkable node test

A grid center `p` is walkable only if, exactly:

1. `p` is strictly inside the space polygon;
2. the distance from `p` to every boundary segment is at least
   `300 - epsilon` (a deterministic erosion of the space; no new polygon is
   generated or written to SceneSpec);
3. the distance from `p` to every asset rectangle is at least
   `300 - epsilon` (zero if `p` is inside the rectangle).

Distances use exact point-to-segment and point-to-rectangle mathematics
(`distancePointToPolygonBoundary`, `distancePointToRectangle`). No AABB
test, rasterization, sampling, or DCC collision query is used.

## 10. Neighbor graph

- Fixed 8-neighbor order: N, NE, E, SE, S, SW, W, NW.
- Orthogonal step cost 100 mm; diagonal step cost `100 * sqrt(2)` mm.
- No diagonal corner cutting: a diagonal edge exists only if both
  corresponding orthogonal cells are walkable (NE requires N and E).
- Movement-edge clearance: endpoint walkability is not enough. The swept
  segment between two cell centers must also keep at least `300 - epsilon`
  from every boundary segment and every asset rectangle, using exact
  segment-to-segment distance (`distanceSegmentToPolygonBoundary`,
  `distanceSegmentToRectangle`). Since both endpoints are strictly inside
  and the segment stays clear of the boundary, it also stays inside the
  eroded space.
- Edges are undirected, stored as `[lowerNodeId, higherNodeId]` in frozen
  node order.

## 11. Connected components

Components are found by visiting nodes in frozen node order, so each
component's first-visited node is its smallest member. `componentId` is
that smallest node ID; it never depends on traversal or source-array order.
Each component records `componentId` and `nodeCount`; components are sorted
by `componentId` in frozen node order.

## 12. Door portals

For each 9A doorway clearance with corners
`[wallStart, wallEnd, intoRoomEnd, intoRoomStart]`, the interior portal is
the midpoint of `intoRoomEnd` and `intoRoomStart` — one clearance depth
(= door width) inside the room, never the wall-face midpoint.

A portal resolves only if the portal point is itself a clear agent center
(section 9) and a walkable node within `100 * sqrt(2)` mm is reachable by a
clear movement segment (section 10). The nearest such node wins; distances
within epsilon tie-break to the lowest node in frozen order. Otherwise the
analysis reports `CIRCULATION_PORTAL_BLOCKED` with `openingId`, `spaceId`,
and `portalXY`. Snapping never crosses furniture or the room.

Consequences under v0.1: furniture flush against the clearance zone (which
9A permits) blocks the portal, and a door narrower than the probe radius
blocks its portal because the portal lies within 300 mm of the host wall.
v0.1 does not test the agent's passage through the door frame itself.

## 13. Full analysis API

`analyzeCirculation(sceneSpec)` returns `policyVersion`,
`spatialPolicyVersion`, scene identity, `spatialValidationStatus`,
`gridStepMm`, `agentRadiusMm`, per-space summaries (`spaceId`,
`gridOriginXY`, `gridSize`, `walkableNodeCount`, `edgeCount`,
`componentCount`, `components`, `doorPortals`), `status`, `violations`, and
the full normalized in-memory `graph` (policy constants, spaces, nodes,
edges, components, door portals).

## 14. Route query API

`findCirculationRoute(sceneSpec, { spaceId, startXY, endXY })`:

1. Requires 9A PASS (`CIRCULATION_SOURCE_SPATIAL_INVALID`) and an existing
   space (`CIRCULATION_SPACE_NOT_FOUND`).
2. Each endpoint must itself be a clear agent center, otherwise
   `CIRCULATION_ENDPOINT_BLOCKED`. An invalid endpoint is never made valid
   by snapping.
3. A valid endpoint snaps with the portal rule (section 12), otherwise
   `CIRCULATION_ENDPOINT_UNRESOLVABLE`.
4. Deterministic Dijkstra (no heuristic). Cost is carried as exact integer
   counts of orthogonal and diagonal steps and compared exactly as
   `a + b*sqrt(2)`, so genuinely equal-cost routes compare equal. The
   frontier is ordered by cost, then frozen node order; an equal-cost
   alternative predecessor is adopted only if it is lower in frozen node
   order. Equal-cost routes therefore always resolve to the same path.
5. A disconnected pair returns `CIRCULATION_NO_ROUTE`.

The result carries `requestedStartXY`, `requestedEndXY`, `startNodeId`,
`endNodeId`, `reachable`, `distanceMm` (node-to-node graph distance,
rounded to 6 decimals), `orthogonalStepCount`, `diagonalStepCount`, and the
path as ordered node IDs and XY points. No graph state or SceneSpec is
mutated.

## 15. Same-space only

SceneSpec v0.3 does not define door-to-door adjacency between spaces, so 9B
routes only within one canonical space. It does not guess which room lies
beyond a door, building adjacency, or outside-world topology; that belongs
to a future explicit contract.

## 16. No asset-use semantics

9B invents no sofa-front, bedside, TV-viewing, chair pull-out, or
cabinet-service access goals. SceneSpec does not express those
requirements; 9B exposes only general route queries.

## 17. No MoveObject / ReplaceAsset gating

9B adds no revision rejection rule. `MoveObject` and `ReplaceAsset` remain
gated by spatial-policy-v0.1 only (a 9A-valid move that blocks a door
portal for the probe still plans). Without a canonical required-route
contract, a route engine must stay an analysis capability rather than an
implicit design rule. The intended future flow is: AI proposes placement,
9A oracle, 9B route queries, future explicit circulation constraints,
revision proposal.

## 18. Evidence and graph hash

`circulation-analysis-evidence-v0.1`
(`packages/worker-contracts/schema/circulation-analysis-evidence-v0.1.schema.json`)
is built by `circulationAnalysisEvidence(sceneSpec)`
(`apps/worker/src/circulation-analysis.ts`). It carries identity,
`sceneSpecHash`, `spatialPolicyVersion`, `spatialValidationStatus`, policy
constants, per-space summaries with door portals, `graphSemanticHash`,
`status`, and `violations`. It never serializes nodes, edges, or paths.
`graphSemanticHash` is the RFC 8785 `semanticJsonHash` of the normalized
graph (policy constants, space IDs, grid origin/size, walkable nodes, edges,
components, door portals), computed at the worker layer; the pure engine
does no hashing. It excludes paths, filesystem data, timestamps, process
IDs, and machine identity. The builder validates the evidence against the
schema and never launches a DCC process.

## 19. Performance

A 100 mm grid with straightforward arrays, maps, and a binary heap is
intentionally sufficient for the current architecture proof (Golden rev12
analysis is tens of milliseconds). No quadtree, navmesh, GPU
rasterization, or third-party geometry engine is used.

## circulation-policy-v0.2 (SceneSpec v0.5)

circulation-policy-v0.1 results are byte-identical and it refuses SceneSpec
0.5.0. `analyzeCirculationV02` / `findCirculationRouteV02` keep the same
grid, radius, snap, graph, and tie rules and add partition solids as
obstacles of both adjacent spaces and one portal per (shared door,
connected space). Space graphs are never connected across a shared door
(`circulation-analysis-evidence-v0.2`). See [MULTI-SPACE-SCENE-SPEC.md](MULTI-SPACE-SCENE-SPEC.md).
