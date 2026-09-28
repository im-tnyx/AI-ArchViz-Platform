import { polygonDefect, signedArea } from "@ai-archviz/cad-interpreter";

/*
 * Deterministic polygon-surface realization (post-10C closure, build plan
 * v0.2). The canonical SceneSpec surface `boundary` is the ONLY shape
 * authority; `elevation` is the ONLY Z authority. Bounding boxes are never
 * used for physical geometry.
 *
 * Vertex convention (frozen): vertices are emitted in exact canonical
 * boundary order, in node-local coordinates relative to the surface's
 * canonical `transform.position` P:
 *   local = [x - P.x, y - P.y, elevation - P.z]
 * so the realized world-space vertices equal [x, y, elevation]. The boundary
 * is world-space; the transform is the node pivot and is applied exactly
 * once. Only rotation [0,0,0] and scale [1,1,1] are supported.
 *
 * Triangulation (frozen): ear clipping over the remaining vertex list in
 * canonical boundary order; each pass selects the FIRST vertex (lowest
 * position in the remaining list) whose ear is strictly convex (in the
 * polygon's own winding) and contains no other remaining vertex inside or on
 * it. Every emitted triangle is counter-clockwise in XY (+Z normal). No
 * vertex is removed or added, so a simple polygon with N vertices yields
 * exactly N - 2 triangles; if no valid ear exists (e.g. only collinear
 * remainders), the surface is rejected rather than degenerately triangulated.
 */

export const SURFACE_MESH_EPSILON_MM = 0.001;

export type SurfaceMeshErrorCode =
  | "SURFACE_BOUNDARY_INVALID"
  | "SURFACE_TRANSFORM_UNSUPPORTED"
  | "SURFACE_TRIANGULATION_FAILED";

export class SurfaceMeshError extends Error {
  readonly code: SurfaceMeshErrorCode;

  constructor(code: SurfaceMeshErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SurfaceMeshError";
    this.code = code;
  }
}

export type Vector2 = [number, number];
export type Vector3 = [number, number, number];
export type Triangle = [number, number, number];

export interface SurfaceMesh {
  logicalId: string;
  type: "floor" | "ceiling";
  /** Node-local vertices, one per canonical boundary point, in boundary order. */
  vertices: Vector3[];
  /** Zero-based indices into `vertices`; every triangle CCW in XY. */
  triangles: Triangle[];
  elevationMm: number;
  areaMm2: number;
}

function cross(origin: Vector2, a: Vector2, b: Vector2): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

function triangleArea(a: Vector2, b: Vector2, c: Vector2): number {
  return cross(a, b, c) / 2;
}

/** Inside or on the triangle (within epsilon), for a CCW-normalized triangle. */
function coversPoint(a: Vector2, b: Vector2, c: Vector2, point: Vector2): boolean {
  const tolerance = SURFACE_MESH_EPSILON_MM * SURFACE_MESH_EPSILON_MM;
  return (
    cross(a, b, point) >= -tolerance &&
    cross(b, c, point) >= -tolerance &&
    cross(c, a, point) >= -tolerance
  );
}

/**
 * Deterministic ear clipping of a validated simple polygon. Returns
 * zero-based index triangles, each counter-clockwise in XY.
 */
export function triangulateSimplePolygon(points: readonly Vector2[]): Triangle[] {
  const orientation = Math.sign(signedArea(points as Vector2[]));
  if (orientation === 0) {
    throw new SurfaceMeshError("SURFACE_BOUNDARY_INVALID", "polygon has zero area");
  }
  const remaining = points.map((_, index) => index);
  const triangles: Triangle[] = [];
  const convexity = SURFACE_MESH_EPSILON_MM * SURFACE_MESH_EPSILON_MM;
  while (remaining.length > 3) {
    let clipped = false;
    for (let position = 0; position < remaining.length; position += 1) {
      const previous = remaining[(position - 1 + remaining.length) % remaining.length] as number;
      const current = remaining[position] as number;
      const next = remaining[(position + 1) % remaining.length] as number;
      const a = points[previous] as Vector2;
      const b = points[current] as Vector2;
      const c = points[next] as Vector2;
      // Strictly convex in the polygon's own winding.
      if (orientation * cross(a, b, c) <= convexity) continue;
      const [p, q, r] = orientation > 0 ? [a, b, c] : [a, c, b];
      const blocked = remaining.some(
        (index) =>
          index !== previous &&
          index !== current &&
          index !== next &&
          coversPoint(p, q, r, points[index] as Vector2),
      );
      if (blocked) continue;
      triangles.push(orientation > 0 ? [previous, current, next] : [previous, next, current]);
      remaining.splice(position, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      throw new SurfaceMeshError(
        "SURFACE_TRIANGULATION_FAILED",
        "no valid ear remains (degenerate or collinear remainder)",
      );
    }
  }
  const [x, y, z] = remaining as [number, number, number];
  if (
    orientation * cross(points[x] as Vector2, points[y] as Vector2, points[z] as Vector2) <=
    convexity
  ) {
    throw new SurfaceMeshError(
      "SURFACE_TRIANGULATION_FAILED",
      "final triangle is degenerate (collinear remainder)",
    );
  }
  triangles.push(orientation > 0 ? [x, y, z] : [x, z, y]);
  return triangles;
}

function isFiniteVector(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((component) => typeof component === "number" && Number.isFinite(component))
  );
}

/**
 * Compiles one canonical SceneSpec floor/ceiling into its exact physical
 * mesh payload, failing closed (before any DCC) on anything v0.2 cannot
 * realize exactly.
 */
export function compileSurfaceMesh(surface: Record<string, unknown>): SurfaceMesh {
  const logicalId = String(surface.id);
  const type = surface.type;
  if (type !== "floor" && type !== "ceiling") {
    throw new SurfaceMeshError("SURFACE_BOUNDARY_INVALID", `${logicalId} is not a floor/ceiling`);
  }
  const transform = surface.transform as Record<string, unknown> | undefined;
  const position = transform?.position;
  if (!isFiniteVector(position, 3)) {
    throw new SurfaceMeshError(
      "SURFACE_TRANSFORM_UNSUPPORTED",
      `${logicalId} has no finite position`,
    );
  }
  const rotation = transform?.rotationEuler;
  const scale = transform?.scale;
  if (
    !isFiniteVector(rotation, 3) ||
    !isFiniteVector(scale, 3) ||
    rotation.some((component) => component !== 0) ||
    scale.some((component) => component !== 1)
  ) {
    // No proven semantic exists for rotating/scaling a world-space boundary.
    throw new SurfaceMeshError(
      "SURFACE_TRANSFORM_UNSUPPORTED",
      `${logicalId} surface transform must have rotation [0,0,0] and scale [1,1,1]`,
    );
  }
  const elevation = surface.elevation;
  if (typeof elevation !== "number" || !Number.isFinite(elevation)) {
    throw new SurfaceMeshError("SURFACE_BOUNDARY_INVALID", `${logicalId} has no finite elevation`);
  }
  const boundary = surface.boundary;
  if (!Array.isArray(boundary) || !boundary.every((point) => isFiniteVector(point, 3))) {
    throw new SurfaceMeshError(
      "SURFACE_BOUNDARY_INVALID",
      `${logicalId} boundary must be finite [x, y, z] points`,
    );
  }
  const points3 = boundary as Vector3[];
  // One horizontal plane: every boundary point shares one Z.
  const planeZ = points3[0]?.[2];
  if (points3.some((point) => Math.abs(point[2] - (planeZ as number)) > SURFACE_MESH_EPSILON_MM)) {
    throw new SurfaceMeshError(
      "SURFACE_BOUNDARY_INVALID",
      `${logicalId} boundary is not coplanar in a horizontal plane`,
    );
  }
  const points = points3.map((point): Vector2 => [point[0], point[1]]);
  // The same simple-polygon convention as 10B (cad-interpreter).
  const defect = polygonDefect(points);
  if (defect) {
    throw new SurfaceMeshError("SURFACE_BOUNDARY_INVALID", `${logicalId} boundary: ${defect}`);
  }
  const triangles = triangulateSimplePolygon(points);
  const areaMm2 = Math.abs(signedArea(points));
  const covered = triangles.reduce(
    (sum, [a, b, c]) =>
      sum + triangleArea(points[a] as Vector2, points[b] as Vector2, points[c] as Vector2),
    0,
  );
  if (
    triangles.length !== points.length - 2 ||
    triangles.some(
      ([a, b, c]) =>
        triangleArea(points[a] as Vector2, points[b] as Vector2, points[c] as Vector2) <= 0,
    ) ||
    Math.abs(covered - areaMm2) > 1e-9 * Math.max(1, areaMm2)
  ) {
    throw new SurfaceMeshError(
      "SURFACE_TRIANGULATION_FAILED",
      `${logicalId} triangulation does not exactly cover the polygon`,
    );
  }
  const [px, py, pz] = position as Vector3;
  const local = (value: number, origin: number) => {
    const offset = value - origin;
    return offset === 0 ? 0 : offset;
  };
  return {
    logicalId,
    type,
    vertices: points.map(([x, y]): Vector3 => [local(x, px), local(y, py), local(elevation, pz)]),
    triangles,
    elevationMm: elevation,
    areaMm2,
  };
}
