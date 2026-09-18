# Spatial Validation (spatial-policy-v0.1)

## 1. Why this document exists

Technical Spike 9A introduces the platform's first deterministic answer to
"is this placement geometrically safe before we mutate 3ds Max?" It is the
real implementation behind the hypothetical sketch in
[VALIDATION-ENGINE.md](VALIDATION-ENGINE.md)'s "Spatial Validation", "Room
Boundary Validation", and "Collision Validation" sections — those sections
remain historical planning sketches; this document and
`packages/spatial-engine/` are the authoritative, implemented contract.

## 2. Package boundary

`packages/spatial-engine/` is a pure, DCC-independent package. It has zero
runtime dependencies and never touches 3ds Max, pymxs, Corona, worker
process execution, filesystem paths, or OS state. Its inputs are plain
validated canonical data (a SceneSpec-shaped object); its outputs are plain
deterministic data. It is safe to run on untrusted-but-schema-valid
candidate scene data.

The engine does not depend on any DCC-side script, and no new Python/3ds
Max script exists for it — every spatial geometry test runs under normal
`pnpm test`, with no 3ds Max process launched.

`apps/worker/src/build-plan.ts`'s `wallFrame()` now re-exports
`@ai-archviz/spatial-engine`'s implementation rather than defining a second
copy, so the DCC-side wall-segment carving and the pure spatial engine can
never independently drift on the wall reference-frame convention.

## 3. spatial-policy-v0.1 scope

The policy version is implementation-owned, not user/job supplied, and its
initial scope is deliberately frozen to:

- floor-plan XY occupancy (2.5D — see §9)
- canonical space containment, including concave polygons
- proxy-asset footprint collision
- doorway access-clearance blocking

Explicitly **out of scope** for v0.1: circulation/pathfinding (walkable
grid, navmesh, A*, minimum corridor width, egress, ergonomic clearance,
view corridors), true 3D/height collision, automatic repair of any kind,
and any DCC geometry query. SceneSpec is authority; if SceneSpec geometry
cannot answer a spatial question, the engine fails closed
(`SPATIAL_FOOTPRINT_UNSUPPORTED`) rather than guessing.

## 4. Supported asset footprint model

A canonical asset participates in spatial validation only if:

- `asset.type === "proxy_asset"`
- its definition's `pivotPolicy === "floor_center"` (`back_center_floor` is
  not yet supported and fails closed, not guessed)
- `transform.scale.x`/`.y` are finite and positive
- the asset is upright: `rotationEuler.x` and `rotationEuler.y` are within
  `SPATIAL_EPSILON_MM` degrees of zero (the same numeric epsilon doubles as
  the angular tolerance for this specific check — see §6)
- `rotationEuler.z` (yaw) is fully supported

Any other realization (non-zero roll/pitch, unsupported pivot policy,
invalid/missing dimensions, invalid transform) returns
`SPATIAL_FOOTPRINT_UNSUPPORTED` with no guessed footprint and blocks the
candidate before any DCC launch.

For a supported asset: definition `dimensions = [width, length, height]`
map to local footprint width along local X, length along local Y (asset
forward convention is +Y); `transform.position.x/y` is the footprint
center; effective width/length are `dimensions[0] * scale.x` and
`dimensions[1] * scale.y`; the footprint is rotated by
`rotationEuler.z` degrees (standard CCW math convention, matching every
other angular convention already used in this codebase — see
`camera-policy.ts`, `build-plan.ts`'s `wallFrame`). The SceneSpec transform
is never mutated by a candidate evaluation.

Canonical corner order (frozen, used everywhere corners are serialized):
local `(-x,-y)`, `(+x,-y)`, `(+x,+y)`, `(-x,+y)`, then rotated/translated to
world XY.

## 5. Space containment (concave-safe)

The canonical SceneSpec space `boundary` (`boundaryWinding:
counter_clockwise`) is the usable floor-plan boundary. Boundary contact is
always allowed; a footprint is invalid only if it has positive geometry
outside the space beyond `SPATIAL_EPSILON_MM`.

Corner-only containment is insufficient for a concave polygon whose
boundary can dip between two contained corners, so containment requires
BOTH:

1. every footprint corner is inside or on the space boundary, AND
2. no footprint edge properly crosses a space-boundary edge (a robust,
   epsilon-aware segment-crossing test; touching, collinear overlap, and
   near-misses within epsilon are never reported as a "proper" crossing).

## 6. Numerical policy

`SPATIAL_EPSILON_MM = 0.001`, exported once from
`packages/spatial-engine/src/geometry.ts` and used consistently for
point-on-boundary, segment intersection, SAT overlap, zero-area overlap,
and the roll/pitch "upright" support check (as a degrees tolerance). No
other epsilon exists anywhere in this package.

## 7. Asset-asset collision (OBB / SAT)

Assets assigned to the same canonical space are checked pairwise using
exact convex-polygon Separating Axis Theorem (SAT) collision, not
world-axis AABB (AABB is never the authoritative test — only a possible
future broad phase; see §11). A collision is reported only when the
interiors overlap by more than `SPATIAL_EPSILON_MM` on every candidate
axis; boundary touching alone is allowed. Collision identity always uses
canonical logical IDs (never DCC handles, node order, or native names);
the pair is sorted lexicographically (`assetAId < assetBId`) so
semantically identical scenes always report the pair in the same order.

## 8. Doorway access-clearance envelope

For each canonical door opening, a conservative rectangular clearance zone
is derived: `width = opening.width` along the host wall, `depth =
opening.width` into the room, starting at the interior wall face. This is
**not** a building-code claim and **not** an exact door-swing simulation —
it exists purely to prevent furniture from physically blocking doorway
access. It applies identically regardless of `swingDirection` (the rule
protects access, not the physical swing leaf) and never depends on
`hingeSide`. **No arc/sector door-leaf geometry exists in v0.1.** Windows
never produce a clearance zone.

The interior side is derived from the existing canonical wall frame
(`wallFrame()`'s `exteriorNormal`, negated) — never re-derived from DCC
geometry, and never duplicated as a second wall-orientation formula.

An asset footprint overlapping a doorway clearance interior by more than
`SPATIAL_EPSILON_MM` is `SPATIAL_DOOR_CLEARANCE_BLOCKED`; boundary touching
alone is allowed.

## 9. 2.5D limitation

This is explicitly floor-plan occupancy, not full 3D collision. Asset
definition height is preserved in source data but is **not** an
authoritative collision axis in v0.1. A future spatial-policy version may
add height-aware collision; v0.1 makes no such claim.

## 10. Pure APIs

- `validateSpatialScene(sceneSpec)` — full-scene validation. Returns
  `{ policyVersion, sceneSpecVersion, projectId, sceneId, revisionId,
  status, assetFootprints, doorwayClearances, violations }`.
- `evaluateAssetPlacement(sceneSpec, assetId, desiredTransform)` — the
  future boundary an AI placement planner can call before proposing a
  `MoveObject` revision, without mutating the input SceneSpec.
- `evaluateAssetReplacement(sceneSpec, assetId, newAssetDefinitionId)` —
  the same boundary for `ReplaceAsset`; the **new** definition's
  dimensions are authoritative, never the old footprint.

All three are pure, DCC-independent, and produce byte-equivalent
normalized evidence for semantically identical scenes regardless of input
array order — the engine never mutates or depends on source array
ordering; every output collection (`assetFootprints` by `assetId`,
`doorwayClearances` by `openingId`, `violations` by
`code, primaryId, secondaryId`) is explicitly sorted.

## 11. Performance

v0.1 deliberately does no spatial indexing: asset-pair checks within each
space are O(n²), which is acceptable and easier to audit at Golden-scene
scale. The API is structured so a future broad-phase index (e.g. AABB
pre-filtering before the exact SAT test) can be added later without
changing semantic results.

## 12. Evidence contract

`spatial-validation-evidence-v0.1`
(`packages/worker-contracts/schema/spatial-validation-evidence-v0.1.schema.json`,
`validateSpatialValidationEvidence`) wraps a `validateSpatialScene()`
result with `evidenceVersion: "0.1.0"` and `sceneSpecHash` (hashing is a
worker-contracts concern via `semanticJsonHash`, not the pure engine's —
see `apps/worker/src/spatial-validation.ts`'s `spatialValidationEvidence()`
builder). No filesystem paths appear anywhere in the evidence.

## 13. Pre-DCC MoveObject / ReplaceAsset gate

The spatial oracle is integrated into the revision preflight for
`MoveObject` and `ReplaceAsset` (both the plain `procedural_proxy` path in
`apps/worker/src/revision.ts` and the controlled `VERIFIED` `external_max`
path in `apps/worker/src/external-asset-ingestion.ts`, without touching
the asset-trust boundary). It is **strictly additive**: the pre-existing
`validatePlacement()`/`OBJECT_OUTSIDE_SPACE` corner-only check (and
`external-asset-ingestion.ts`'s equivalent `validateSpatialFit()`) is
unchanged and still runs first, so every scene that passed it before Spike
9A still fails the same way for the same reason. The new
`spatial-policy-v0.1` checks run strictly afterward and can only add
rejections the legacy check could not catch (a concave-boundary edge
crossing, an asset-asset collision, or a doorway-clearance block) — they
never weaken or replace it. A specific `SPATIAL_*` error code is always
propagated (never collapsed into a generic `REVISION_FAILED`), and an
invalid candidate launches zero DCC processes — the check runs entirely
within the pure `planSceneRevision`/preflight step, before the existing
`allowDccExecution && authorizeDccExecution` boundary is ever reached.

No other operation type (`UpdateOpening`, `AssignMaterial`,
`LockProperty`, `UnlockProperty`, `SetRenderIntent`, `AddLight`,
`MigrateMaterialAppearanceContract`, `SetCamera`) is newly gated by this
spike.

## 14. No automatic repair

The spatial engine is an oracle only. It never moves furniture, snaps to a
wall, rotates an object, shrinks a clearance zone, substitutes another
asset, or changes scale. Repair, if it ever exists, is a future AI/planner
concern layered on top of this oracle — never inside it.
