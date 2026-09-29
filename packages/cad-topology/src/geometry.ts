import { CAD_TOPOLOGY_EPSILON_MM as EPSILON, type Point2 } from "./types.js";

/** Pure 2D plan geometry used by cad-topology-policy-v0.1. */

const subtract = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point2, b: Point2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Point2, b: Point2) => a[0] * b[1] - a[1] * b[0];
const distance = (a: Point2, b: Point2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Lexicographic world order: x, then y; coordinates within epsilon are equal. */
export function comparePoints(a: Point2, b: Point2): number {
  if (Math.abs(a[0] - b[0]) > EPSILON) return a[0] < b[0] ? -1 : 1;
  if (Math.abs(a[1] - b[1]) > EPSILON) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/** Distance of point along the directed segment start -> end, from start. */
export function alongSegment(point: Point2, start: Point2, end: Point2): number {
  const direction = subtract(end, start);
  return dot(subtract(point, start), direction) / Math.hypot(direction[0], direction[1]);
}

export interface CollinearOverlap {
  /** Overlap endpoints in canonical world order (lower x, then y, first). */
  worldStart: Point2;
  worldEnd: Point2;
  lengthMm: number;
  direction: "opposite" | "same";
}

/**
 * Positive-length overlap of two finite collinear segments, or null.
 * Collinear means every endpoint of each segment lies within epsilon of the
 * other segment's line (parallel lines farther apart are never shared).
 * The overlap must be longer than epsilon, so point-only contact (corners,
 * perpendicular T endpoints, collinear end-to-end touches) is not overlap.
 * Overlap endpoints are always two of the four input endpoints and are
 * copied verbatim, never synthesized; within epsilon the first segment's
 * endpoint is kept.
 */
export function collinearOverlap(
  aStart: Point2,
  aEnd: Point2,
  bStart: Point2,
  bEnd: Point2,
): CollinearOverlap | null {
  const aLength = distance(aStart, aEnd);
  const bLength = distance(bStart, bEnd);
  if (aLength <= EPSILON || bLength <= EPSILON) return null;
  const aUnit: Point2 = [(aEnd[0] - aStart[0]) / aLength, (aEnd[1] - aStart[1]) / aLength];
  const bUnit: Point2 = [(bEnd[0] - bStart[0]) / bLength, (bEnd[1] - bStart[1]) / bLength];
  const offLine = (point: Point2, origin: Point2, unit: Point2) =>
    Math.abs(cross(unit, subtract(point, origin)));
  if (
    offLine(bStart, aStart, aUnit) > EPSILON ||
    offLine(bEnd, aStart, aUnit) > EPSILON ||
    offLine(aStart, bStart, bUnit) > EPSILON ||
    offLine(aEnd, bStart, bUnit) > EPSILON
  ) {
    return null;
  }
  const along = (point: Point2) => dot(subtract(point, aStart), aUnit);
  const [bLow, bHigh] = along(bStart) <= along(bEnd) ? [bStart, bEnd] : [bEnd, bStart];
  const low = along(bLow) > EPSILON ? { t: along(bLow), point: bLow } : { t: 0, point: aStart };
  const high =
    along(bHigh) < aLength - EPSILON
      ? { t: along(bHigh), point: bHigh }
      : { t: aLength, point: aEnd };
  if (high.t - low.t <= EPSILON) return null;
  const [worldStart, worldEnd] =
    comparePoints(low.point, high.point) <= 0 ? [low.point, high.point] : [high.point, low.point];
  return {
    worldStart: [worldStart[0], worldStart[1]],
    worldEnd: [worldEnd[0], worldEnd[1]],
    lengthMm: distance(worldStart, worldEnd),
    direction: dot(aUnit, bUnit) > 0 ? "same" : "opposite",
  };
}

/** Positive-length overlap of two closed 1D intervals. */
export function intervalOverlapMm(
  first: { fromMm: number; toMm: number },
  second: { fromMm: number; toMm: number },
): number {
  return Math.min(first.toMm, second.toMm) - Math.max(first.fromMm, second.fromMm);
}
