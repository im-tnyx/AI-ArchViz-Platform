# DCC Surface Realization (build plan v0.2)

## 1. Authority

A SceneSpec floor or ceiling is defined by its own canonical fields:

- `boundary`: the world-space polygon (the only shape authority);
- `elevation`: the only Z authority for the physical surface plane;
- `transform.position`: the node pivot.

The physical surface is never inferred from the space boundary, walls, a
bounding box, manifest dimensions, or the current DCC state.

## 2. The old limitation (build plan v0.1)

Build plan v0.1 compiled each surface to its XY bounding box
(`boundaryDimensions`), `build_scene.py` created an `rt.Plane` of that width
and length anchored at `transform.position`, and `verify_scene.py` accepted any
`Plane` with matching width, length, and position. That is exact only for an
axis-aligned rectangle whose minimum corner equals the transform position; an
L-shaped room would have been built with its notch filled and still verified.
Spike 10C therefore refused every non-rectangular or translated seed before
DCC. v0.1 keeps exactly this meaning (`compileGoldenBuildPlan`, still used by
the revision and renderer paths) and is never reinterpreted.

## 3. Build plan v0.2

`compileBuildPlanV02()` (`apps/worker/src/build-plan.ts`) returns the v0.1
semantic content unchanged plus `buildPlanVersion: "0.2.0"` and:

```json
"surfaceMeshes": [
  { "logicalId": "surface_l_floor", "type": "floor",
    "vertices": [[0,0,0],[6000,0,0],[6000,2000,0],[3500,2000,0],[3500,4500,0],[0,4500,0]],
    "triangles": [[5,0,1],[1,2,3],[5,1,3],[3,4,5]],
    "elevationMm": 0, "areaMm2": 20750000 }
]
```

The semantic floor/ceiling node keeps its v0.1 fields; its `dimensions`
remain the XY bounding box only so the semantic manifest (v0.1) is
unchanged. In v0.2 those dimensions are never used to create geometry: the
physical authority is `surfaceMeshes[logicalId]`. The triangulation payload is
not stored in `AIArchViz.ManifestEntry` and there is no manifest v0.2.
The initial build (`buildGoldenScene`) now always compiles v0.2.

## 4. Surface validation and transform policy

`compileSurfaceMesh()` (`apps/worker/src/surface-mesh.ts`) fails closed before
any DCC launch (`SURFACE_BOUNDARY_INVALID`, `SURFACE_TRANSFORM_UNSUPPORTED`,
`SURFACE_TRIANGULATION_FAILED`, surfaced as the execution-report error code):

- at least 3 finite points, all at one Z (one horizontal plane);
- a simple polygon under the same rules 10B uses (`polygonDefect` from
  `@ai-archviz/cad-interpreter`): no duplicate consecutive vertices, no
  zero-length edge, no self-intersection or fold-back, non-zero area;
- exactly one outer loop: SceneSpec has one boundary array and v0.2 has no
  hole or island semantics;
- `transform.rotationEuler` must be `[0,0,0]` and `transform.scale` `[1,1,1]`.
  Translation is allowed. There is no proven semantic for rotating or
  scaling a world-space boundary, so such a surface is refused rather than
  baked or double-applied (remaining limitation).

## 5. Vertex convention (frozen)

Vertices appear in exact canonical boundary order (never spatially sorted)
and are node-local relative to the canonical transform position `P`:

```text
local = [x - P.x, y - P.y, elevation - P.z]
```

The builder places the node at `P`, so realized world-space vertices equal
`[x, y, elevation]`. The boundary is world-space and the transform is the
pivot; it is applied exactly once (no double translation, no centering on a
bounding box, centroid, or first vertex).

## 6. Deterministic triangulation

Ear clipping over the remaining vertex list in canonical boundary order. Each
pass selects the FIRST vertex (lowest remaining-list position) whose ear is
strictly convex in the polygon's own winding and whose triangle contains no
other remaining vertex inside or on it. There is no randomness, so the same
input always yields the same triangle array.

- Every triangle is counter-clockwise in XY (+Z normal) for floors and
  ceilings alike; a clockwise input polygon is triangulated with reversed
  triangle order rather than reordered vertices. Normals carry no canonical
  architectural meaning, so ceilings are not flipped for render aesthetics.
- No vertex is removed or added: N boundary vertices give N - 2 triangles,
  including collinear boundary vertices. If no valid ear remains (a
  degenerate or collinear remainder), the surface is rejected.
- Compilation proves the triangulation: N - 2 triangles, every triangle has
  positive area, and the sum of triangle areas equals the polygon area. A
  partial or over-covering mesh is never emitted.

## 7. Realization in 3ds Max

For v0.2, `build_scene.py` creates each floor/ceiling as ONE managed
`Editable_mesh` node (`rt.mesh(vertices=..., faces=...)`, native pymxs; no
MAXScript strings, OBJ import, or external geometry file) named
`AVZ_<logicalId>`, placed at the canonical transform position. The triangles
are faces of that single node. All managed metadata, locks, and material
assignment are applied exactly as before. v0.1 plans still create the legacy
`Plane`.

## 8. Fresh physical verification and the promotion gate

The initial build passes the staged canonical SceneSpec to the fresh verifier
(`AI_ARCHVIZ_SCENE_SPEC_PATH`) as EXPECTED state. For every canonical
floor/ceiling the verifier resolves exactly one managed node, requires an
editable mesh, and observes its ACTUAL geometry with `snapshotAsMesh`
(world-space vertices and faces of a detached copy; the candidate is never
edited, welded, converted, or saved). It then independently checks:

- every observed vertex is at the canonical elevation (tolerance 0.01 mm);
- faces have valid indices, non-zero area, and one consistent winding;
- no edge is shared by more than two faces;
- the outer boundary, rebuilt from edges referenced by exactly one face, is
  one closed loop (no hole, no island) equal to the canonical boundary up to
  a cyclic start offset and orientation;
- the summed physical triangle area equals the canonical polygon area.

These catch a missing triangle, a shifted vertex, a filled concave notch, a
wrong elevation, and an overlapping extra triangle even when the bounding box
is identical. The verifier result records `surfaceVerification` per surface
(expected/observed boundary, elevation, area, vertex/face counts, observed
triangles, status). `buildGoldenScene` refuses promotion unless the verifier
succeeded AND `surfaceVerification.status` is PASS for every surface in the
plan (`SURFACE_GEOMETRY_MISMATCH`). Semantic-only callers that do not supply
the SceneSpec (the revision pipeline) keep the semantic check, which for an
editable mesh verifies node position and the observed bounding dimensions.

## 9. Proof

`pnpm test:3dsmax:polygon-surfaces` builds a dedicated fixture
(`tests/fixtures/polygon-surface-build/`) with a concave L room, a translated
rectangle (one surface pivoted at the origin, one at the min corner), and a
non-axis-aligned trapezoid, floor and ceiling each. It proves default-deny,
a forced bounding-box surface that fails fresh verification with zero
promotion, exact physical boundary/elevation/area for all six surfaces, the
absence of the L notch on the physically observed triangles, material
identity on the mesh, replay without a new DCC process, and no render.

## 10. Remaining limitations

- Surface rotation and scale are unsupported (refused before DCC).
- One simple outer loop per surface; no holes, islands, or nested loops.
- Surface thickness/extrusion remain as in v0.1 (thickness 0, no extrusion
  geometry).
