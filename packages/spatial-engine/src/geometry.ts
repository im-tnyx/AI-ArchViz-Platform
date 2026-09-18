import type { Point2, Vector3 } from "./types.js";

/**
 * Single explicit spatial epsilon (mm for linear checks; the same numeric
 * value doubles as a degrees tolerance for the roll/pitch "upright" support
 * check in footprint.ts). Used consistently for point-on-boundary, segment
 * intersection, SAT overlap, zero-area overlap, and orientation-support
 * checks. Do not scatter independent epsilons across this package.
 */
export const SPATIAL_EPSILON_MM = 0.001;

export const SPATIAL_POLICY_VERSION = "spatial-policy-v0.1" as const;

function canonicalZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * The single canonical wall reference frame, mirrored from
 * `apps/worker/src/build-plan.ts`'s own `wallFrame` (that module now imports
 * this implementation rather than defining a second copy). `u` is the unit
 * tangent from `start` to `end`; `exteriorNormal` is `u` rotated -90°
 * (clockwise), matching the SceneSpec `thicknessDirection: exterior_right_of_u`
 * contract. The interior side of a wall is therefore the LEFT normal of `u`
 * (the negation of `exteriorNormal`).
 */
export function wallFrame(wall: { start: Vector3; end: Vector3 }): {
  length: number;
  u: Vector3;
  exteriorNormal: Vector3;
} {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const dz = wall.end[2] - wall.start[2];
  const length = Math.hypot(dx, dy, dz);
  if (length <= 0) throw new Error("Wall baseline must have positive length");
  const u: Vector3 = [
    canonicalZero(dx / length),
    canonicalZero(dy / length),
    canonicalZero(dz / length),
  ];
  return {
    length,
    u,
    exteriorNormal: [canonicalZero(u[1]), canonicalZero(-u[0]), 0],
  };
}

/** Rotates a local (x,y) offset by `degrees` (standard CCW math convention) and translates by `center`. */
export function rotatedCorner(center: Point2, offset: Point2, degrees: number): Point2 {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    center[0] + offset[0] * cos - offset[1] * sin,
    center[1] + offset[0] * sin + offset[1] * cos,
  ];
}

/** Canonical corner order: local (-x,-y), (+x,-y), (+x,+y), (-x,+y), then rotated/translated to world XY. */
export function orientedRectangleCorners(
  center: Point2,
  halfWidth: number,
  halfLength: number,
  rotationZDegrees: number,
): readonly [Point2, Point2, Point2, Point2] {
  const localOffsets: readonly Point2[] = [
    [-halfWidth, -halfLength],
    [halfWidth, -halfLength],
    [halfWidth, halfLength],
    [-halfWidth, halfLength],
  ];
  return localOffsets.map((offset) => rotatedCorner(center, offset, rotationZDegrees)) as [
    Point2,
    Point2,
    Point2,
    Point2,
  ];
}

function distancePointToSegment(point: Point2, a: Point2, b: Point2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lengthSquared = abx * abx + aby * aby;
  if (lengthSquared === 0) return Math.hypot(point[0] - a[0], point[1] - a[1]);
  const t = Math.max(
    0,
    Math.min(1, ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby) / lengthSquared),
  );
  const projectedX = a[0] + t * abx;
  const projectedY = a[1] + t * aby;
  return Math.hypot(point[0] - projectedX, point[1] - projectedY);
}

/** True if `point` lies within `epsilon` of any edge of `polygon` (closed ring). */
export function pointOnPolygonBoundary(
  point: Point2,
  polygon: readonly Point2[],
  epsilon: number,
): boolean {
  const n = polygon.length;
  for (let index = 0; index < n; index += 1) {
    const a = polygon[index] as Point2;
    const b = polygon[(index + 1) % n] as Point2;
    if (distancePointToSegment(point, a, b) <= epsilon) return true;
  }
  return false;
}

/** Standard even-odd ray-casting interior test; works for any simple polygon, including concave. */
export function pointStrictlyInsidePolygon(point: Point2, polygon: readonly Point2[]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let index = 0, previous = n - 1; index < n; previous = index++) {
    const [xi, yi] = polygon[index] as Point2;
    const [xj, yj] = polygon[previous] as Point2;
    const intersects =
      yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Boundary contact counts as contained (allowed); strict interior also counts as contained. */
export function pointContainedInPolygon(
  point: Point2,
  polygon: readonly Point2[],
  epsilon: number,
): boolean {
  return (
    pointOnPolygonBoundary(point, polygon, epsilon) || pointStrictlyInsidePolygon(point, polygon)
  );
}

/** Signed perpendicular distance (mm) from `point` to the infinite line through `a`-`b`. */
function signedDistanceToLine(point: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  return ((point[0] - a[0]) * dy - (point[1] - a[1]) * dx) / length;
}

/**
 * True only when segment `a1`-`a2` genuinely crosses segment `b1`-`b2` (both
 * segments straddle each other's line by more than `epsilon`). Touching,
 * collinear overlap, and near-parallel near-misses within `epsilon` are
 * deliberately NOT reported as a proper crossing — boundary contact is
 * allowed.
 */
export function segmentsProperlyCross(
  a1: Point2,
  a2: Point2,
  b1: Point2,
  b2: Point2,
  epsilon: number,
): boolean {
  const d1 = signedDistanceToLine(a1, b1, b2);
  const d2 = signedDistanceToLine(a2, b1, b2);
  const d3 = signedDistanceToLine(b1, a1, a2);
  const d4 = signedDistanceToLine(b2, a1, a2);
  const straddlesB = (d1 > epsilon && d2 < -epsilon) || (d1 < -epsilon && d2 > epsilon);
  const straddlesA = (d3 > epsilon && d4 < -epsilon) || (d3 < -epsilon && d4 > epsilon);
  return straddlesB && straddlesA;
}

/**
 * Robust concave-safe containment: every corner of `rectangleCorners` must
 * be inside or on `polygon`, AND no rectangle edge may properly cross a
 * polygon edge. Corner-only containment is insufficient for a concave
 * polygon whose boundary dips between two contained corners.
 */
export function isRectangleWithinPolygon(
  rectangleCorners: readonly Point2[],
  polygon: readonly Point2[],
  epsilon: number,
): boolean {
  for (const corner of rectangleCorners) {
    if (!pointContainedInPolygon(corner, polygon, epsilon)) return false;
  }
  const rn = rectangleCorners.length;
  const pn = polygon.length;
  for (let ri = 0; ri < rn; ri += 1) {
    const a1 = rectangleCorners[ri] as Point2;
    const a2 = rectangleCorners[(ri + 1) % rn] as Point2;
    for (let pi = 0; pi < pn; pi += 1) {
      const b1 = polygon[pi] as Point2;
      const b2 = polygon[(pi + 1) % pn] as Point2;
      if (segmentsProperlyCross(a1, a2, b1, b2, epsilon)) return false;
    }
  }
  return true;
}

function edgeAxes(corners: readonly Point2[]): Point2[] {
  const axes: Point2[] = [];
  for (let index = 0; index < 2; index += 1) {
    const p1 = corners[index] as Point2;
    const p2 = corners[index + 1] as Point2;
    const edgeX = p2[0] - p1[0];
    const edgeY = p2[1] - p1[1];
    const length = Math.hypot(edgeX, edgeY);
    if (length === 0) continue;
    axes.push([-edgeY / length, edgeX / length]);
  }
  return axes;
}

function project(corners: readonly Point2[], axis: Point2): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const corner of corners) {
    const d = corner[0] * axis[0] + corner[1] * axis[1];
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/**
 * Exact convex-polygon SAT overlap test for two oriented rectangles.
 * Interiors must overlap by more than `epsilon` on EVERY candidate
 * separating axis for a collision to be reported; boundary touching alone
 * (overlap <= epsilon on any axis) is allowed. World-axis AABB is never
 * used as the authoritative test — only as a possible future broad phase.
 */
export function rectanglesOverlap(
  cornersA: readonly Point2[],
  cornersB: readonly Point2[],
  epsilon: number,
): boolean {
  const axes = [...edgeAxes(cornersA), ...edgeAxes(cornersB)];
  for (const axis of axes) {
    const [minA, maxA] = project(cornersA, axis);
    const [minB, maxB] = project(cornersB, axis);
    const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
    if (overlap <= epsilon) return false;
  }
  return true;
}
