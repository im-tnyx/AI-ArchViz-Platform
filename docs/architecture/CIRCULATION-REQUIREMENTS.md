# Circulation Requirements (SceneSpec v0.4)

## 1. Why this document exists

Technical Spike 9C introduces the first canonical declaration of "this route
must remain traversable". Circulation analysis
([CIRCULATION-ANALYSIS.md](CIRCULATION-ANALYSIS.md), 9B) can answer whether
a route exists, but it does not know which routes matter. SceneSpec v0.4
records that design intent explicitly:

```text
SceneSpec v0.4 + circulationRequirements[]
  -> structural contract validation (validateSceneSpec)
  -> pure requirement evaluation (9B-backed)
  -> SATISFIED / UNSATISFIED per requirement
  -> circulation-requirement-evidence-v0.1
```

9C adds the contract and its evaluation only. It adds no revision gate, no
Golden migration, and no rev13.

## 2. Contract versioning

`packages/scene-spec/schema/scene-spec-v0.4.schema.json` is a new,
immutable version (`sceneSpecVersion: "0.4.0"`). It is v0.3 with every
property and `$defs` entry unchanged, plus one new required top-level field,
`circulationRequirements`, and its definitions. The v0.1-v0.3 schemas are
untouched. `validateSceneSpec()` explicitly supports 0.1.0, 0.2.0, 0.3.0,
and 0.4.0; any other version fails. v0.3 still rejects
`circulationRequirements` as an unknown property.

`circulationRequirements` is required in v0.4 so a scene always states
whether circulation requirements exist; an empty array is valid. The generic
`constraints[]` (`inside_boundary`, `hosted_by`, `no_duplicate_id`) keeps
its frozen semantics; structured routes are never encoded in its
`subjectId`/`targetId`.

## 3. Requirement shape

```json
{
  "id": "circulation_req_entry_to_east_zone",
  "type": "same_space_route",
  "spaceId": "space_studio_main",
  "evaluationPolicy": "circulation-policy-v0.1",
  "start": { "kind": "door_portal", "openingId": "opening_door_west" },
  "end": { "kind": "point", "pointXY": [4400, 2500] }
}
```

- `type`: only `same_space_route`. No cross-space or asset-use requirement
  exists yet.
- Endpoints: exactly `door_portal` (`openingId`) or `point` (`pointXY`).
  No asset-front, sofa/bedside/cabinet access, camera, window, or
  cross-space-door endpoint.
- `pointXY`: exactly two JSON numbers in canonical SceneSpec world XY,
  millimetres. No Z and no DCC-local coordinates. NaN and Infinity are
  rejected by the schema.
- No severity, warning, advisory, priority, or weight: every entry is a
  requirement.

## 4. Why evaluationPolicy is canonical

"A route exists" depends on the grid step, probe radius, clearance rules,
portal semantics, and routing policy. Each requirement therefore pins
`evaluationPolicy: "circulation-policy-v0.1"`, and the schema rejects any
other value. A requirement is never silently reinterpreted under a future
policy.

## 5. Structural validation

After schema validation, v0.4 keeps the v0.2/v0.3 asset identity checks
(unique definition and logical asset IDs, definition references) and adds
deterministic requirement checks:

| Keyword | Rule |
| --- | --- |
| `circulationRequirementOrder` | requirements sorted by `id` in code-point order; unsorted input is rejected, never reordered |
| `uniqueCirculationRequirementId` | requirement IDs are unique |
| `circulationRequirementSpaceReference` | `spaceId` resolves to exactly one space |
| `circulationRequirementOpeningReference` | a `door_portal` `openingId` resolves to exactly one opening |
| `circulationRequirementOpeningType` | that opening is a `door` (never a window) |
| `circulationRequirementOpeningHost` | the door's host resolves to exactly one wall |
| `circulationRequirementOpeningSpace` | the host wall's canonical `spaceId` equals the requirement's `spaceId` (never inferred from XY overlap) |
| `circulationRequirementDistinctEndpoints` | start and end are not the same point or the same door |

A `door_portal` endpoint and a `point` endpoint are never compared
geometrically during validation.

## 6. Structural validity versus satisfaction

A SceneSpec can be structurally valid while a requirement is unsatisfied.
Validation asks "is the requirement well-formed and referentially
coherent?"; evaluation asks "does the current design satisfy it?". A
blocked endpoint, a blocked portal, or `CIRCULATION_NO_ROUTE` is an
evaluation result, never a SceneSpec validation error. The point does not
need to be walkable for the scene to be valid.

## 7. Pure evaluation

`evaluateCirculationRequirements(sceneSpec)`
(`packages/spatial-engine/src/circulation-requirements.ts`) expects a
SceneSpec that already passed v0.4 validation. It is pure and
DCC-independent, and 9B is its only route authority:

- `door_portal` endpoints use the `portalXY` from `analyzeCirculation()`
  for that space and opening; no second portal formula exists.
- `point` endpoints pass the exact `pointXY` to `findCirculationRoute()`.
- Routes come from `findCirculationRoute()`; no second grid, clearance
  rule, snap rule, or pathfinder exists.

Per requirement:

| Situation | Result |
| --- | --- |
| 9A source spatial validation fails | every requirement UNSATISFIED, `CIRCULATION_SOURCE_SPATIAL_INVALID`; overall FAILED even with no requirements |
| a required door portal is BLOCKED | UNSATISFIED, `CIRCULATION_PORTAL_BLOCKED` |
| an endpoint is not a clear probe position | UNSATISFIED, `CIRCULATION_ENDPOINT_BLOCKED` (no snapping rescue) |
| a valid endpoint has no walkable node in snap range | UNSATISFIED, `CIRCULATION_ENDPOINT_UNRESOLVABLE` |
| endpoints valid but disconnected | UNSATISFIED, `CIRCULATION_NO_ROUTE` |
| route found | SATISFIED with endpoints, nodes, distance, and step counts |

`failureCode` is the first 9B violation in 9B's deterministic order (start
before end). Each requirement depends only on its own endpoints and route:
an unrelated blocked door portal that makes `analyzeCirculation()` FAILED
does not fail a requirement that does not use it. Overall status is PASS
only when source spatial validation passes and every requirement is
SATISFIED; there are no warning semantics. Results are sorted by
`requirementId`. Furniture in another space never affects a requirement,
because 9B scopes obstacles by canonical `spaceId`.

## 8. Evidence

`circulation-requirement-evidence-v0.1`
(`packages/worker-contracts/schema/circulation-requirement-evidence-v0.1.schema.json`)
is built by `circulationRequirementEvidence(sceneSpec)`
(`apps/worker/src/circulation-requirement-evidence.ts`). The builder
validates the SceneSpec as v0.4 (rejecting invalid or non-v0.4 scenes with
`CirculationRequirementContractError`), evaluates it, computes hashes with
`semanticJsonHash` at the worker layer, and validates the evidence.

- Identity: `projectId`, `sceneId`, `revisionId`, `sceneSpecVersion`,
  `sceneSpecHash`.
- Policies: `circulationPolicyVersion`, `spatialPolicyVersion`.
- `requirementSetHash`: hash of the canonical, already-sorted
  `circulationRequirements[]`.
- `graphSemanticHash`: hash of the 9B normalized graph.
- `requirements[]`: `requirementId`, `spaceId`, `startKind`, `endKind`,
  `resolvedStartXY`, `resolvedEndXY`, `status`, `startNodeId`, `endNodeId`,
  `distanceMm`, `orthogonalStepCount`, `diagonalStepCount`,
  `routeSemanticHash` (hash of the exact 9B route result), `failureCode`.
  The schema forces SATISFIED items to carry full route data with no
  failure code, and UNSATISFIED items to carry a failure code with no
  distance, step counts, or route hash.
- `status`.

No paths, node lists, DCC metadata, filesystem paths, or runtime data are
recorded.

## 9. No revision gate yet

`MoveObject`, `ReplaceAsset`, and `planSceneRevision()` do not enforce
`circulationRequirements`. Contract capability and enforcement are proven
separately; revision blocking belongs to a later spike.

## 10. No Golden migration

Historical SceneSpecs (Golden rev1-rev12 and other fixtures) are not
modified, and `circulationRequirements` is never injected into them: they
never carried circulation intent. rev12 stays v0.3 and no rev13 exists.
There is no automatic v0.3 to v0.4 migration and no SceneChangeSet
operation for requirements. The dedicated fixture
`tests/fixtures/circulation-requirements/scene-spec-v0.4.json` (a synthetic
studio, not a Golden revision) exercises both endpoint kinds.

## 11. Not a building-code claim

A canonical requirement means "project intent requires this deterministic
route under the named circulation policy". It does not mean code
compliant, accessible, fire safe, egress compliant, or NBC/IBC/ADA
compliant.
