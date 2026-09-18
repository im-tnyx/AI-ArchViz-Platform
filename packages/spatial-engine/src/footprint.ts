import { orientedRectangleCorners, SPATIAL_EPSILON_MM, wallFrame } from "./geometry.js";
import type {
  AssetDefinitionInput,
  AssetFootprint,
  AssetInput,
  DoorOpeningInput,
  DoorwayClearance,
  Point2,
  WallInput,
} from "./types.js";

/**
 * Supported footprint model (Spike 9A scope): `type = proxy_asset`,
 * `pivotPolicy = floor_center`, positive scale, and upright orientation
 * (`rotationEuler.x`/`.y` within `SPATIAL_EPSILON_MM` degrees of zero).
 * `rotationEuler.z` is fully supported. Anything else fails closed with no
 * guessed footprint.
 */
export function deriveAssetFootprint(
  asset: AssetInput,
  definition: AssetDefinitionInput | undefined,
): AssetFootprint | null {
  if (asset.type !== "proxy_asset") return null;
  if (!definition) return null;
  if (definition.pivotPolicy !== "floor_center") return null;
  const { position, rotationEuler, scale } = asset.transform;
  if (!Number.isFinite(position[0]) || !Number.isFinite(position[1])) return null;
  if (!Number.isFinite(scale[0]) || !Number.isFinite(scale[1]) || scale[0] <= 0 || scale[1] <= 0) {
    return null;
  }
  if (
    Math.abs(rotationEuler[0]) > SPATIAL_EPSILON_MM ||
    Math.abs(rotationEuler[1]) > SPATIAL_EPSILON_MM
  ) {
    return null;
  }
  const [defWidth, defLength] = definition.dimensions;
  if (
    !Number.isFinite(defWidth) ||
    !Number.isFinite(defLength) ||
    defWidth <= 0 ||
    defLength <= 0
  ) {
    return null;
  }
  const widthMm = defWidth * scale[0];
  const lengthMm = defLength * scale[1];
  const centerXY: Point2 = [position[0], position[1]];
  const rotationZDegrees = rotationEuler[2];
  return {
    assetId: asset.id,
    assetDefinitionId: asset.assetDefinitionId,
    spaceId: asset.spaceId,
    centerXY,
    widthMm,
    lengthMm,
    rotationZDegrees,
    cornersXY: orientedRectangleCorners(centerXY, widthMm / 2, lengthMm / 2, rotationZDegrees),
  };
}

/**
 * Conservative doorway access-clearance envelope (NOT swing geometry, NOT a
 * building-code claim): a rectangle of `width = opening.width` along the
 * wall and `depth = opening.width` into the room, starting at the interior
 * wall face. The interior side is the LEFT normal of the wall's `u`
 * (opposite `exteriorNormal`), matching `thicknessDirection:
 * exterior_right_of_u` via the shared `wallFrame`. Applies identically
 * regardless of `swingDirection` (the rule protects doorway access, not the
 * physical swing leaf) and never depends on `hingeSide`. Windows never
 * produce a clearance zone.
 */
export function deriveDoorwayClearance(
  opening: DoorOpeningInput,
  hostWall: WallInput | undefined,
): DoorwayClearance | null {
  if (hostWall?.type !== "wall" || !hostWall.start || !hostWall.end) return null;
  if (!Number.isFinite(opening.offset) || !Number.isFinite(opening.width) || opening.width <= 0) {
    return null;
  }
  const wallStartPoint = hostWall.start;
  const { u, exteriorNormal } = wallFrame({ start: hostWall.start, end: hostWall.end });
  const interiorNormal: Point2 = [-exteriorNormal[0], -exteriorNormal[1]];
  const at = (offset: number): Point2 => [
    wallStartPoint[0] + u[0] * offset,
    wallStartPoint[1] + u[1] * offset,
  ];
  const wallStart = at(opening.offset);
  const wallEnd = at(opening.offset + opening.width);
  const depthMm = opening.width;
  const into = (point: Point2): Point2 => [
    point[0] + interiorNormal[0] * depthMm,
    point[1] + interiorNormal[1] * depthMm,
  ];
  return {
    openingId: opening.id,
    hostGeometryId: hostWall.id,
    spaceId: hostWall.spaceId ?? "",
    widthMm: opening.width,
    depthMm,
    cornersXY: [wallStart, wallEnd, into(wallEnd), into(wallStart)],
  };
}
