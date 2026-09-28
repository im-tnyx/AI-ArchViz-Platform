import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isStrictlyInside } from "@ai-archviz/cad-interpreter";
import { semanticJsonHash } from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import { compileBuildPlanV02, compileGoldenBuildPlan } from "../../apps/worker/src/build-plan.js";
import {
  compileSurfaceMesh,
  type SurfaceMesh,
  SurfaceMeshError,
  triangulateSimplePolygon,
  type Vector2,
} from "../../apps/worker/src/surface-mesh.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
const goldenBase = read("tests/fixtures/living-room-golden/scene-spec.json");
const goldenRev13 = read(
  "tests/fixtures/living-room-golden/revisions/rev_golden_0013/scene-spec.json",
);
const polygonScene = read("tests/fixtures/polygon-surface-build/scene-spec.json");

const L: Vector2[] = [
  [0, 0],
  [6000, 0],
  [6000, 2000],
  [3500, 2000],
  [3500, 4500],
  [0, 4500],
];
const NOTCH_PROBE: Vector2 = [4750, 3250];

const surface = (boundary: Vector2[], overrides: Record<string, unknown> = {}) => ({
  id: "surface_test",
  type: "floor",
  boundary: boundary.map(([x, y]) => [x, y, 0]),
  elevation: 0,
  transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
  ...overrides,
});

const worldVertices = (mesh: SurfaceMesh, position: number[]) =>
  mesh.vertices.map(([x, y, z]) => [
    x + (position[0] as number),
    y + (position[1] as number),
    z + (position[2] as number),
  ]);

function triangleCovers(a: Vector2, b: Vector2, c: Vector2, point: Vector2): boolean {
  const cross = (o: Vector2, p: Vector2, q: Vector2) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  return cross(a, b, point) >= 0 && cross(b, c, point) >= 0 && cross(c, a, point) >= 0;
}

function surfaceCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SurfaceMeshError);
    return (error as SurfaceMeshError).code;
  }
  throw new Error("expected SurfaceMeshError");
}

describe("build plan v0.1 is preserved; v0.2 adds exact surface meshes", () => {
  it("keeps compileGoldenBuildPlan (v0.1) byte-for-byte semantically unchanged", () => {
    const base = compileGoldenBuildPlan(goldenBase);
    expect(base.buildPlanVersion).toBe("0.1.0");
    expect("surfaceMeshes" in base).toBe(false);
    // Frozen before the closure; v0.1 code was not modified.
    expect(semanticJsonHash(base)).toBe(
      "sha256:eda2f2f25389df83b32d00044e20e1ddc0a1d3021707451a2af8ba7515e6209a",
    );
    expect(semanticJsonHash(compileGoldenBuildPlan(goldenRev13))).toBe(
      "sha256:8e0d5cf3bdc639ca1e09b7742870e06c6cc314aadf19a3a4ed9eea581a974903",
    );
  });

  it("v0.2 = identical semantic content + version 0.2.0 + surfaceMeshes keyed by logicalId", () => {
    for (const scene of [goldenBase, goldenRev13, polygonScene]) {
      const { buildPlanVersion: legacyVersion, ...legacySemantic } = compileGoldenBuildPlan(scene);
      const { buildPlanVersion, surfaceMeshes, ...semantic } = compileBuildPlanV02(scene);
      expect(legacyVersion).toBe("0.1.0");
      expect(buildPlanVersion).toBe("0.2.0");
      expect(semantic).toEqual(legacySemantic);
      const surfaceIds = (scene.geometry as { id: string; type: string }[])
        .filter((entry) => entry.type === "floor" || entry.type === "ceiling")
        .map((entry) => entry.id)
        .sort((left, right) => left.localeCompare(right));
      expect(surfaceMeshes.map((mesh) => mesh.logicalId)).toEqual(surfaceIds);
    }
  });

  it("keeps semantic surface dimensions as the bounding box but never as physical geometry", () => {
    const plan = compileBuildPlanV02(polygonScene);
    const floorNode = plan.nodes.find((node) => node.logicalId === "surface_l_floor");
    const floorMesh = plan.surfaceMeshes.find((mesh) => mesh.logicalId === "surface_l_floor");
    expect(floorNode?.dimensions).toEqual([6000, 4500, 0]);
    // Bounding-box regression: the physical payload is the polygon, not the AABB.
    expect(floorMesh?.areaMm2).toBe(20_750_000);
    expect(floorMesh?.areaMm2).not.toBe(6000 * 4500);
    expect(floorMesh?.vertices).toHaveLength(6);
  });
});

describe("deterministic triangulation", () => {
  it("rectangle (Golden floor): 2 CCW triangles, exact area", () => {
    const [floor] = compileBuildPlanV02(goldenBase).surfaceMeshes.filter(
      (mesh) => mesh.type === "floor",
    );
    expect(floor).toEqual({
      logicalId: "surface_floor_main",
      type: "floor",
      vertices: [
        [0, 0, 0],
        [6000, 0, 0],
        [6000, 4500, 0],
        [0, 4500, 0],
      ],
      triangles: [
        [3, 0, 1],
        [1, 2, 3],
      ],
      elevationMm: 0,
      areaMm2: 27_000_000,
    });
  });

  it("concave L: 6 vertices, 4 frozen triangles, exact area, nothing in the notch", () => {
    const mesh = compileSurfaceMesh(surface(L));
    expect(mesh.vertices.map(([x, y]) => [x, y])).toEqual(L);
    expect(mesh.triangles).toEqual([
      [5, 0, 1],
      [1, 2, 3],
      [5, 1, 3],
      [3, 4, 5],
    ]);
    expect(mesh.areaMm2).toBe(20_750_000);
    for (const [a, b, c] of mesh.triangles) {
      const [pa, pb, pc] = [L[a], L[b], L[c]] as [Vector2, Vector2, Vector2];
      expect(triangleCovers(pa, pb, pc, NOTCH_PROBE)).toBe(false);
      const centroid: Vector2 = [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3];
      expect(isStrictlyInside(L, centroid)).toBe(true);
    }
    expect(
      mesh.triangles.some(([a, b, c]) =>
        triangleCovers(L[a] as Vector2, L[b] as Vector2, L[c] as Vector2, [1750, 3250]),
      ),
    ).toBe(true);
  });

  it("translated rectangle and non-axis-aligned trapezoid are exact", () => {
    const plan = compileBuildPlanV02(polygonScene);
    const byId = new Map(plan.surfaceMeshes.map((mesh) => [mesh.logicalId, mesh]));
    expect(byId.get("surface_offset_floor")).toMatchObject({
      vertices: [
        [8000, 1000, 0],
        [12000, 1000, 0],
        [12000, 4000, 0],
        [8000, 4000, 0],
      ],
      triangles: [
        [3, 0, 1],
        [1, 2, 3],
      ],
      areaMm2: 12_000_000,
    });
    expect(byId.get("surface_trapezoid_floor")).toMatchObject({
      vertices: [
        [14000, 0, 0],
        [19000, 0, 0],
        [18000, 3000, 0],
        [15000, 3000, 0],
      ],
      triangles: [
        [3, 0, 1],
        [1, 2, 3],
      ],
      areaMm2: 12_000_000,
    });
  });

  it("applies the surface transform exactly once: world vertices equal the canonical boundary", () => {
    const plan = compileBuildPlanV02(polygonScene);
    for (const entry of polygonScene.geometry.filter((g: { type: string }) => g.type !== "wall")) {
      const mesh = plan.surfaceMeshes.find(
        (candidate) => candidate.logicalId === entry.id,
      ) as SurfaceMesh;
      const world = worldVertices(mesh, entry.transform.position);
      expect(world).toEqual(entry.boundary.map(([x, y]: number[]) => [x, y, entry.elevation]));
    }
    // The pivot-at-corner ceiling has local vertices relative to that pivot.
    expect(
      plan.surfaceMeshes.find((mesh) => mesh.logicalId === "surface_offset_ceiling")?.vertices,
    ).toEqual([
      [0, 0, 0],
      [4000, 0, 0],
      [4000, 3000, 0],
      [0, 3000, 0],
    ]);
  });

  it("uses elevation as the only Z authority (Golden ceiling boundary z=0, elevation 3000)", () => {
    const ceiling = compileBuildPlanV02(goldenRev13).surfaceMeshes.find(
      (mesh) => mesh.type === "ceiling",
    ) as SurfaceMesh;
    expect(ceiling.elevationMm).toBe(3000);
    expect(worldVertices(ceiling, [0, 0, 3000]).every((vertex) => vertex[2] === 3000)).toBe(true);
  });

  it("every triangle is CCW (+Z), N-2 triangles, and coverage equals polygon area for many shapes", () => {
    const shapes: Vector2[][] = [
      L,
      [
        [0, 0],
        [3000, 0],
        [6000, 0],
        [6000, 4000],
        [0, 4000],
      ], // collinear vertex kept
      [
        [0, 0],
        [4000, 0],
        [4000, 1000],
        [1000, 1000],
        [1000, 3000],
        [4000, 3000],
        [4000, 4000],
        [0, 4000],
      ], // C shape
      [
        [0, 0],
        [5000, 1000],
        [4000, 5000],
        [2000, 2500],
        [-500, 4000],
      ], // concave, non-axis-aligned
    ];
    for (const shape of shapes) {
      for (const input of [shape, [...shape].reverse()]) {
        const triangles = triangulateSimplePolygon(input);
        expect(triangles).toHaveLength(input.length - 2);
        let covered = 0;
        for (const [a, b, c] of triangles) {
          const [pa, pb, pc] = [input[a], input[b], input[c]] as [Vector2, Vector2, Vector2];
          const doubled = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
          expect(doubled).toBeGreaterThan(0);
          covered += doubled / 2;
        }
        const mesh = compileSurfaceMesh(surface(input));
        expect(covered).toBeCloseTo(mesh.areaMm2, 6);
        expect(triangulateSimplePolygon(input)).toEqual(triangles);
      }
    }
  });

  it("is deterministic and never mutates the input surface", () => {
    const input = surface(L);
    const snapshot = JSON.stringify(input);
    const frozen = Object.freeze({
      ...input,
      boundary: Object.freeze(input.boundary.map((p) => Object.freeze(p))),
    });
    expect(compileSurfaceMesh(frozen)).toEqual(compileSurfaceMesh(input));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(compileBuildPlanV02(polygonScene)).toEqual(
      compileBuildPlanV02(structuredClone(polygonScene)),
    );
  });
});

describe("fail closed before any DCC", () => {
  it.each([
    [
      "bow-tie (self-intersection)",
      surface([
        [0, 0],
        [6000, 4500],
        [6000, 0],
        [0, 4500],
      ]),
      "SURFACE_BOUNDARY_INVALID",
    ],
    [
      "duplicate consecutive vertex",
      surface([
        [0, 0],
        [6000, 0],
        [6000, 0],
        [6000, 4500],
        [0, 4500],
      ]),
      "SURFACE_BOUNDARY_INVALID",
    ],
    [
      "two points",
      surface([
        [0, 0],
        [6000, 0],
      ]),
      "SURFACE_BOUNDARY_INVALID",
    ],
    [
      "zero area",
      surface([
        [0, 0],
        [3000, 0],
        [6000, 0],
      ]),
      "SURFACE_BOUNDARY_INVALID",
    ],
    [
      "non-finite coordinate",
      surface([
        [0, 0],
        [Number.NaN, 0],
        [6000, 4500],
      ]),
      "SURFACE_BOUNDARY_INVALID",
    ],
    [
      "non-coplanar boundary",
      { ...surface(L), boundary: L.map(([x, y], i) => [x, y, i === 2 ? 10 : 0]) },
      "SURFACE_BOUNDARY_INVALID",
    ],
    [
      "rotated surface",
      surface(L, {
        transform: { position: [0, 0, 0], rotationEuler: [0, 0, 90], scale: [1, 1, 1] },
      }),
      "SURFACE_TRANSFORM_UNSUPPORTED",
    ],
    [
      "scaled surface",
      surface(L, {
        transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 2, 1] },
      }),
      "SURFACE_TRANSFORM_UNSUPPORTED",
    ],
  ])("%s", (_name, input, code) => {
    expect(surfaceCode(() => compileSurfaceMesh(input))).toBe(code);
  });

  it("refuses a whole build plan when any surface is unrealizable", () => {
    const scene = structuredClone(polygonScene);
    scene.geometry.find((g: { id: string }) => g.id === "surface_trapezoid_floor").transform.scale =
      [2, 2, 1];
    expect(surfaceCode(() => compileBuildPlanV02(scene))).toBe("SURFACE_TRANSFORM_UNSUPPORTED");
  });
});

describe("shared pipeline and DCC-script static guards", () => {
  const goldenBuild = readFileSync(join(repositoryRoot, "apps/worker/src/golden-build.ts"), "utf8");
  const buildScript = readFileSync(
    join(repositoryRoot, "tools/3ds-max/python/build_scene.py"),
    "utf8",
  );
  const verifyScript = readFileSync(
    join(repositoryRoot, "tools/3ds-max/python/verify_scene.py"),
    "utf8",
  );

  it("the initial build compiles v0.2 and gates promotion on physical surface verification", () => {
    expect(goldenBuild).toMatch(/compileBuildPlanV02\(sceneSpec\)/);
    expect(goldenBuild).not.toMatch(/compileGoldenBuildPlan\(/);
    expect(goldenBuild).toMatch(/AI_ARCHVIZ_SCENE_SPEC_PATH: workspace\.sceneSpecPath/);
    expect(goldenBuild).toMatch(/"SURFACE_GEOMETRY_MISMATCH"/);
    expect(goldenBuild.indexOf('"SURFACE_GEOMETRY_MISMATCH"')).toBeLessThan(
      goldenBuild.indexOf("promoteCandidate("),
    );
    expect(goldenBuild).toMatch(/threeDsMaxBatchArguments\(/);
    expect(goldenBuild).toMatch(/buildDccChildEnvironment\(/);
    expect(goldenBuild).not.toMatch(/\.\.\.process\.env/);
  });

  it("v0.2 surfaces are editable meshes from surfaceMeshes, never bounding planes", () => {
    const meshFunction = buildScript.slice(
      buildScript.indexOf("def _create_surface_mesh"),
      buildScript.indexOf("def _create_proxy"),
    );
    expect(meshFunction).toMatch(/rt\.mesh\(vertices=vertices, faces=faces\)/);
    expect(meshFunction).not.toMatch(/Plane|dimensions/);
    expect(buildScript).toMatch(/SUPPORTED_BUILD_VERSIONS = \{"0\.1\.0", "0\.2\.0"\}/);
    expect(buildScript).not.toMatch(/execute\(|importFile|\.obj/i);
  });

  it("the fresh verifier is observation-only and checks physical geometry", () => {
    expect(verifyScript).not.toMatch(/saveMaxFile|convertTo|meshop\.weld|resetXForm/);
    expect(verifyScript).toMatch(/snapshotAsMesh/);
    for (const check of [
      "zero-area face",
      "boundary edges",
      "area expected",
      "elevation expected",
      "does not equal canonical boundary",
    ]) {
      expect(verifyScript).toContain(check);
    }
  });
});
