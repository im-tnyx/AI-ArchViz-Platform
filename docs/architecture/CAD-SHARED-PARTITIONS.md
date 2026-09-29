# CAD Shared Partitions (reviewed-partition-model-v0.1)

## 1. Question answered

| Spike | Question | Output |
| --- | --- | --- |
| 10D ([CAD-TOPOLOGY.md](CAD-TOPOLOGY.md)) | Which spaces touch, over what interval, through which door? | `architectural-topology-v0.1` |
| 10E (this document) | Given explicit human review, what physical partition does each shared interval become, and how is each interior door oriented? | `reviewed-partition-model-v0.1` |

The model answers which shared intervals are approved physical partitions,
their reference line, thickness, and height, the interior face on each
adjacent space's side, which door belongs to which partition, which jamb
is hinged, and into which space the door swings. It does **not** answer
how any of this is represented in SceneSpec; that is a future spike.

```text
cad-document-v0.1 + profile + extraction (or null) + architectural-topology-v0.1
  + cad-topology-approval-v0.1 (human review, semantics only)
  -> cad-shared-partition-policy-v0.1 (software-owned algorithm)
  -> reviewed-partition-model-v0.1 (status APPROVED_FOR_SCENE_CANONICALIZATION)
  -> cad-partition-model-evidence-v0.1
```

No AI, no confidence scores, no DCC, Python, renderer, or network.

## 2. Why SceneSpec v0.4 is insufficient

SceneSpec v0.4 walls are single-space: one `spaceId`, `referenceLine:
"interior_face"`, `thicknessDirection: "exterior_right_of_u"`. Two touching
rooms produce two coincident 10B wall candidates running in opposite
directions, and both cannot be literal interior faces of one partition with
non-zero thickness. A shared partition also has two adjacent spaces; an
interior door connects two spaces, which v0.4 cannot express; and current
spatial and circulation semantics assume one host space per wall. Any v0.4
approximation would silently misstate geometry or connectivity, so none is
produced. SceneSpec v0.5 is deliberately not introduced here: 10E proves the
semantics a future canonical representation needs.

## 3. Null extraction hash is correct

For `candidateBasis: "space_wall_stage"` no architectural extraction exists
(10B v0.1 rejects the source because of the shared door), so
`architecturalExtractionHash` is `null` in the topology, the approval, the
model, and the evidence. No synthetic extraction is ever fabricated. The
authoritative identity is `sourceHash`, `cadDocumentHash`, `profileHash`,
`interpretationPolicyVersion`, `spaceWallStageHash`, and
`architecturalTopologyHash`. For the stage basis the shared 10B
`deriveSpaceWallStage` is rerun and must reproduce `spaceWallStageHash`; the
full 10B interpretation is never required to succeed. For the extraction
basis the exact extraction is required (null is invalid) and its hash must
match.

## 4. Package boundary

`packages/cad-partition-model/` (`@ai-archviz/cad-partition-model`) depends
only on `cad-topology`, `cad-interpreter`, and `cad-parser` (never the
reverse), `ajv`, and `node:fs` for its own schemas. Static guards forbid
SceneSpec, worker, DCC, renderer, process, network, AI, and eval code. The
pure API is:

```ts
createReviewedPartitionModel({
  cadDocument, interpretationProfile, architecturalExtraction, architecturalTopology, approval,
})
```

`CAD_PARTITION_EPSILON_MM = 0.001` is fixed by the implementation.

## 5. The approval boundary

`cad-topology-approval-v0.1` binds the exact topology:
`architecturalTopologyVersion`, `architecturalTopologyHash`,
`candidateBasis`, `sourceHash`, `cadDocumentHash`, `profileHash`,
`spaceWallStageHash`, and `architecturalExtractionHash` (null for the stage
basis). Any difference fails with `CAD_PARTITION_APPROVAL_HASH_MISMATCH`, so
an approval never survives a change to any topology relation. Only
`decision: "approved_as_shared_partition_model"` produces a model;
READY_FOR_REVIEW alone is never enough.

The approval selects semantics, never geometry. Its schema has no field for
interval endpoints, thickness, height, door width or offset, or face
coordinates (`additionalProperties: false` everywhere):

- `sharedBoundaryReviews[]`: one per topology shared boundary, sorted by
  `sharedBoundaryCandidateId`, each with `referencePolicy:
  "partition_centerline"`;
- `interiorDoorReviews[]`: one per interior shared-boundary door, sorted by
  `topologyOpeningId`, each with `hingeEndpoint` and
  `swingIntoSpaceCandidateId`.

Duplicate, unsorted, unknown, or missing reviews fail closed
(`CAD_PARTITION_APPROVAL_REVIEW_*`); reviewed intent is never reordered.

## 6. partition_centerline is a review decision

10B called each space's boundary edge that space's `interior_face`. That
historical single-space contract is not rewritten. For a 10D shared
interval, the reviewer explicitly approves a new physical interpretation:
the interval (`worldStart -> worldEnd`) is the **centerline** of one
physical partition. This meaning was never contained in 10B; its authority
is recorded as `approval`, not CAD, profile, or derived.

## 7. Thickness and vertical agreement

Thickness comes from the two participating 10B wall candidates (profile
`wallDefaults.wallThicknessMm`) and must agree within epsilon, else
`CAD_PARTITION_THICKNESS_CONFLICT`. Level, base elevation, and height must
also agree, else `CAD_PARTITION_VERTICAL_CONFLICT`. Values are never
averaged, merged by min/max, chosen, or asked of a DCC.

## 8. Centerline, normals, and space sides

The centerline is exactly the 10D canonical interval, never either room's
wall direction. With `u = normalize(end - start)`: `leftNormal = [-u.y,
u.x]`, `rightNormal = [u.y, -u.x]`.

Each space's side is resolved geometrically from its own wall candidate: a
normalized CCW wall has its interior on its left, so a wall running with
`u` puts its space on the left and one running against `u` on the right.
Exactly one space must resolve to each side, else
`CAD_PARTITION_SPACE_SIDE_INVALID`. Space ID order, source ordinals, and
array order are never used.

## 9. Dual interior faces

For thickness `T`: `leftFace = centerline + leftNormal * T/2` and
`rightFace = centerline + rightNormal * T/2`. Each face records its side,
space, source wall candidate, and start/end in the same canonical centerline
direction (never reversed to imitate a room wall). Each face is proven to be
`T/2` from the centerline and the faces `T` apart. For the two-room fixture
(x = 3000, 150 mm) the living-room face is x = 2925 and the bedroom face
x = 3075.

No join, miter, trimming, or Boolean union happens at corners; partition
endpoints stay the exact topology interval endpoints.

## 10. Partial and multiple partitions, and segmentation

A partition spans only the exact 10D overlap (partial-share: 2500 mm, not
the 6000 mm source wall). One long wall yields separate partitions for
disjoint intervals and never bridges the unshared gap.

`wallSegments[]` records, for every 10B wall candidate along its own
direction, `shared_partition` and `unpaired` intervals that cover
`[0, lengthMm]` exactly once (contiguous, no gaps, no overlap). Unpaired
geometry is not canonicalized; the segmentation only spares a future
canonicalization from recomputing interval subtraction.

## 11. Interior doors

Door facts (shared boundary, center, width, height, sill, connected spaces,
offset) are copied from the 10D relation and only revalidated (offset >= 0,
offset + width <= partition length, offset = center - width/2); any
disagreement fails closed (`CAD_PARTITION_OPENING_OUTSIDE_PARTITION`),
never repaired. Host detection is never rerun.

10D preserves the profile rule, but a profile's `start_jamb` / `into_room`
cannot say which physical jamb or which of two rooms is meant on a shared
partition. The reviewer decides both: `hingeEndpoint` (`world_start` or
`world_end` jamb along the centerline) and `swingIntoSpaceCandidateId` (one
of the two connected spaces, else `CAD_PARTITION_DOOR_SWING_SPACE_INVALID`).
Nothing is inferred from INSERT rotation, block geometry, wall traversal, or
space order. The model derives the hinge jamb point on the centerline and
the swing side, and keeps the original profile rule as provenance only. A
window on a shared boundary never exists in valid topology; a tampered one
fails with `CAD_PARTITION_SHARED_WINDOW_INVALID`.

Single-space doors and windows stay outside the partition model and are
listed in `unsharedOpeningReferences[]` without being canonicalized again.

## 12. Room boundaries are not rewritten

10B space boundaries are unchanged and no corrected room polygon is output.
How the two derived faces affect future canonical space boundaries is a
canonicalization decision; deferring it avoids silently shrinking or
expanding approved CAD space geometry.

## 13. Identity, provenance, hashes

IDs are model-local (`identityScope: "model_local_non_canonical"`):
`partition_candidate_NNNN`, plus the upstream topology and candidate IDs.
No canonical names such as `wall_shared_living_bedroom` are assigned.

Partition provenance separates `topology` (shared boundary), `wall_candidate`
(both walls), `approval` (reference policy), `profile` (thickness and level
fields recorded by 10B), and `derived` (`partition_space_side_v0.1`,
`partition_face_offset_v0.1`). Door provenance adds the CAD ordinal/handle,
profile rule fields, `approval` (hinge endpoint, swing space), and the
`partition` host.

The worker recomputes `cadDocumentHash`, `profileHash`,
`architecturalExtractionHash` (when present), `spaceWallStageHash`,
`architecturalTopologyHash`, and `approvalHash` with `semanticJsonHash`
(`CAD_PARTITION_HASH_MISMATCH`), then `reviewedPartitionModelHash`.
`cad-partition-model-evidence-v0.1` carries the chain and summary only (no
geometry arrays, no paths).

## 14. Worker and CLI

`apps/worker/src/cad-partition-model.ts` provides
`cadPartitionModelEvidence`, `reviewCadPartitionFiles`, and
`writeCadPartitionModel` with lexical and physical path containment.

```bash
pnpm worker review-cad-partitions tests/fixtures/cad/topology/two-room/cad-document-v0.1.json tests/fixtures/cad/topology/profile-v0.1.json none tests/fixtures/cad/topology/two-room/expected-architectural-topology-v0.1.json tests/fixtures/cad/partition-model/two-room/approval-v0.1.json cad/two-room-partitions.json
```

Fixtures live in `tests/fixtures/cad/partition-model/` (approvals, expected
models and evidence) and reuse the 10D topology fixtures unchanged.
