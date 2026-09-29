# Multi-Space SceneSpec v0.5 (Spike 10F)

## 1. Scope

10F freezes the canonical DATA and PURE VALIDATION semantics of multi-space
scenes: SceneSpec v0.5, the reviewed multi-space CAD seed
(cad-scene-seed-policy-v0.2), spatial-policy-v0.2, and
circulation-policy-v0.2. It does **not** realize v0.5 in 3ds Max: there is no
shared-partition build plan, no Python builder change, no SceneChangeSet
v0.5, no revision, and no render. The existing initial build refuses v0.5
before any DCC discovery or process (section 9). Physical realization is a
separate, not-yet-authorized spike (10G).

## 2. Why SceneSpec v0.4 was insufficient

A v0.4 `wall` is single-space: one `spaceId`, `referenceLine:
"interior_face"`, `thicknessDirection: "exterior_right_of_u"`. Two touching
rooms produce two coincident 10B wall candidates running in opposite
directions; both cannot be literal interior faces of one partition with
non-zero thickness, a v0.4 door cannot connect two spaces, and 9A/9B/9C
semantics assumed one host space per wall. v0.4 is unchanged; v0.5 adds the
missing concepts explicitly.

## 3. SceneSpec v0.5

`scene-spec-v0.5.schema.json` is v0.4 plus exactly three additions
(`validateSceneSpec` dispatches 0.1.0 through 0.5.0 explicitly; v0.1-v0.4
schemas are untouched and v0.4 rejects every v0.5-only construct):

1. geometry `type: "shared_partition"`;
2. a partition-hosted door opening;
3. circulation requirements pinning `evaluationPolicy:
   "circulation-policy-v0.2"`.

Assets, materials, cameras, lights, and render intent are unchanged.

### Regular wall vs shared_partition

| | `wall` | `shared_partition` |
| --- | --- | --- |
| spaces | one `spaceId` | exactly two sorted `adjacentSpaceIds` |
| reference line | `interior_face` of its space | `centerline` (the reviewed 10E decision) |
| body | extends to the right of `u` | `thickness` wide, centered on the centerline |
| faces | implicit | explicit `spaceFaces` (left, then right) |

A shared interval is ONE physical partition; it never also becomes a wall.

### shared_partition

`start -> end` is the canonical centerline (10D `worldStart -> worldEnd`),
at `baseElevation`, with positive XY length. `u = normalize(end - start)`,
`leftNormal = [-u.y, u.x]`, `rightNormal = [u.y, -u.x]`. `spaceFaces` holds
exactly one left and one right face, one per adjacent space, each stored in
the same start -> end direction as the centerline. Semantic validation
never trusts stored face coordinates: it proves each face is exactly the
centerline offset by `thickness/2` along its side's normal (within
`SCENE_GEOMETRY_EPSILON_MM = 0.001`, the same value as `SPATIAL_EPSILON_MM`).
Adjacent spaces must be distinct, sorted, resolve exactly once, and be on
the partition's level.

### Partition-hosted door

`hostGeometryId` is a `shared_partition`; `connectsSpaceIds` must equal the
host's `adjacentSpaceIds` exactly; `offset` is measured along the partition
centerline start -> end (never converted back to a room-wall direction);
`hingeEndpoint` is `host_start` (the jamb at `offset`) or `host_end` (at
`offset + width`), mapped from the reviewed 10E `world_start` / `world_end`;
`swingIntoSpaceId` is one of `connectsSpaceIds`. Doors must fit the
partition and never overlap another opening on it (touching jambs allowed).
Legacy wall doors (`hingeSide`, `swingDirection`) and windows keep their
v0.4 semantics and must be hosted on a `wall`; a partition-hosted window or
legacy door is invalid.

### space.boundary stays the reviewed reference boundary

`space.boundary` is the reviewed CAD room boundary, never rewritten to a
partition face: no mitering, corner trimming, face-polygon offset, room
shrink, or usable-area polygon. A partition may straddle it, so v0.5
occupancy is the space boundary MINUS the adjacent physical partition
solids (spatial-policy-v0.2). Floor and ceiling surfaces keep their room
boundary, so adjacent surfaces meet under the partition centerline; no
finish-edge trimming happens in v0.5.

## 4. Reviewed multi-space seed (cad-scene-seed-policy-v0.2)

`createMultiSpaceSceneSpecSeed` takes cad-document, profile, extraction (or
null), topology, partition approval, reviewed partition model, and a
`cad-scene-seed-approval-v0.2`. It re-derives the reviewed model from its
bound inputs (10E) and requires it to equal the supplied model; the scene
approval binds the model's exact chain (`reviewedPartitionModelHash`,
policy, topology hash, candidate basis, source/CAD/profile hashes,
`spaceWallStageHash`, and `architecturalExtractionHash`, which stays null
for the stage basis). Only `approved_as_is` canonicalizes; no geometry
override exists.

All canonical IDs are explicit mappings: level, spaces (+ floor/ceiling
surfaces), unpaired wall segments, partitions, and openings (by 10D
`topologyOpeningId`). Unpaired wall-segment candidates
(`unpaired_wall_segment_<wallCandidateId>_<ordinal>`) are derived,
non-canonical references to 10E `unpaired` intervals; each becomes one
ordinary wall with endpoints along the 10B wall's own direction and all
other wall facts copied. An unshared 10B opening is re-hosted on the one
unpaired segment containing its complete span with a segment-local offset,
else `CAD_SCENE_SEED_OPENING_SEGMENT_INVALID`. Non-CAD state is human
supplied, as in 10C. The `aiarchviz.cad_multispace_seed` extension records
the complete chain and mappings (no paths). The worker requires
spatial-policy-v0.2 PASS and circulation-policy-v0.2 PASS and emits
`cad-scene-seed-evidence-v0.2`.

## 5. spatial-policy-v0.2

Dispatch is explicit: SceneSpec <= 0.4.0 uses spatial-policy-v0.1
(unchanged; it now refuses 0.5.0), 0.5.0 uses spatial-policy-v0.2. v0.2
keeps every 9A rule and adds:

- **Partition solids.** A partition's centerline is split around its door
  voids into positive-length intervals `[0, first.offset]`,
  `[first.offset + width, next.offset]`, ..., `[last end, L]`; each is an
  exact oriented rectangle `thickness` wide centered on the centerline
  (`partitionId::solid::NNNN`, a derived identity). Door voids are never
  solid.
- **Asset vs partition.** An asset of either adjacent space may not overlap
  a solid by more than `SPATIAL_EPSILON_MM`
  (`SPATIAL_ASSET_PARTITION_OVERLAP`, with asset, partition, and solid).
- **Two-sided door clearance.** A partition door yields one access envelope
  per connected space: width = depth = door width, starting on that space's
  face and extending along that side's normal (left space: leftNormal;
  right space: rightNormal). It never depends on hinge or swing. A blocked
  side reports its exact `openingId` and `spaceId`.

Evidence: `spatial-validation-evidence-v0.2`.

## 6. circulation-policy-v0.2

Same grid step (100 mm), agent radius (300 mm), snap, graph, and tie rules
as v0.1; the differences are partition-aware obstacles (each space also
avoids its adjacent partition solids, measured from the actual solid face:
for the two-room seed, living centers stay at x <= 2625 beside the solid)
and two-sided shared-door portals (one per connected space, the midpoint of
that side's clearance into-room edge, identified by `openingId` +
`spaceId`). v0.1 results are byte-identical and v0.1 refuses 0.5.0.

**Same-space routing only.** A shared door is canonical connectivity, but
no edge ever joins two space graphs; cross-space route planning does not
exist yet.

Requirements keep `same_space_route` with `door_portal` / `point`
endpoints. `evaluateCirculationRequirements` dispatches v0.4 ->
circulation-policy-v0.1 and v0.5 -> circulation-policy-v0.2; a
shared-door portal resolves to the requirement space's own side (never the
swing space), and each requirement depends only on its own side. Evidence:
`circulation-analysis-evidence-v0.2` and
`circulation-requirement-evidence-v0.2`.

## 7. Canonical two-room fixture

`tests/fixtures/cad/multispace-seed/two-room/` seeds the 10D/10E two-room
source as `project_cad_multispace_001` / `scene_cad_multispace_001` /
`rev_cad_multispace_0001`: 2 spaces, 6 ordinary walls, 1 shared partition
(centerline x = 3000, 150 mm, faces x = 2925 left/living and x = 3075
right/bedroom), 4 surfaces, and 1 shared door (offset 1550, width 900,
height 2100, sill 0, `host_start`, swinging into the bedroom). Room
boundaries still meet at x = 3000.

## 8. What 10F does not do

No DCC realization, build plan v0.3, Python change, SceneChangeSet v0.5,
revision, Golden migration (rev1-rev13 unchanged, no rev14), render, AI, or
network.

## 9. DCC fail-closed guard

The initial build (`buildGoldenScene`) refuses a valid SceneSpec 0.5.0 with
`DCC_SCENE_SPEC_VERSION_UNSUPPORTED` immediately after schema validation,
before any build plan, DCC discovery, or controlled process (proved with
zero discovery calls, zero processes, and no `.max`). Independently, both
existing build plans throw on `shared_partition` rather than skip,
approximate, or duplicate it.
