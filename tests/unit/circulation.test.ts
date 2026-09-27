import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  semanticJsonHash,
  validateCirculationAnalysisEvidence,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import { circulationAnalysisEvidence, planSceneRevision } from "../../apps/worker/src/index.js";
import {
  analyzeCirculation,
  CIRCULATION_AGENT_RADIUS_MM,
  CIRCULATION_GRID_STEP_MM,
  CIRCULATION_POLICY_VERSION,
  CIRCULATION_SNAP_DISTANCE_MM,
  type CirculationRouteQuery,
  distancePointToPolygonBoundary,
  distancePointToRectangle,
  distanceSegmentToPolygonBoundary,
  distanceSegmentToRectangle,
  findCirculationRoute,
  type Point2,
  SPATIAL_EPSILON_MM,
  validateSpatialScene,
} from "../../packages/spatial-engine/src/index.js";

type Scene = Record<string, unknown>;
const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function fixture(path: string): Scene {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Scene;
}

function rev12Scene(): Scene {
  return fixture("revisions/rev_golden_0012/scene-spec.json");
}

function withAssetPosition(
  scene: Scene,
  assetId: string,
  position: [number, number, number],
): Scene {
  const clone = structuredClone(scene);
  const asset = (clone.assets as Array<{ id: string; transform: { position: number[] } }>).find(
    (entry) => entry.id === assetId,
  );
  if (!asset) throw new Error(`missing ${assetId}`);
  asset.transform.position = position;
  return clone;
}

interface Box {
  id: string;
  center: [number, number];
  size: [number, number];
  rotation?: number;
}

/** Synthetic single-space scene; walls follow the CCW boundary so their interior side faces the room. */
function syntheticScene(
  boundary: Array<[number, number]>,
  boxes: Box[],
  doors: Array<{ id: string; wallIndex: number; offset: number; width: number }> = [],
): Scene {
  const spaceId = "space_synthetic";
  return {
    sceneSpecVersion: "0.3.0",
    project: { id: "project_synthetic" },
    scene: { id: "scene_synthetic", revisionId: "rev_synthetic_0001" },
    spaces: [{ id: spaceId, boundary: boundary.map(([x, y]) => [x, y, 0]) }],
    geometry: boundary.map((point, index) => {
      const next = boundary[(index + 1) % boundary.length] as [number, number];
      return {
        id: `wall_${index}`,
        type: "wall",
        spaceId,
        start: [point[0], point[1], 0],
        end: [next[0], next[1], 0],
      };
    }),
    openings: doors.map((door) => ({
      id: door.id,
      type: "door",
      hostGeometryId: `wall_${door.wallIndex}`,
      offset: door.offset,
      width: door.width,
    })),
    assetDefinitions: boxes.map((box) => ({
      id: `assetdef_${box.id}`,
      dimensions: [box.size[0], box.size[1], 500],
      pivotPolicy: "floor_center",
    })),
    assets: boxes.map((box) => ({
      id: box.id,
      type: "proxy_asset",
      assetDefinitionId: `assetdef_${box.id}`,
      spaceId,
      transform: {
        position: [box.center[0], box.center[1], 0],
        rotationEuler: [0, 0, box.rotation ?? 0],
        scale: [1, 1, 1],
      },
    })),
  };
}

function rectangle(width: number, height: number): Array<[number, number]> {
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
}

/** Two barrier blocks at x=2800..3200 spanning wall-to-wall except a gap of `gapMm` centered at y=1500. */
function corridorScene(gapMm: number): Scene {
  const lowerTop = 1500 - gapMm / 2;
  const upperBottom = 1500 + gapMm / 2;
  return syntheticScene(rectangle(6000, 3000), [
    { id: "asset_barrier_lower", center: [3000, lowerTop / 2], size: [400, lowerTop] },
    {
      id: "asset_barrier_upper",
      center: [3000, (upperBottom + 3000) / 2],
      size: [400, 3000 - upperBottom],
    },
  ]);
}

function nodeIndices(nodeId: string): [number, number] {
  const [, ix, iy] = nodeId.split("::");
  return [Number(ix), Number(iy)];
}

function nodePoint(origin: Point2, nodeId: string): Point2 {
  const [ix, iy] = nodeIndices(nodeId);
  return [
    origin[0] + (ix + 0.5) * CIRCULATION_GRID_STEP_MM,
    origin[1] + (iy + 0.5) * CIRCULATION_GRID_STEP_MM,
  ];
}

function spacePolygon(scene: Scene, spaceId: string): Point2[] {
  const space = (scene.spaces as Array<{ id: string; boundary: number[][] }>).find(
    (entry) => entry.id === spaceId,
  );
  return (space?.boundary ?? []).map((point) => [point[0] as number, point[1] as number]);
}

/** Independent exact check that every path point and movement segment keeps full probe clearance. */
function expectPathClear(scene: Scene, spaceId: string, points: readonly Point2[]): void {
  const polygon = spacePolygon(scene, spaceId);
  const obstacles = validateSpatialScene(scene).assetFootprints.map((entry) => entry.cornersXY);
  const minimum = CIRCULATION_AGENT_RADIUS_MM - SPATIAL_EPSILON_MM;
  points.forEach((point, index) => {
    expect(distancePointToPolygonBoundary(point, polygon)).toBeGreaterThanOrEqual(minimum);
    for (const corners of obstacles) {
      expect(distancePointToRectangle(point, corners)).toBeGreaterThanOrEqual(minimum);
    }
    const next = points[index + 1];
    if (!next) return;
    expect(distanceSegmentToPolygonBoundary(point, next, polygon)).toBeGreaterThanOrEqual(minimum);
    for (const corners of obstacles) {
      expect(distanceSegmentToRectangle(point, next, corners)).toBeGreaterThanOrEqual(minimum);
    }
  });
}

function expectAdjacentSteps(nodeIds: readonly string[]): void {
  for (let index = 1; index < nodeIds.length; index += 1) {
    const [ax, ay] = nodeIndices(nodeIds[index - 1] as string);
    const [bx, by] = nodeIndices(nodeIds[index] as string);
    expect(Math.max(Math.abs(ax - bx), Math.abs(ay - by))).toBe(1);
  }
}

const goldenSpace = "space_living_main";
const goldenRouteTarget: Point2 = [5000, 1500];

describe("circulation-policy-v0.1 constants", () => {
  it("freezes the policy version, grid step, probe radius, snap distance, and reuses the 9A epsilon", () => {
    expect(CIRCULATION_POLICY_VERSION).toBe("circulation-policy-v0.1");
    expect(CIRCULATION_GRID_STEP_MM).toBe(100);
    expect(CIRCULATION_AGENT_RADIUS_MM).toBe(300);
    expect(CIRCULATION_SNAP_DISTANCE_MM).toBe(100 * Math.SQRT2);
    expect(SPATIAL_EPSILON_MM).toBe(0.001);
  });
});

describe("Technical Spike 9B: Golden rev12 circulation analysis", () => {
  it("passes with one walkable component and a resolved opening_d01 interior portal", () => {
    const result = analyzeCirculation(rev12Scene());
    expect(result).toMatchObject({
      policyVersion: "circulation-policy-v0.1",
      spatialPolicyVersion: "spatial-policy-v0.1",
      spatialValidationStatus: "PASS",
      sceneSpecVersion: "0.3.0",
      revisionId: "rev_golden_0012",
      gridStepMm: 100,
      agentRadiusMm: 300,
      status: "PASS",
      violations: [],
    });
    expect(result.spaces).toEqual([
      {
        spaceId: goldenSpace,
        gridOriginXY: [0, 0],
        gridSize: [60, 45],
        walkableNodeCount: 1394,
        edgeCount: 5126,
        componentCount: 1,
        components: [{ componentId: "space_living_main::3::3", nodeCount: 1394 }],
        doorPortals: [
          {
            openingId: "opening_d01",
            spaceId: goldenSpace,
            // Midpoint of the clearance's two into-room corners (900,1200)/(900,2100).
            portalXY: [900, 1650],
            status: "RESOLVED",
            // (850,1650) and (950,1650) tie at 50mm; the lower node in frozen order wins.
            nodeId: "space_living_main::8::16",
            componentId: "space_living_main::3::3",
          },
        ],
      },
    ]);
  });

  it("creates no portal for the window opening_w01", () => {
    const result = analyzeCirculation(rev12Scene());
    const openingIds = result.spaces.flatMap((space) =>
      space.doorPortals.map((portal) => portal.openingId),
    );
    expect(openingIds).toEqual(["opening_d01"]);
  });

  it("keeps every walkable node at full probe clearance from walls and all three proxy footprints", () => {
    const scene = rev12Scene();
    const result = analyzeCirculation(scene);
    const space = result.graph.spaces[0];
    if (!space) throw new Error("space missing");
    const polygon = spacePolygon(scene, goldenSpace);
    const obstacles = validateSpatialScene(scene).assetFootprints.map((entry) => entry.cornersXY);
    for (const nodeId of space.nodes) {
      const point = nodePoint(space.gridOriginXY, nodeId);
      expect(distancePointToPolygonBoundary(point, polygon)).toBeGreaterThanOrEqual(300 - 0.001);
      for (const corners of obstacles) {
        expect(distancePointToRectangle(point, corners)).toBeGreaterThanOrEqual(300 - 0.001);
      }
    }
  });
});

describe("Technical Spike 9B: Golden doorway route", () => {
  function goldenRoute(): ReturnType<typeof findCirculationRoute> {
    const scene = rev12Scene();
    const portal = analyzeCirculation(scene).spaces[0]?.doorPortals[0];
    if (!portal) throw new Error("portal missing");
    return findCirculationRoute(scene, {
      spaceId: goldenSpace,
      startXY: portal.portalXY,
      endXY: goldenRouteTarget,
    });
  }

  it("routes from the derived opening_d01 portal to a frozen clear test point", () => {
    const route = goldenRoute();
    expect(route).toMatchObject({
      policyVersion: "circulation-policy-v0.1",
      spaceId: goldenSpace,
      requestedStartXY: [900, 1650],
      requestedEndXY: [5000, 1500],
      status: "PASS",
      reachable: true,
      startNodeId: "space_living_main::8::16",
      endNodeId: "space_living_main::49::14",
      distanceMm: 4182.842712,
      orthogonalStepCount: 39,
      diagonalStepCount: 2,
      violations: [],
    });
    expect(route.path.nodeIds[0]).toBe(route.startNodeId);
    expect(route.path.nodeIds.at(-1)).toBe(route.endNodeId);
    expect(route.path.nodeIds).toHaveLength(42);
    expectAdjacentSteps(route.path.nodeIds);
    expectPathClear(rev12Scene(), goldenSpace, route.path.pointsXY);
  });

  it("is deterministic across repeated calls", () => {
    expect(goldenRoute()).toEqual(goldenRoute());
  });
});

describe("Technical Spike 9B: collision-free is not circulation-accessible", () => {
  it("returns CIRCULATION_NO_ROUTE across a 500mm gap even though spatial-policy-v0.1 passes", () => {
    const scene = corridorScene(500);
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const route = findCirculationRoute(scene, {
      spaceId: "space_synthetic",
      startXY: [1000, 1500],
      endXY: [5000, 1500],
    });
    expect(route.status).toBe("FAILED");
    expect(route.reachable).toBe(false);
    expect(route.startNodeId).not.toBeNull();
    expect(route.endNodeId).not.toBeNull();
    expect(route.distanceMm).toBeNull();
    expect(route.path).toEqual({ nodeIds: [], pointsXY: [] });
    expect(route.violations.map((violation) => violation.code)).toEqual(["CIRCULATION_NO_ROUTE"]);
  });

  it("finds a route through a 1000mm gap, well above the 600mm probe diameter plus grid spacing", () => {
    const scene = corridorScene(1000);
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const route = findCirculationRoute(scene, {
      spaceId: "space_synthetic",
      startXY: [1000, 1500],
      endXY: [5000, 1500],
    });
    expect(route.status).toBe("PASS");
    expect(route.reachable).toBe(true);
    const throughGap = route.path.pointsXY.filter(([x]) => x >= 2800 && x <= 3200);
    expect(throughGap.length).toBeGreaterThan(0);
    for (const [, y] of throughGap) {
      expect(y).toBeGreaterThanOrEqual(1300);
      expect(y).toBeLessThanOrEqual(1700);
    }
    expectPathClear(scene, "space_synthetic", route.path.pointsXY);
  });
});

describe("Technical Spike 9B: rotated obstacle uses the exact 9A OBB", () => {
  // 1000x1000 square rotated 45deg: a diamond whose world AABB is ~1414x1414.
  const diamond = syntheticScene(rectangle(6000, 3000), [
    { id: "asset_rotated_block", center: [3000, 1500], size: [1000, 1000], rotation: 45 },
  ]);
  const insideAabbOnly: Point2 = [3650, 2150];

  it("treats a point inside the AABB but clear of the OBB as a walkable node and routable endpoint", () => {
    const corners = validateSpatialScene(diamond).assetFootprints[0]?.cornersXY;
    if (!corners) throw new Error("footprint missing");
    const xs = corners.map((corner) => corner[0]);
    const ys = corners.map((corner) => corner[1]);
    // An AABB-only obstacle would contain this point (clearance 0) and reject it.
    expect(insideAabbOnly[0]).toBeGreaterThan(Math.min(...xs));
    expect(insideAabbOnly[0]).toBeLessThan(Math.max(...xs));
    expect(insideAabbOnly[1]).toBeGreaterThan(Math.min(...ys));
    expect(insideAabbOnly[1]).toBeLessThan(Math.max(...ys));
    expect(distancePointToRectangle(insideAabbOnly, corners)).toBeGreaterThan(400);

    const graph = analyzeCirculation(diamond).graph.spaces[0];
    expect(graph?.nodes).toContain("space_synthetic::36::21");

    const route = findCirculationRoute(diamond, {
      spaceId: "space_synthetic",
      startXY: [1000, 1500],
      endXY: insideAabbOnly,
    });
    expect(route.status).toBe("PASS");
    expect(route.endNodeId).toBe("space_synthetic::36::21");
    expectPathClear(diamond, "space_synthetic", route.path.pointsXY);
  });

  it("still blocks an endpoint that is genuinely within probe clearance of the rotated OBB", () => {
    const route = findCirculationRoute(diamond, {
      spaceId: "space_synthetic",
      startXY: [1000, 1500],
      endXY: [3550, 2050],
    });
    expect(route.violations.map((violation) => violation.code)).toEqual([
      "CIRCULATION_ENDPOINT_BLOCKED",
    ]);
  });
});

describe("Technical Spike 9B: concave space", () => {
  const lShape: Array<[number, number]> = [
    [0, 0],
    [4000, 0],
    [4000, 2000],
    [2000, 2000],
    [2000, 4000],
    [0, 4000],
  ];
  const scene = syntheticScene(lShape, []);
  const start: Point2 = [3500, 1000];
  const end: Point2 = [1000, 3500];

  it("builds no walkable node inside the exterior notch or within probe radius of the reflex corner", () => {
    const space = analyzeCirculation(scene).graph.spaces[0];
    if (!space) throw new Error("space missing");
    expect(space.nodes.length).toBeGreaterThan(0);
    const polygon = spacePolygon(scene, "space_synthetic");
    for (const nodeId of space.nodes) {
      const [x, y] = nodePoint(space.gridOriginXY, nodeId);
      expect(x > 2000 && y > 2000).toBe(false);
      expect(Math.hypot(x - 2000, y - 2000)).toBeGreaterThanOrEqual(300 - 0.001);
      expect(distancePointToPolygonBoundary([x, y], polygon)).toBeGreaterThanOrEqual(300 - 0.001);
    }
  });

  it("routes around the reflex corner, never across the notch", () => {
    const polygon = spacePolygon(scene, "space_synthetic");
    // The straight shortcut leaves the polygon, so it can never be a valid movement.
    expect(distanceSegmentToPolygonBoundary(start, end, polygon)).toBe(0);
    const route = findCirculationRoute(scene, {
      spaceId: "space_synthetic",
      startXY: start,
      endXY: end,
    });
    expect(route.status).toBe("PASS");
    expect(route.distanceMm).toBeGreaterThan(Math.hypot(end[0] - start[0], end[1] - start[1]));
    expectAdjacentSteps(route.path.nodeIds);
    expectPathClear(scene, "space_synthetic", route.path.pointsXY);
    for (const point of route.path.pointsXY) {
      expect(Math.hypot(point[0] - 2000, point[1] - 2000)).toBeGreaterThanOrEqual(300 - 0.001);
    }
  });
});

describe("Technical Spike 9B: door portal resolution", () => {
  it("reports CIRCULATION_PORTAL_BLOCKED when furniture sits flush against the doorway clearance", () => {
    // Coffee table spans x:[900,2100]: it touches (does not enter) the opening_d01
    // clearance, so spatial-policy-v0.1 passes, but the portal at (900,1650) has no probe clearance.
    const scene = withAssetPosition(
      rev12Scene(),
      "asset_living_coffee_table_main",
      [1500, 1650, 0],
    );
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const result = analyzeCirculation(scene);
    expect(result.status).toBe("FAILED");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      code: "CIRCULATION_PORTAL_BLOCKED",
      openingId: "opening_d01",
      spaceId: goldenSpace,
      portalXY: [900, 1650],
    });
    expect(result.violations[0]?.message).not.toMatch(/code|complian|ada\b|egress|ibc|nbc/iu);
    expect(result.spaces[0]?.doorPortals[0]).toMatchObject({
      status: "BLOCKED",
      nodeId: null,
      componentId: null,
    });
  });

  it("blocks a portal whose clearance depth (door width) is under the probe radius", () => {
    // A 250mm door places its interior portal 250mm from the wall, inside the 300mm probe radius.
    const scene = syntheticScene(
      rectangle(4000, 4000),
      [],
      [{ id: "opening_narrow", wallIndex: 3, offset: 1500, width: 250 }],
    );
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const result = analyzeCirculation(scene);
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "CIRCULATION_PORTAL_BLOCKED",
    ]);
  });

  it("resolves a portal for an ordinary door into an open room", () => {
    const scene = syntheticScene(
      rectangle(4000, 4000),
      [],
      [{ id: "opening_standard", wallIndex: 3, offset: 1500, width: 900 }],
    );
    const result = analyzeCirculation(scene);
    expect(result.status).toBe("PASS");
    expect(result.spaces[0]?.doorPortals[0]?.status).toBe("RESOLVED");
  });
});

describe("Technical Spike 9B: route endpoint validity", () => {
  const scene = rev12Scene();
  const query = (startXY: Point2): CirculationRouteQuery => ({
    spaceId: goldenSpace,
    startXY,
    endXY: goldenRouteTarget,
  });

  it("rejects a start point inside an asset footprint", () => {
    const route = findCirculationRoute(scene, query([3300, 2200]));
    expect(route.violations).toEqual([
      expect.objectContaining({
        code: "CIRCULATION_ENDPOINT_BLOCKED",
        endpoint: "start",
        pointXY: [3300, 2200],
      }),
    ]);
    expect(route.startNodeId).toBeNull();
  });

  it("rejects a point 250mm from the coffee table instead of snapping to a walkable node 112mm away", () => {
    const blocked: Point2 = [4150, 2200];
    const nearbyNode = "space_living_main::42::21"; // (4250,2150)
    const graph = analyzeCirculation(scene).graph.spaces[0];
    expect(graph?.nodes).toContain(nearbyNode);
    expect(Math.hypot(4250 - blocked[0], 2150 - blocked[1])).toBeLessThan(
      CIRCULATION_SNAP_DISTANCE_MM,
    );
    const route = findCirculationRoute(scene, query(blocked));
    expect(route.violations.map((violation) => violation.code)).toEqual([
      "CIRCULATION_ENDPOINT_BLOCKED",
    ]);
    expect(route.reachable).toBe(false);
  });

  it("rejects a point outside the eroded space", () => {
    const route = findCirculationRoute(scene, query([100, 2000]));
    expect(route.violations.map((violation) => violation.code)).toEqual([
      "CIRCULATION_ENDPOINT_BLOCKED",
    ]);
  });

  it("reports CIRCULATION_ENDPOINT_UNRESOLVABLE for a valid point with no walkable node in snap range", () => {
    // A 600mm corridor between y=1200 and y=1800: y=1500 is a valid probe center,
    // but grid rows y=1450/1550 are only 250mm from a block, so nothing resolves.
    const corridor = syntheticScene(rectangle(6000, 3000), [
      { id: "asset_block_lower", center: [3500, 600], size: [4000, 1200] },
      { id: "asset_block_upper", center: [3500, 2400], size: [4000, 1200] },
    ]);
    expect(validateSpatialScene(corridor).status).toBe("PASS");
    const route = findCirculationRoute(corridor, {
      spaceId: "space_synthetic",
      startXY: [3500, 1500],
      endXY: [750, 1500],
    });
    expect(route.startNodeId).toBeNull();
    expect(route.endNodeId).not.toBeNull();
    expect(route.violations.map((violation) => violation.code)).toEqual([
      "CIRCULATION_ENDPOINT_UNRESOLVABLE",
    ]);
  });

  it("reports CIRCULATION_SPACE_NOT_FOUND for an unknown space", () => {
    const route = findCirculationRoute(scene, { ...query([1500, 1500]), spaceId: "space_missing" });
    expect(route.violations.map((violation) => violation.code)).toEqual([
      "CIRCULATION_SPACE_NOT_FOUND",
    ]);
  });
});

describe("Technical Spike 9B: connected components", () => {
  it("assigns distinct stable IDs to the two sides of a blocked corridor, independent of source order", () => {
    const scene = corridorScene(500);
    const reordered = structuredClone(scene);
    (reordered.assets as unknown[]).reverse();
    (reordered.assetDefinitions as unknown[]).reverse();
    (reordered.geometry as unknown[]).reverse();
    const first = analyzeCirculation(scene).spaces[0]?.components;
    expect(first).toEqual([
      { componentId: "space_synthetic::3::3", nodeCount: expect.any(Number) },
      // (3450,1450) sits in the gap mouth 320mm from the barrier corner, so it is the
      // lowest node in frozen order on the far side.
      { componentId: "space_synthetic::34::14", nodeCount: expect.any(Number) },
    ]);
    expect(analyzeCirculation(scene).spaces[0]?.components).toEqual(first);
    expect(analyzeCirculation(reordered).spaces[0]?.components).toEqual(first);
  });
});

describe("Technical Spike 9B: deterministic equal-cost tie-break", () => {
  // Mirror-symmetric about y=1550, which is itself a grid row (3100mm room).
  const symmetric = syntheticScene(rectangle(6000, 3100), [
    { id: "asset_center_block", center: [3000, 1550], size: [1000, 1000] },
    { id: "asset_corner_low", center: [5800, 200], size: [200, 200] },
    { id: "asset_corner_high", center: [5800, 2900], size: [200, 200] },
  ]);
  const query: CirculationRouteQuery = {
    spaceId: "space_synthetic",
    startXY: [500, 1550],
    endXY: [5500, 1550],
  };

  it("chooses one of two genuinely equal-cost mirrored routes, identically every time", () => {
    const route = findCirculationRoute(symmetric, query);
    expect(route.status).toBe("PASS");
    const graph = analyzeCirculation(symmetric).graph.spaces[0];
    if (!graph) throw new Error("space missing");
    const nodes = new Set(graph.nodes);
    const edges = new Set(graph.edges.map(([a, b]) => `${a}|${b}`));
    const mirrored = route.path.nodeIds.map((nodeId) => {
      const [ix, iy] = nodeIndices(nodeId);
      return `space_synthetic::${ix}::${30 - iy}`;
    });
    // The mirror image is a different, valid path with exactly the same step counts.
    expect(mirrored).not.toEqual(route.path.nodeIds);
    for (const nodeId of mirrored) expect(nodes.has(nodeId)).toBe(true);
    for (let index = 1; index < mirrored.length; index += 1) {
      const a = mirrored[index - 1] as string;
      const b = mirrored[index] as string;
      expect(edges.has(`${a}|${b}`) || edges.has(`${b}|${a}`)).toBe(true);
    }
    for (let run = 0; run < 3; run += 1) {
      expect(findCirculationRoute(symmetric, query)).toEqual(route);
    }
  });

  it("returns the exact same path when assets and definitions are reordered", () => {
    const reordered = structuredClone(symmetric);
    (reordered.assets as unknown[]).reverse();
    (reordered.assetDefinitions as unknown[]).reverse();
    expect(findCirculationRoute(reordered, query)).toEqual(findCirculationRoute(symmetric, query));
  });
});

describe("Technical Spike 9B: input order determinism and immutability", () => {
  function reorderedRev12(): Scene {
    const scene = rev12Scene();
    for (const key of ["assets", "assetDefinitions", "openings", "geometry"]) {
      (scene[key] as unknown[]).reverse();
    }
    return scene;
  }
  const routeQuery: CirculationRouteQuery = {
    spaceId: goldenSpace,
    startXY: [900, 1650],
    endXY: goldenRouteTarget,
  };

  it("produces the same analysis, graphSemanticHash, and route for reordered source arrays", () => {
    const original = rev12Scene();
    const reordered = reorderedRev12();
    expect(analyzeCirculation(reordered)).toEqual(analyzeCirculation(original));
    expect(circulationAnalysisEvidence(reordered).graphSemanticHash).toBe(
      circulationAnalysisEvidence(original).graphSemanticHash,
    );
    expect(findCirculationRoute(reordered, routeQuery)).toEqual(
      findCirculationRoute(original, routeQuery),
    );
  });

  it("never mutates the input SceneSpec", () => {
    for (const scene of [rev12Scene(), reorderedRev12(), corridorScene(500)]) {
      const before = structuredClone(scene);
      analyzeCirculation(scene);
      findCirculationRoute(scene, {
        ...routeQuery,
        spaceId: (before.spaces as Array<{ id: string }>)[0]?.id ?? "",
      });
      circulationAnalysisEvidence(scene);
      expect(scene).toEqual(before);
    }
  });
});

describe("Technical Spike 9B: source spatial validity", () => {
  it("builds no graph when spatial-policy-v0.1 fails", () => {
    const scene = withAssetPosition(
      rev12Scene(),
      "asset_living_coffee_table_main",
      [3000, 3350, 0],
    );
    expect(validateSpatialScene(scene).status).toBe("FAILED");
    const result = analyzeCirculation(scene);
    expect(result).toMatchObject({
      status: "FAILED",
      spatialValidationStatus: "FAILED",
      spaces: [],
      violations: [expect.objectContaining({ code: "CIRCULATION_SOURCE_SPATIAL_INVALID" })],
    });
    expect(result.graph.spaces).toEqual([]);
    const route = findCirculationRoute(scene, {
      spaceId: goldenSpace,
      startXY: [900, 1650],
      endXY: goldenRouteTarget,
    });
    expect(route.violations.map((violation) => violation.code)).toEqual([
      "CIRCULATION_SOURCE_SPATIAL_INVALID",
    ]);
  });
});

describe("circulation-analysis-evidence-v0.1", () => {
  const frozenGoldenGraphHash =
    "sha256:eb8060e47781de4ed6659ba08dec07644d1fe4887508ceae2cdb5af886281895";

  it("is compact, schema-valid, and commits to the full graph only through graphSemanticHash", () => {
    const scene = rev12Scene();
    const evidence = circulationAnalysisEvidence(scene);
    expect(validateCirculationAnalysisEvidence(evidence).ok).toBe(true);
    expect(evidence).toMatchObject({
      evidenceVersion: "0.1.0",
      policyVersion: "circulation-policy-v0.1",
      spatialPolicyVersion: "spatial-policy-v0.1",
      spatialValidationStatus: "PASS",
      gridStepMm: 100,
      agentRadiusMm: 300,
      status: "PASS",
      sceneSpecHash: semanticJsonHash(scene),
      graphSemanticHash: frozenGoldenGraphHash,
    });
    expect(evidence.graphSemanticHash).toBe(semanticJsonHash(analyzeCirculation(scene).graph));
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/"nodes"|"edges"|"path"/u);
    expect(serialized.length).toBeLessThan(4096);
    expect(circulationAnalysisEvidence(rev12Scene())).toEqual(evidence);
  });

  it("validates FAILED evidence for portal-blocked and spatially invalid sources", () => {
    const blocked = withAssetPosition(
      rev12Scene(),
      "asset_living_coffee_table_main",
      [1500, 1650, 0],
    );
    const invalid = withAssetPosition(
      rev12Scene(),
      "asset_living_coffee_table_main",
      [3000, 3350, 0],
    );
    for (const scene of [blocked, invalid]) {
      const evidence = circulationAnalysisEvidence(scene);
      expect(evidence.status).toBe("FAILED");
      expect(validateCirculationAnalysisEvidence(evidence).ok).toBe(true);
    }
  });
});

describe("Technical Spike 9B: no implicit revision gate", () => {
  it("still plans a 9A-valid MoveObject even though it blocks the door portal for the circulation probe", () => {
    const rev12 = rev12Scene();
    const changeSet = fixture("changesets/move-coffee-table-r2.json") as {
      baseRevisionId: string;
      targetRevisionId: string;
      operations: Array<{ parameters: { transform: unknown } }>;
    };
    changeSet.baseRevisionId = "rev_golden_0012";
    changeSet.targetRevisionId = "rev_golden_0099_test_only";
    const transform = { position: [1500, 1650, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
    const operation = changeSet.operations[0];
    if (!operation) throw new Error("MoveObject operation missing");
    operation.parameters.transform = transform;
    expect(
      analyzeCirculation(
        withAssetPosition(rev12, "asset_living_coffee_table_main", [1500, 1650, 0]),
      ).violations[0]?.code,
    ).toBe("CIRCULATION_PORTAL_BLOCKED");
    const result = planSceneRevision(rev12, changeSet as unknown as Record<string, unknown>);
    expect(result.plan.operation.type).toBe("MoveObject");
  });
});

describe("Technical Spike 9B: purity boundary", () => {
  it("keeps the spatial engine free of runtime dependencies and host/OS/network/process access", () => {
    const packageRoot = resolve("packages/spatial-engine");
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    const sourceRoot = resolve(packageRoot, "src");
    for (const file of readdirSync(sourceRoot)) {
      const text = readFileSync(resolve(sourceRoot, file), "utf8");
      for (const specifier of text.matchAll(/from\s+"([^"]+)"/gu)) {
        expect(specifier[1]).toMatch(/^\.\/[a-z-]+\.js$/u);
      }
      expect(text).not.toMatch(/\bprocess\.|\beval\(|new Function|\bfetch\(|\brequire\(|import\(/u);
    }
  });
});

describe("Technical Spike 9B: edge rules", () => {
  it("never creates a diagonal edge unless both orthogonal cells are walkable", () => {
    for (const scene of [rev12Scene(), corridorScene(1000)]) {
      const space = analyzeCirculation(scene).graph.spaces[0];
      if (!space) throw new Error("space missing");
      const nodes = new Set(space.nodes);
      const spaceId = space.spaceId;
      let diagonalCount = 0;
      for (const [a, b] of space.edges) {
        const [ax, ay] = nodeIndices(a);
        const [bx, by] = nodeIndices(b);
        if (ax === bx || ay === by) continue;
        diagonalCount += 1;
        expect(nodes.has(`${spaceId}::${bx}::${ay}`)).toBe(true);
        expect(nodes.has(`${spaceId}::${ax}::${by}`)).toBe(true);
      }
      expect(diagonalCount).toBeGreaterThan(0);
    }
  });

  it("rejects a movement edge between two walkable nodes when the swept segment loses probe clearance", () => {
    // A 2x2mm post whose lower edge is 297mm above the segment (950,950)-(1050,950):
    // both endpoints are ~301mm from the post, but the segment midpoint is only 297mm away.
    const scene = syntheticScene(rectangle(2000, 2000), [
      { id: "asset_thin_post", center: [1000, 1248], size: [2, 2] },
    ]);
    const post = validateSpatialScene(scene).assetFootprints[0]?.cornersXY;
    if (!post) throw new Error("footprint missing");
    const a: Point2 = [950, 950];
    const b: Point2 = [1050, 950];
    expect(distancePointToRectangle(a, post)).toBeGreaterThanOrEqual(300);
    expect(distancePointToRectangle(b, post)).toBeGreaterThanOrEqual(300);
    expect(distanceSegmentToRectangle(a, b, post)).toBeLessThan(300);

    const space = analyzeCirculation(scene).graph.spaces[0];
    if (!space) throw new Error("space missing");
    expect(space.nodes).toContain("space_synthetic::9::9");
    expect(space.nodes).toContain("space_synthetic::10::9");
    expect(space.edges).not.toContainEqual(["space_synthetic::9::9", "space_synthetic::10::9"]);

    const route = findCirculationRoute(scene, { spaceId: "space_synthetic", startXY: a, endXY: b });
    expect(route.status).toBe("PASS");
    expect(route.distanceMm).toBeGreaterThan(100);
    expectPathClear(scene, "space_synthetic", route.path.pointsXY);
  });
});
