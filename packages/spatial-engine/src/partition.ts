import { SPATIAL_EPSILON_MM } from "./geometry.js";
import type {
  DoorwayClearanceV02,
  PartitionDoorInput,
  PartitionSolid,
  Point2,
  SharedPartitionInput,
} from "./types.js";

/**
 * spatial-policy-v0.2 shared-partition geometry (Spike 10F). The partition
 * body is `thickness` wide and centered on its reviewed centerline
 * start -> end; u = normalize(end - start), leftNormal = [-u.y, u.x],
 * rightNormal = [u.y, -u.x] (the frozen 10E/SceneSpec v0.5 frame). Door
 * openings are voids: only the centerline intervals between them are solid.
 */

const clean = (value: number) => value + 0;
const pad4 = (value: number) => String(value).padStart(4, "0");

export interface PartitionFrame {
  lengthMm: number;
  unit: Point2;
  leftNormal: Point2;
  rightNormal: Point2;
}

export function partitionFrame(
  partition: Pick<SharedPartitionInput, "start" | "end">,
): PartitionFrame {
  const dx = partition.end[0] - partition.start[0];
  const dy = partition.end[1] - partition.start[1];
  const lengthMm = Math.hypot(dx, dy);
  if (lengthMm <= SPATIAL_EPSILON_MM)
    throw new Error("Partition centerline must have positive length");
  const unit: Point2 = [clean(dx / lengthMm), clean(dy / lengthMm)];
  return {
    lengthMm,
    unit,
    leftNormal: [clean(-unit[1]), clean(unit[0])],
    rightNormal: [clean(unit[1]), clean(-unit[0])],
  };
}

/** The point at `alongMm` on the centerline, offset `offsetMm` along `normal`. */
function framePoint(
  partition: Pick<SharedPartitionInput, "start">,
  frame: PartitionFrame,
  alongMm: number,
  normal: Point2,
  offsetMm: number,
): Point2 {
  return [
    clean(partition.start[0] + frame.unit[0] * alongMm + normal[0] * offsetMm),
    clean(partition.start[1] + frame.unit[1] * alongMm + normal[1] * offsetMm),
  ];
}

/**
 * Positive-length solid intervals of a partition around its hosted door
 * voids: [0, first.offset], [first.offset + width, next.offset], ...,
 * [last end, L]. Zero-length pieces are omitted; pieces never overlap and
 * the only gaps are the approved openings.
 */
export function derivePartitionSolids(
  partition: SharedPartitionInput,
  openings: readonly PartitionDoorInput[],
): PartitionSolid[] {
  const frame = partitionFrame(partition);
  const half = partition.thickness / 2;
  const hosted = openings
    .filter((opening) => opening.hostGeometryId === partition.id)
    .sort((left, right) => left.offset - right.offset || (left.id < right.id ? -1 : 1));
  const intervals: Array<[number, number]> = [];
  let cursor = 0;
  for (const opening of hosted) {
    if (opening.offset - cursor > SPATIAL_EPSILON_MM) intervals.push([cursor, opening.offset]);
    cursor = Math.max(cursor, opening.offset + opening.width);
  }
  if (frame.lengthMm - cursor > SPATIAL_EPSILON_MM) intervals.push([cursor, frame.lengthMm]);
  return intervals.map(([fromMm, toMm], index) => ({
    solidId: `${partition.id}::solid::${pad4(index)}`,
    partitionId: partition.id,
    adjacentSpaceIds: [partition.adjacentSpaceIds[0], partition.adjacentSpaceIds[1]],
    fromMm,
    toMm,
    lengthMm: toMm - fromMm,
    thicknessMm: partition.thickness,
    cornersXY: [
      framePoint(partition, frame, fromMm, frame.rightNormal, half),
      framePoint(partition, frame, toMm, frame.rightNormal, half),
      framePoint(partition, frame, toMm, frame.leftNormal, half),
      framePoint(partition, frame, fromMm, frame.leftNormal, half),
    ],
  }));
}

/**
 * One doorway access-clearance envelope PER connected space of a
 * shared-partition door (the same conservative 9A rule, not swing geometry):
 * width = opening.width along the partition, depth = opening.width into that
 * space, starting on that space's physical partition face and extending
 * along that side's normal. Never depends on hinge endpoint or swing space.
 */
export function derivePartitionDoorClearances(
  opening: PartitionDoorInput,
  partition: SharedPartitionInput,
): DoorwayClearanceV02[] {
  const frame = partitionFrame(partition);
  const half = partition.thickness / 2;
  const depthMm = opening.width;
  return partition.spaceFaces.map((face) => {
    const normal = face.side === "left" ? frame.leftNormal : frame.rightNormal;
    const faceStart = framePoint(partition, frame, opening.offset, normal, half);
    const faceEnd = framePoint(partition, frame, opening.offset + opening.width, normal, half);
    const into = (point: Point2): Point2 => [
      clean(point[0] + normal[0] * depthMm),
      clean(point[1] + normal[1] * depthMm),
    ];
    return {
      openingId: opening.id,
      hostGeometryId: partition.id,
      spaceId: face.spaceId,
      widthMm: opening.width,
      depthMm,
      cornersXY: [faceStart, faceEnd, into(faceEnd), into(faceStart)],
      hostType: "shared_partition" as const,
      side: face.side,
    };
  });
}
