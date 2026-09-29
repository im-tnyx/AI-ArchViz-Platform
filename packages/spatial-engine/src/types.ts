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

// ------------------------------------------------ spatial-policy-v0.2 (10F)

/** SceneSpec v0.5 shared_partition as read by spatial-policy-v0.2. */
export interface SharedPartitionInput {
  id: string;
  type: "shared_partition";
  adjacentSpaceIds: readonly [string, string];
  start: Vector3;
  end: Vector3;
  thickness: number;
  spaceFaces: ReadonlyArray<{
    spaceId: string;
    side: "left" | "right";
    start: Vector3;
    end: Vector3;
  }>;
}

/** SceneSpec v0.5 partition-hosted door as read by spatial-policy-v0.2. */
export interface PartitionDoorInput {
  id: string;
  type: "door";
  hostGeometryId: string;
  offset: number;
  width: number;
  connectsSpaceIds: readonly [string, string];
}

/**
 * One physical solid piece of a shared partition: the centerline interval
 * [fromMm, toMm] between door voids, thickness wide and centered on the
 * centerline, as an exact oriented rectangle. `solidId` is a derived spatial
 * identity (`partitionId::solid::NNNN`), never a SceneSpec logical ID.
 */
export interface PartitionSolid {
  solidId: string;
  partitionId: string;
  adjacentSpaceIds: readonly [string, string];
  fromMm: number;
  toMm: number;
  lengthMm: number;
  thicknessMm: number;
  /** Right-face start, right-face end, left-face end, left-face start. */
  cornersXY: readonly [Point2, Point2, Point2, Point2];
}

export interface DoorwayClearanceV02 extends DoorwayClearance {
  hostType: "wall" | "shared_partition";
  /** The partition side of `spaceId` for a shared-partition door; null for a wall door. */
  side: "left" | "right" | null;
}

export type SpatialViolationCodeV02 = SpatialViolationCode | "SPATIAL_ASSET_PARTITION_OVERLAP";

export interface SpatialViolationV02 extends Omit<SpatialViolation, "code"> {
  code: SpatialViolationCodeV02;
  partitionId?: string;
  partitionSolidId?: string;
}

export interface SpatialSceneValidationResultV02 {
  policyVersion: "spatial-policy-v0.2";
  sceneSpecVersion: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  status: "PASS" | "FAILED";
  assetFootprints: AssetFootprint[];
  partitionSolids: PartitionSolid[];
  doorwayClearances: DoorwayClearanceV02[];
  violations: SpatialViolationV02[];
}
