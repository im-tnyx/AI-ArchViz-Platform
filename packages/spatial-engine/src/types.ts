/**
 * Pure, DCC-independent types for the deterministic spatial safety oracle
 * (spatial-policy-v0.1, Technical Spike 9A). Nothing in this package touches
 * 3ds Max, pymxs, Corona, filesystem paths, OS state, or worker process
 * execution: inputs are plain validated canonical data, outputs are plain
 * deterministic data.
 */

export type Vector3 = readonly [number, number, number];
export type Point2 = readonly [number, number];

export interface SemanticTransform {
  position: Vector3;
  rotationEuler: Vector3;
  scale: Vector3;
}

/** An oriented rectangle in world-space floor-plan XY. */
export interface OrientedRectangle {
  centerXY: Point2;
  widthMm: number;
  lengthMm: number;
  rotationZDegrees: number;
  /** Canonical corner order: local (-x,-y), (+x,-y), (+x,+y), (-x,+y), transformed to world XY. */
  cornersXY: readonly [Point2, Point2, Point2, Point2];
}

export interface AssetFootprint extends OrientedRectangle {
  assetId: string;
  assetDefinitionId: string;
  spaceId: string;
}

export interface DoorwayClearance {
  openingId: string;
  hostGeometryId: string;
  spaceId: string;
  widthMm: number;
  depthMm: number;
  /** Wall-face edge first (start, end), then the two into-room corners. */
  cornersXY: readonly [Point2, Point2, Point2, Point2];
}

export type SpatialViolationCode =
  | "SPATIAL_FOOTPRINT_UNSUPPORTED"
  | "SPATIAL_ASSET_OUTSIDE_SPACE"
  | "SPATIAL_ASSET_COLLISION"
  | "SPATIAL_DOOR_CLEARANCE_BLOCKED";

export interface SpatialViolation {
  code: SpatialViolationCode;
  message: string;
  assetId?: string;
  assetAId?: string;
  assetBId?: string;
  spaceId?: string;
  openingId?: string;
  hostGeometryId?: string;
}

export interface SpatialSceneValidationResult {
  policyVersion: "spatial-policy-v0.1";
  sceneSpecVersion: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  status: "PASS" | "FAILED";
  assetFootprints: AssetFootprint[];
  doorwayClearances: DoorwayClearance[];
  violations: SpatialViolation[];
}

export interface SpaceInput {
  id: string;
  boundary: Vector3[];
}

export interface WallInput {
  id: string;
  type: string;
  spaceId?: string;
  start?: Vector3;
  end?: Vector3;
}

export interface DoorOpeningInput {
  id: string;
  type: string;
  hostGeometryId: string;
  offset: number;
  width: number;
}

export interface AssetDefinitionInput {
  id: string;
  dimensions: Vector3;
  pivotPolicy: string;
}

export interface AssetInput {
  id: string;
  type: string;
  assetDefinitionId: string;
  spaceId: string;
  transform: SemanticTransform;
}

export interface SpatialSceneInput {
  sceneSpecVersion: string;
  project: { id: string };
  scene: { id: string; revisionId: string };
  spaces: SpaceInput[];
  geometry: Array<Record<string, unknown>>;
  openings: Array<Record<string, unknown>>;
  assets: AssetInput[];
  assetDefinitions: AssetDefinitionInput[];
}
