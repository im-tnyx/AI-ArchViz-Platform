import {
  distancePointToPolygonBoundary,
  distancePointToRectangle,
  distanceSegmentToPolygonBoundary,
  distanceSegmentToRectangle,
  pointStrictlyInsidePolygon,
  SPATIAL_EPSILON_MM,
  SPATIAL_POLICY_VERSION,
} from "./geometry.js";
import type { DoorwayClearance, Point2, SpaceInput, SpatialSceneInput } from "./types.js";
import { validateSpatialScene } from "./validate.js";

/**
 * circulation-policy-v0.1 (Technical Spike 9B). Grid step and agent radius
 * are deterministic engineering policy parameters for a software access
 * probe. They are NOT building-code, accessibility, ergonomic, or
 * human-body standards.
 */
export const CIRCULATION_POLICY_VERSION = "circulation-policy-v0.1" as const;
export const CIRCULATION_GRID_STEP_MM = 100;
export const CIRCULATION_AGENT_RADIUS_MM = 300;
export const CIRCULATION_SNAP_DISTANCE_MM = CIRCULATION_GRID_STEP_MM * Math.SQRT2;
const ROUTE_DISTANCE_SCALE = 1e6;

/** Frozen neighbor order: N, NE, E, SE, S, SW, W, NW. */
const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
];

export type CirculationViolationCode =
  | "CIRCULATION_SOURCE_SPATIAL_INVALID"
  | "CIRCULATION_PORTAL_BLOCKED"
  | "CIRCULATION_SPACE_NOT_FOUND"
  | "CIRCULATION_ENDPOINT_BLOCKED"
  | "CIRCULATION_ENDPOINT_UNRESOLVABLE"
  | "CIRCULATION_NO_ROUTE";

export interface CirculationViolation {
  code: CirculationViolationCode;
  message: string;
  spaceId?: string;
  openingId?: string;
  portalXY?: Point2;
  endpoint?: "start" | "end";
  pointXY?: Point2;
}

export interface CirculationComponent {
  componentId: string;
  nodeCount: number;
}

export interface CirculationDoorPortal {
  openingId: string;
  spaceId: string;
  portalXY: Point2;
  status: "RESOLVED" | "BLOCKED";
  nodeId: string | null;
  componentId: string | null;
}

export interface CirculationSpaceSummary {
  spaceId: string;
  gridOriginXY: Point2;
  gridSize: readonly [number, number];
  walkableNodeCount: number;
  edgeCount: number;
  componentCount: number;
  components: CirculationComponent[];
  doorPortals: CirculationDoorPortal[];
}

export interface CirculationGraphSpace extends CirculationSpaceSummary {
  /** Walkable node IDs in frozen node order (ix, then iy). */
  nodes: string[];
  /** Undirected edges as [lowerNodeId, higherNodeId] in frozen node order. */
  edges: Array<readonly [string, string]>;
}

/** Complete normalized graph; the worker hashes this as `graphSemanticHash`. */
export interface CirculationGraph {
  policyVersion: typeof CIRCULATION_POLICY_VERSION;
  spatialPolicyVersion: typeof SPATIAL_POLICY_VERSION;
  gridStepMm: number;
  agentRadiusMm: number;
  spaces: CirculationGraphSpace[];
}

export interface CirculationAnalysisResult {
  policyVersion: typeof CIRCULATION_POLICY_VERSION;
  spatialPolicyVersion: typeof SPATIAL_POLICY_VERSION;
  sceneSpecVersion: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  spatialValidationStatus: "PASS" | "FAILED";
  gridStepMm: number;
  agentRadiusMm: number;
  status: "PASS" | "FAILED";
  spaces: CirculationSpaceSummary[];
  violations: CirculationViolation[];
  graph: CirculationGraph;
}

export interface CirculationRouteQuery {
  spaceId: string;
  startXY: Point2;
  endXY: Point2;
}

export interface CirculationRouteResult {
  policyVersion: typeof CIRCULATION_POLICY_VERSION;
  spaceId: string;
  requestedStartXY: Point2;
  requestedEndXY: Point2;
  status: "PASS" | "FAILED";
  reachable: boolean;
  startNodeId: string | null;
  endNodeId: string | null;
  /** Graph distance between the snapped start and end nodes, rounded to 6 decimals. */
  distanceMm: number | null;
  orthogonalStepCount: number | null;
  diagonalStepCount: number | null;
  path: { nodeIds: string[]; pointsXY: Point2[] };
  violations: CirculationViolation[];
}

interface GridNode {
  nodeId: string;
  order: number;
  ix: number;
  iy: number;
  xy: Point2;
}

interface SpaceGraph {
  spaceId: string;
  polygon: Point2[];
  obstacles: ReadonlyArray<readonly Point2[]>;
  gridOriginXY: Point2;
  gridSize: readonly [number, number];
  nodes: GridNode[];
  adjacency: Array<Array<{ to: number; diagonal: boolean }>>;
  edges: Array<readonly [string, string]>;
  componentOf: string[];
  components: CirculationComponent[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function circulationNodeId(spaceId: string, ix: number, iy: number): string {
  return `${spaceId}::${ix}::${iy}`;
}

function isClearAgentCenter(
  point: Point2,
  polygon: readonly Point2[],
  obstacles: ReadonlyArray<readonly Point2[]>,
): boolean {
  const minimum = CIRCULATION_AGENT_RADIUS_MM - SPATIAL_EPSILON_MM;
  if (!pointStrictlyInsidePolygon(point, polygon)) return false;
  if (distancePointToPolygonBoundary(point, polygon) < minimum) return false;
  for (const corners of obstacles) {
    if (distancePointToRectangle(point, corners) < minimum) return false;
  }
  return true;
}

/** Both endpoints must already be clear agent centers; this checks the swept segment between them. */
function isClearMovement(
  from: Point2,
  to: Point2,
  polygon: readonly Point2[],
  obstacles: ReadonlyArray<readonly Point2[]>,
): boolean {
  const minimum = CIRCULATION_AGENT_RADIUS_MM - SPATIAL_EPSILON_MM;
  if (distanceSegmentToPolygonBoundary(from, to, polygon) < minimum) return false;
  for (const corners of obstacles) {
    if (distanceSegmentToRectangle(from, to, corners) < minimum) return false;
  }
  return true;
}

function buildSpaceGraph(
  space: SpaceInput,
  obstacles: ReadonlyArray<readonly Point2[]>,
): SpaceGraph {
  const polygon: Point2[] = space.boundary.map((point) => [point[0], point[1]]);
  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const nx = Math.max(0, Math.ceil((Math.max(...xs) - minX) / CIRCULATION_GRID_STEP_MM));
  const ny = Math.max(0, Math.ceil((Math.max(...ys) - minY) / CIRCULATION_GRID_STEP_MM));

  const nodes: GridNode[] = [];
  const indexAt = new Map<number, number>();
  const key = (ix: number, iy: number) => ix * (ny + 1) + iy;
  for (let ix = 0; ix < nx; ix += 1) {
    for (let iy = 0; iy < ny; iy += 1) {
      const xy: Point2 = [
        minX + (ix + 0.5) * CIRCULATION_GRID_STEP_MM,
        minY + (iy + 0.5) * CIRCULATION_GRID_STEP_MM,
      ];
      if (!isClearAgentCenter(xy, polygon, obstacles)) continue;
      indexAt.set(key(ix, iy), nodes.length);
      nodes.push({ nodeId: circulationNodeId(space.id, ix, iy), order: nodes.length, ix, iy, xy });
    }
  }
  const walkable = (ix: number, iy: number): number | undefined =>
    ix < 0 || iy < 0 || ix >= nx || iy >= ny ? undefined : indexAt.get(key(ix, iy));

  const adjacency: SpaceGraph["adjacency"] = nodes.map(() => []);
  const edgeSet = new Set<number>();
  const edgeKey = (a: number, b: number) => a * nodes.length + b;
  for (const node of nodes) {
    // Only the first four offsets (N, NE, E, SE) point to a later node, so each undirected edge is tested once.
    for (const [dx, dy] of NEIGHBOR_OFFSETS.slice(0, 4) as Array<readonly [number, number]>) {
      const neighbor = walkable(node.ix + dx, node.iy + dy);
      if (neighbor === undefined) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (
        diagonal &&
        (walkable(node.ix + dx, node.iy) === undefined ||
          walkable(node.ix, node.iy + dy) === undefined)
      ) {
        continue;
      }
      if (!isClearMovement(node.xy, (nodes[neighbor] as GridNode).xy, polygon, obstacles)) continue;
      edgeSet.add(edgeKey(node.order, neighbor));
    }
  }
  const edges: Array<readonly [string, string]> = [];
  for (const node of nodes) {
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const neighbor = walkable(node.ix + dx, node.iy + dy);
      if (neighbor === undefined) continue;
      const lower = Math.min(node.order, neighbor);
      const higher = Math.max(node.order, neighbor);
      if (!edgeSet.has(edgeKey(lower, higher))) continue;
      adjacency[node.order]?.push({ to: neighbor, diagonal: dx !== 0 && dy !== 0 });
      if (node.order === lower) {
        edges.push([node.nodeId, (nodes[neighbor] as GridNode).nodeId]);
      }
    }
  }
  const orderOf = new Map(nodes.map((node) => [node.nodeId, node.order]));
  edges.sort(
    (left, right) =>
      (orderOf.get(left[0]) as number) - (orderOf.get(right[0]) as number) ||
      (orderOf.get(left[1]) as number) - (orderOf.get(right[1]) as number),
  );

  // Nodes are visited in frozen node order, so each component's first node is its
  // smallest member; the ID therefore never depends on traversal order.
  const componentOf: string[] = new Array(nodes.length);
  const components: CirculationComponent[] = [];
  for (const start of nodes) {
    if (componentOf[start.order] !== undefined) continue;
    const componentId = start.nodeId;
    const queue = [start.order];
    componentOf[start.order] = componentId;
    let nodeCount = 0;
    for (let head = 0; head < queue.length; head += 1) {
      nodeCount += 1;
      for (const { to } of adjacency[queue[head] as number] ?? []) {
        if (componentOf[to] !== undefined) continue;
        componentOf[to] = componentId;
        queue.push(to);
      }
    }
    components.push({ componentId, nodeCount });
  }

  return {
    spaceId: space.id,
    polygon,
    obstacles,
    gridOriginXY: [minX, minY],
    gridSize: [nx, ny],
    nodes,
    adjacency,
    edges,
    componentOf,
    components,
  };
}

type Anchor = { kind: "resolved"; node: GridNode } | { kind: "blocked" } | { kind: "unresolvable" };

/**
 * Shared portal/endpoint snap: the point itself must be a clear agent
 * center, and it resolves only to a walkable node within
 * CIRCULATION_SNAP_DISTANCE_MM reachable by a clear movement segment. The
 * nearest such node wins; distance ties within SPATIAL_EPSILON_MM go to the
 * lowest node in frozen order.
 */
function resolveAnchor(graph: SpaceGraph, point: Point2): Anchor {
  if (!isClearAgentCenter(point, graph.polygon, graph.obstacles)) return { kind: "blocked" };
  let best: { node: GridNode; distance: number } | null = null;
  for (const node of graph.nodes) {
    const distance = Math.hypot(node.xy[0] - point[0], node.xy[1] - point[1]);
    if (distance > CIRCULATION_SNAP_DISTANCE_MM + SPATIAL_EPSILON_MM) continue;
    if (best && distance >= best.distance - SPATIAL_EPSILON_MM) continue;
    if (!isClearMovement(point, node.xy, graph.polygon, graph.obstacles)) continue;
    best = { node, distance };
  }
  return best ? { kind: "resolved", node: best.node } : { kind: "unresolvable" };
}

/**
 * A space's obstacles are exactly the 9A footprints canonically assigned to
 * that space (`footprint.spaceId`), never inferred from coordinates. Spaces
 * may share XY (stacked floors, overlapping boundaries), so another space's
 * furniture must never obstruct this one.
 */
function sceneObstacles(sceneSpec: Record<string, unknown>) {
  const spatial = validateSpatialScene(sceneSpec);
  const obstaclesBySpace = new Map<string, Array<readonly Point2[]>>();
  for (const footprint of spatial.assetFootprints) {
    const list = obstaclesBySpace.get(footprint.spaceId) ?? [];
    list.push(footprint.cornersXY);
    obstaclesBySpace.set(footprint.spaceId, list);
  }
  return {
    spatial,
    obstaclesFor: (spaceId: string): ReadonlyArray<readonly Point2[]> =>
      obstaclesBySpace.get(spaceId) ?? [],
  };
}

function sortedSpaces(scene: SpatialSceneInput): SpaceInput[] {
  return [...scene.spaces].sort((left, right) => compareText(left.id, right.id));
}

function portalFor(clearance: DoorwayClearance, graph: SpaceGraph | undefined) {
  const [, , intoRoomEnd, intoRoomStart] = clearance.cornersXY;
  const portalXY: Point2 = [
    (intoRoomEnd[0] + intoRoomStart[0]) / 2,
    (intoRoomEnd[1] + intoRoomStart[1]) / 2,
  ];
  const anchor = graph ? resolveAnchor(graph, portalXY) : ({ kind: "unresolvable" } as const);
  const portal: CirculationDoorPortal = {
    openingId: clearance.openingId,
    spaceId: clearance.spaceId,
    portalXY,
    status: anchor.kind === "resolved" ? "RESOLVED" : "BLOCKED",
    nodeId: anchor.kind === "resolved" ? anchor.node.nodeId : null,
    componentId:
      anchor.kind === "resolved" && graph ? (graph.componentOf[anchor.node.order] as string) : null,
  };
  let violation: CirculationViolation | null = null;
  if (portal.status === "BLOCKED") {
    violation = {
      code: "CIRCULATION_PORTAL_BLOCKED",
      message:
        anchor.kind === "blocked"
          ? `Door ${clearance.openingId} interior portal is not a clear ${CIRCULATION_AGENT_RADIUS_MM}mm-radius circulation-probe position under ${CIRCULATION_POLICY_VERSION}`
          : `Door ${clearance.openingId} interior portal resolves to no walkable node within ${CIRCULATION_GRID_STEP_MM}mm*sqrt(2) under ${CIRCULATION_POLICY_VERSION}`,
      openingId: clearance.openingId,
      portalXY,
      ...(clearance.spaceId ? { spaceId: clearance.spaceId } : {}),
    };
  }
  return { portal, violation };
}

/**
 * Pure full-scene circulation analysis (circulation-policy-v0.1): requires
 * spatial-policy-v0.1 PASS, then builds a deterministic 8-neighbor walkable
 * grid per canonical space, stable connected components, and interior door
 * portals. Never mutates the input and never launches a DCC.
 */
export function analyzeCirculation(sceneSpec: Record<string, unknown>): CirculationAnalysisResult {
  const scene = sceneSpec as unknown as SpatialSceneInput;
  const { spatial, obstaclesFor } = sceneObstacles(sceneSpec);
  const base = {
    policyVersion: CIRCULATION_POLICY_VERSION,
    spatialPolicyVersion: SPATIAL_POLICY_VERSION,
    sceneSpecVersion: scene.sceneSpecVersion,
    projectId: scene.project.id,
    sceneId: scene.scene.id,
    revisionId: scene.scene.revisionId,
    spatialValidationStatus: spatial.status,
    gridStepMm: CIRCULATION_GRID_STEP_MM,
    agentRadiusMm: CIRCULATION_AGENT_RADIUS_MM,
  };
  const emptyGraph = (spaces: CirculationGraphSpace[]): CirculationGraph => ({
    policyVersion: CIRCULATION_POLICY_VERSION,
    spatialPolicyVersion: SPATIAL_POLICY_VERSION,
    gridStepMm: CIRCULATION_GRID_STEP_MM,
    agentRadiusMm: CIRCULATION_AGENT_RADIUS_MM,
    spaces,
  });
  if (spatial.status !== "PASS") {
    return {
      ...base,
      status: "FAILED",
      spaces: [],
      violations: [
        {
          code: "CIRCULATION_SOURCE_SPATIAL_INVALID",
          message: `Source scene fails ${SPATIAL_POLICY_VERSION}; no circulation graph was built`,
        },
      ],
      graph: emptyGraph([]),
    };
  }

  const graphs = new Map(
    sortedSpaces(scene).map((space) => [space.id, buildSpaceGraph(space, obstaclesFor(space.id))]),
  );
  const violations: CirculationViolation[] = [];
  const portalsBySpace = new Map<string, CirculationDoorPortal[]>();
  for (const clearance of spatial.doorwayClearances) {
    const { portal, violation } = portalFor(clearance, graphs.get(clearance.spaceId));
    const list = portalsBySpace.get(clearance.spaceId) ?? [];
    list.push(portal);
    portalsBySpace.set(clearance.spaceId, list);
    if (violation) violations.push(violation);
  }
  violations.sort((left, right) => compareText(left.openingId ?? "", right.openingId ?? ""));

  const graphSpaces: CirculationGraphSpace[] = [...graphs.values()].map((graph) => ({
    spaceId: graph.spaceId,
    gridOriginXY: graph.gridOriginXY,
    gridSize: graph.gridSize,
    walkableNodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    componentCount: graph.components.length,
    components: graph.components,
    doorPortals: (portalsBySpace.get(graph.spaceId) ?? []).sort((left, right) =>
      compareText(left.openingId, right.openingId),
    ),
    nodes: graph.nodes.map((node) => node.nodeId),
    edges: graph.edges,
  }));
  return {
    ...base,
    status: violations.length === 0 ? "PASS" : "FAILED",
    spaces: graphSpaces.map(({ nodes: _nodes, edges: _edges, ...summary }) => summary),
    violations,
    graph: emptyGraph(graphSpaces),
  };
}

interface StepCost {
  orthogonal: number;
  diagonal: number;
}

/** Exact comparison of (o1 + d1*sqrt2) vs (o2 + d2*sqrt2) using integer arithmetic only. */
function compareStepCost(left: StepCost, right: StepCost): number {
  const da = left.orthogonal - right.orthogonal;
  const db = left.diagonal - right.diagonal;
  if (da === 0 && db === 0) return 0;
  if (da >= 0 && db >= 0) return 1;
  if (da <= 0 && db <= 0) return -1;
  const orthogonalSquared = da * da;
  const diagonalSquared = 2 * db * db;
  return da > 0
    ? orthogonalSquared > diagonalSquared
      ? 1
      : -1
    : diagonalSquared > orthogonalSquared
      ? 1
      : -1;
}

class MinHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly compare: (left: T, right: T) => number) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let index = items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(items[index] as T, items[parent] as T) >= 0) break;
      [items[index], items[parent]] = [items[parent] as T, items[index] as T];
      index = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < items.length && this.compare(items[left] as T, items[smallest] as T) < 0) {
          smallest = left;
        }
        if (right < items.length && this.compare(items[right] as T, items[smallest] as T) < 0) {
          smallest = right;
        }
        if (smallest === index) break;
        [items[index], items[smallest]] = [items[smallest] as T, items[index] as T];
        index = smallest;
      }
    }
    return top;
  }
}

/**
 * Deterministic Dijkstra: the frontier is ordered by exact cost, then frozen
 * node order; an equal-cost alternative predecessor is adopted only if it is
 * lower in frozen node order. Equal-cost routes therefore always resolve to
 * the same path regardless of source array order.
 */
function shortestPath(
  graph: SpaceGraph,
  start: number,
  end: number,
): { path: number[]; cost: StepCost } | null {
  const cost: Array<StepCost | undefined> = new Array(graph.nodes.length);
  const predecessor: Array<number | undefined> = new Array(graph.nodes.length);
  const settled = new Uint8Array(graph.nodes.length);
  const frontier = new MinHeap<{ node: number; cost: StepCost }>(
    (left, right) => compareStepCost(left.cost, right.cost) || left.node - right.node,
  );
  cost[start] = { orthogonal: 0, diagonal: 0 };
  frontier.push({ node: start, cost: cost[start] as StepCost });
  while (frontier.size > 0) {
    const current = frontier.pop() as { node: number; cost: StepCost };
    if (settled[current.node]) continue;
    settled[current.node] = 1;
    if (current.node === end) break;
    for (const { to, diagonal } of graph.adjacency[current.node] ?? []) {
      if (settled[to]) continue;
      const candidate: StepCost = {
        orthogonal: current.cost.orthogonal + (diagonal ? 0 : 1),
        diagonal: current.cost.diagonal + (diagonal ? 1 : 0),
      };
      const existing = cost[to];
      const comparison = existing ? compareStepCost(candidate, existing) : -1;
      if (comparison < 0) {
        cost[to] = candidate;
        predecessor[to] = current.node;
        frontier.push({ node: to, cost: candidate });
      } else if (comparison === 0 && current.node < (predecessor[to] as number)) {
        predecessor[to] = current.node;
      }
    }
  }
  if (!settled[end]) return null;
  const path = [end];
  while ((path[path.length - 1] as number) !== start) {
    path.push(predecessor[path[path.length - 1] as number] as number);
  }
  return { path: path.reverse(), cost: cost[end] as StepCost };
}

function roundDistance(value: number): number {
  const rounded = Math.round(value * ROUTE_DISTANCE_SCALE) / ROUTE_DISTANCE_SCALE;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Pure same-space route query under circulation-policy-v0.1. Routes only
 * within one canonical space: SceneSpec v0.3 defines no cross-space door
 * adjacency, so no building topology is guessed.
 */
export function findCirculationRoute(
  sceneSpec: Record<string, unknown>,
  query: CirculationRouteQuery,
): CirculationRouteResult {
  const requestedStartXY: Point2 = [query.startXY[0], query.startXY[1]];
  const requestedEndXY: Point2 = [query.endXY[0], query.endXY[1]];
  const failed = (
    violations: CirculationViolation[],
    startNodeId: string | null = null,
    endNodeId: string | null = null,
  ): CirculationRouteResult => ({
    policyVersion: CIRCULATION_POLICY_VERSION,
    spaceId: query.spaceId,
    requestedStartXY,
    requestedEndXY,
    status: "FAILED",
    reachable: false,
    startNodeId,
    endNodeId,
    distanceMm: null,
    orthogonalStepCount: null,
    diagonalStepCount: null,
    path: { nodeIds: [], pointsXY: [] },
    violations,
  });

  const scene = sceneSpec as unknown as SpatialSceneInput;
  const { spatial, obstaclesFor } = sceneObstacles(sceneSpec);
  if (spatial.status !== "PASS") {
    return failed([
      {
        code: "CIRCULATION_SOURCE_SPATIAL_INVALID",
        message: `Source scene fails ${SPATIAL_POLICY_VERSION}; no circulation graph was built`,
      },
    ]);
  }
  const space = scene.spaces.find((entry) => entry.id === query.spaceId);
  if (!space) {
    return failed([
      {
        code: "CIRCULATION_SPACE_NOT_FOUND",
        message: `Space ${query.spaceId} does not exist in the scene`,
        spaceId: query.spaceId,
      },
    ]);
  }
  const graph = buildSpaceGraph(space, obstaclesFor(space.id));
  const anchors = (
    [
      ["start", requestedStartXY],
      ["end", requestedEndXY],
    ] as const
  ).map(([endpoint, pointXY]) => ({ endpoint, pointXY, anchor: resolveAnchor(graph, pointXY) }));
  const endpointViolations: CirculationViolation[] = [];
  for (const { endpoint, pointXY, anchor } of anchors) {
    if (anchor.kind === "resolved") continue;
    endpointViolations.push({
      code:
        anchor.kind === "blocked"
          ? "CIRCULATION_ENDPOINT_BLOCKED"
          : "CIRCULATION_ENDPOINT_UNRESOLVABLE",
      message:
        anchor.kind === "blocked"
          ? `Route ${endpoint} point is not a clear ${CIRCULATION_AGENT_RADIUS_MM}mm-radius circulation-probe position`
          : `Route ${endpoint} point resolves to no walkable node within ${CIRCULATION_GRID_STEP_MM}mm*sqrt(2)`,
      spaceId: query.spaceId,
      endpoint,
      pointXY,
    });
  }
  const [startAnchor, endAnchor] = anchors.map(({ anchor }) =>
    anchor.kind === "resolved" ? anchor.node : null,
  );
  if (endpointViolations.length > 0 || !startAnchor || !endAnchor) {
    return failed(endpointViolations, startAnchor?.nodeId ?? null, endAnchor?.nodeId ?? null);
  }

  const route = shortestPath(graph, startAnchor.order, endAnchor.order);
  if (!route) {
    return failed(
      [
        {
          code: "CIRCULATION_NO_ROUTE",
          message: `No ${CIRCULATION_POLICY_VERSION} route connects ${startAnchor.nodeId} to ${endAnchor.nodeId}`,
          spaceId: query.spaceId,
        },
      ],
      startAnchor.nodeId,
      endAnchor.nodeId,
    );
  }
  const pathNodes = route.path.map((index) => graph.nodes[index] as GridNode);
  return {
    policyVersion: CIRCULATION_POLICY_VERSION,
    spaceId: query.spaceId,
    requestedStartXY,
    requestedEndXY,
    status: "PASS",
    reachable: true,
    startNodeId: startAnchor.nodeId,
    endNodeId: endAnchor.nodeId,
    distanceMm: roundDistance(
      CIRCULATION_GRID_STEP_MM * (route.cost.orthogonal + route.cost.diagonal * Math.SQRT2),
    ),
    orthogonalStepCount: route.cost.orthogonal,
    diagonalStepCount: route.cost.diagonal,
    path: {
      nodeIds: pathNodes.map((node) => node.nodeId),
      pointsXY: pathNodes.map((node) => node.xy),
    },
    violations: [],
  };
}
