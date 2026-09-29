import { CAD_PARTITION_EPSILON_MM as EPSILON, type PartitionSide, type Point2 } from "./types.js";

/** Pure 2D plan geometry used by cad-shared-partition-policy-v0.1. */

/** Normalizes -0 to 0 so derived coordinates serialize and compare canonically. */
const clean = (value: number) => value + 0;
const point = (x: number, y: number): Point2 => [clean(x), clean(y)];

export function unitDirection(start: Point2, end: Point2): Point2 {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  return point((end[0] - start[0]) / length, (end[1] - start[1]) / length);
}

/** Frozen v0.1 normals of a directed centerline u: left = [-u.y, u.x], right = [u.y, -u.x]. */
export function normals(unit: Point2): { left: Point2; right: Point2 } {
  return { left: point(-unit[1], unit[0]), right: point(unit[1], -unit[0]) };
}

/** The segment translated by normal * distance, keeping its direction. */
export function offsetSegment(
  start: Point2,
  end: Point2,
  normal: Point2,
  distance: number,
): [Point2, Point2] {
  return [
    point(start[0] + normal[0] * distance, start[1] + normal[1] * distance),
    point(end[0] + normal[0] * distance, end[1] + normal[1] * distance),
  ];
}

/** Perpendicular distance from a point to the infinite line through start -> end. */
export function distanceToLine(target: Point2, start: Point2, end: Point2): number {
  const unit = unitDirection(start, end);
  return Math.abs(unit[0] * (target[1] - start[1]) - unit[1] * (target[0] - start[0]));
}

/** Distance along the directed segment start -> end, from start. */
export function alongSegment(target: Point2, start: Point2, end: Point2): number {
  const unit = unitDirection(start, end);
  return (target[0] - start[0]) * unit[0] + (target[1] - start[1]) * unit[1];
}

/** The point at a distance along the directed segment start -> end. */
export function pointAlong(start: Point2, end: Point2, distanceMm: number): Point2 {
  const unit = unitDirection(start, end);
  return point(start[0] + unit[0] * distanceMm, start[1] + unit[1] * distanceMm);
}

/**
 * The partition side a space occupies. A normalized CCW 10B wall has its
 * space interior on its LEFT, so a wall running with the centerline puts the
 * space on the centerline's left, and one running against it on the right.
 * A wall that is not (anti)parallel resolves to no side.
 */
export function spaceSideOfWall(
  wallStart: Point2,
  wallEnd: Point2,
  centerLineUnit: Point2,
): PartitionSide | null {
  const wallUnit = unitDirection(wallStart, wallEnd);
  const alignment = wallUnit[0] * centerLineUnit[0] + wallUnit[1] * centerLineUnit[1];
  if (Math.abs(Math.abs(alignment) - 1) > EPSILON) return null;
  return alignment > 0 ? "left" : "right";
}
