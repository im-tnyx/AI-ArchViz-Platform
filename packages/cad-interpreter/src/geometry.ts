import { CAD_INTERPRET_EPSILON_MM as EPSILON, type Point2 } from "./types.js";

/** Pure 2D plan geometry used by cad-interpretation-policy-v0.1. */

export function subtract(a: Point2, b: Point2): Point2 {
  return [a[0] - b[0], a[1] - b[1]];
}

export function cross(a: Point2, b: Point2): number {
  return a[0] * b[1] - a[1] * b[0];
}

export function dot(a: Point2, b: Point2): number {
  return a[0] * b[0] + a[1] * b[1];
}

export function distance(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Shoelace signed area: positive for counter-clockwise (Y north, X east). */
export function signedArea(polygon: readonly Point2[]): number {
  let twice = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index] as Point2;
    const b = polygon[(index + 1) % polygon.length] as Point2;
    twice += cross(a, b);
  }
  return twice / 2;
}

export function pointSegmentDistance(point: Point2, start: Point2, end: Point2): number {
  const direction = subtract(end, start);
  const lengthSquared = dot(direction, direction);
  if (lengthSquared === 0) return distance(point, start);
  const t = Math.max(0, Math.min(1, dot(subtract(point, start), direction) / lengthSquared));
  return distance(point, [start[0] + t * direction[0], start[1] + t * direction[1]]);
}

function orientation(a: Point2, b: Point2, c: Point2): number {
  const value = cross(subtract(b, a), subtract(c, a));
  return Math.abs(value) <= EPSILON * EPSILON ? 0 : Math.sign(value);
}

/** True when the segments cross or touch (within EPSILON). */
export function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4) return true;
  return (
    Math.min(
      pointSegmentDistance(a, c, d),
      pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b),
      pointSegmentDistance(d, a, b),
    ) <= EPSILON
  );
}

function edges(polygon: readonly Point2[]): [Point2, Point2][] {
  return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length] as Point2]);
}

export function isOnBoundary(polygon: readonly Point2[], point: Point2): boolean {
  return edges(polygon).some(([start, end]) => pointSegmentDistance(point, start, end) <= EPSILON);
}

/** Even-odd containment; callers exclude boundary points first. */
function isInsideEvenOdd(polygon: readonly Point2[], point: Point2): boolean {
  let inside = false;
  for (const [a, b] of edges(polygon)) {
    if (a[1] > point[1] !== b[1] > point[1]) {
      const x = a[0] + ((point[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** Strictly inside: inside and farther than EPSILON from every edge. */
export function isStrictlyInside(polygon: readonly Point2[], point: Point2): boolean {
  return !isOnBoundary(polygon, point) && isInsideEvenOdd(polygon, point);
}

export type PolygonDefect =
  | "TOO_FEW_VERTICES"
  | "ZERO_LENGTH_EDGE"
  | "TOO_FEW_DISTINCT_POINTS"
  | "SELF_INTERSECTION"
  | "ZERO_AREA";

/** Simple-polygon validation for a straight-edged closed boundary. */
export function polygonDefect(polygon: readonly Point2[]): PolygonDefect | null {
  if (polygon.length < 3) return "TOO_FEW_VERTICES";
  const sides = edges(polygon);
  if (sides.some(([start, end]) => distance(start, end) <= EPSILON)) return "ZERO_LENGTH_EDGE";
  const distinct = new Set(polygon.map((point) => `${point[0]},${point[1]}`));
  if (distinct.size < 3) return "TOO_FEW_DISTINCT_POINTS";
  const count = sides.length;
  for (let i = 0; i < count; i += 1) {
    const [a, b] = sides[i] as [Point2, Point2];
    for (let j = i + 1; j < count; j += 1) {
      const [c, d] = sides[j] as [Point2, Point2];
      const adjacent = j === i + 1 || (i === 0 && j === count - 1);
      if (adjacent) {
        // Adjacent edges share one vertex; they may not fold back onto each other.
        const [shared, first, second] = j === i + 1 ? [b, a, d] : [a, b, c];
        const u = subtract(first, shared);
        const v = subtract(second, shared);
        if (orientation(shared, first, second) === 0 && dot(u, v) > 0) return "SELF_INTERSECTION";
        continue;
      }
      if (segmentsIntersect(a, b, c, d)) return "SELF_INTERSECTION";
    }
  }
  if (Math.abs(signedArea(polygon)) <= EPSILON) return "ZERO_AREA";
  return null;
}

function lineIntersectionX(a: Point2, b: Point2, c: Point2, d: Point2): number | null {
  const r = subtract(b, a);
  const s = subtract(d, c);
  const denominator = cross(r, s);
  if (denominator === 0) return null;
  const t = cross(subtract(c, a), s) / denominator;
  const u = cross(subtract(c, a), r) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return a[0] + t * r[0];
}

/**
 * Exact positive-area overlap test for two simple polygons (convex or
 * concave) by vertical slab decomposition: every face of the combined edge
 * arrangement meets some slab midline, and a sample point between two
 * consecutive edge crossings lies on no edge. Touching boundaries (shared
 * edges, shared vertices) is not overlap.
 */
export function polygonsOverlap(first: readonly Point2[], second: readonly Point2[]): boolean {
  const allEdges = [...edges(first), ...edges(second)];
  const xs = new Set<number>([...first, ...second].map((point) => point[0]));
  for (const [a, b] of edges(first)) {
    for (const [c, d] of edges(second)) {
      const x = lineIntersectionX(a, b, c, d);
      if (x !== null) xs.add(x);
    }
  }
  const sortedXs = [...xs].sort((left, right) => left - right);
  for (let index = 0; index + 1 < sortedXs.length; index += 1) {
    const left = sortedXs[index] as number;
    const right = sortedXs[index + 1] as number;
    if (right - left <= EPSILON) continue;
    const x = (left + right) / 2;
    const ys = allEdges
      .filter(([a, b]) => Math.min(a[0], b[0]) < x && x < Math.max(a[0], b[0]))
      .map(([a, b]) => a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]))
      .sort((low, high) => low - high);
    for (let slab = 0; slab + 1 < ys.length; slab += 1) {
      const low = ys[slab] as number;
      const high = ys[slab + 1] as number;
      if (high - low <= EPSILON) continue;
      const sample: Point2 = [x, (low + high) / 2];
      if (isStrictlyInside(first, sample) && isStrictlyInside(second, sample)) return true;
    }
  }
  return false;
}

export interface SegmentProjection {
  /** Distance along the segment from its start to the projected point. */
  alongMm: number;
  /** Perpendicular distance from the point to the segment's line. */
  perpendicularMm: number;
  lengthMm: number;
}

export function projectOntoSegment(point: Point2, start: Point2, end: Point2): SegmentProjection {
  const direction = subtract(end, start);
  const lengthMm = Math.hypot(direction[0], direction[1]);
  const relative = subtract(point, start);
  return {
    alongMm: dot(relative, direction) / lengthMm,
    perpendicularMm: Math.abs(cross(direction, relative)) / lengthMm,
    lengthMm,
  };
}
