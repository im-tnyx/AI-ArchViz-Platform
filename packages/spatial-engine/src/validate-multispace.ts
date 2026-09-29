import { rectanglesOverlap, SPATIAL_EPSILON_MM } from "./geometry.js";
import { derivePartitionDoorClearances, derivePartitionSolids } from "./partition.js";
import type {
  AssetFootprint,
  DoorwayClearanceV02,
  PartitionDoorInput,
  PartitionSolid,
  SharedPartitionInput,
  SpatialSceneInput,
  SpatialSceneValidationResult,
  SpatialSceneValidationResultV02,
  SpatialViolationV02,
} from "./types.js";
import {
  collectDoorwayClearances,
  collectFootprints,
  collisionViolations,
  doorClearanceViolations,
  outsideSpaceViolations,
  validateSpatialScene,
} from "./validate.js";

export const SPATIAL_POLICY_VERSION_V02 = "spatial-policy-v0.2" as const;

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function sharedPartitions(scene: SpatialSceneInput): SharedPartitionInput[] {
  return (scene.geometry as unknown as SharedPartitionInput[])
    .filter((entry) => entry.type === "shared_partition")
    .sort((left, right) => compareText(left.id, right.id));
}

function partitionDoors(scene: SpatialSceneInput): PartitionDoorInput[] {
  return (scene.openings as unknown as PartitionDoorInput[]).filter(
    (entry) => entry.type === "door" && Array.isArray(entry.connectsSpaceIds),
  );
}

/** All physical partition solids of a SceneSpec v0.5, in partition then interval order. */
export function scenePartitionSolids(sceneSpecValue: Record<string, unknown>): PartitionSolid[] {
  const scene = sceneSpecValue as unknown as SpatialSceneInput;
  const doors = partitionDoors(scene);
  return sharedPartitions(scene).flatMap((partition) => derivePartitionSolids(partition, doors));
}

function partitionOverlapViolations(
  footprints: readonly AssetFootprint[],
  solids: readonly PartitionSolid[],
): SpatialViolationV02[] {
  const violations: SpatialViolationV02[] = [];
  for (const footprint of footprints) {
    for (const solid of solids) {
      if (!solid.adjacentSpaceIds.includes(footprint.spaceId)) continue;
      if (rectanglesOverlap(footprint.cornersXY, solid.cornersXY, SPATIAL_EPSILON_MM)) {
        violations.push({
          code: "SPATIAL_ASSET_PARTITION_OVERLAP",
          message: `Asset ${footprint.assetId} overlaps physical partition solid ${solid.solidId}`,
          assetId: footprint.assetId,
          spaceId: footprint.spaceId,
          partitionId: solid.partitionId,
          partitionSolidId: solid.solidId,
        });
      }
    }
  }
  return violations;
}

function violationSortKey(violation: SpatialViolationV02): string {
  return [
    violation.code,
    violation.assetId ?? violation.assetAId ?? "",
    violation.assetBId ?? violation.openingId ?? violation.partitionSolidId ?? "",
    violation.spaceId ?? "",
  ].join(" ");
}

/**
 * Pure full-scene spatial validation for SceneSpec v0.5 (spatial-policy-v0.2).
 * Keeps every 9A rule (footprint support, space containment, asset
 * collision, doorway clearance) and adds shared-partition semantics: the
 * space boundary alone is no longer the occupancy limit, because a
 * partition solid straddles it; assets assigned to either adjacent space
 * must not overlap any partition solid (door voids are not solid), and a
 * partition door yields one doorway clearance per connected space, each
 * starting on that space's partition face.
 */
export function validateSpatialSceneV02(
  sceneSpecValue: Record<string, unknown>,
): SpatialSceneValidationResultV02 {
  const scene = sceneSpecValue as unknown as SpatialSceneInput;
  if (scene.sceneSpecVersion !== "0.5.0") {
    throw new Error(
      `${SPATIAL_POLICY_VERSION_V02} applies only to SceneSpec 0.5.0, not ${scene.sceneSpecVersion}`,
    );
  }
  const { footprints, unsupported } = collectFootprints(scene);
  const partitionSolids = scenePartitionSolids(sceneSpecValue);
  const partitionsById = new Map(sharedPartitions(scene).map((entry) => [entry.id, entry]));
  const doorwayClearances: DoorwayClearanceV02[] = [
    ...collectDoorwayClearances(scene).map((clearance) => ({
      ...clearance,
      hostType: "wall" as const,
      side: null,
    })),
    ...partitionDoors(scene).flatMap((door) => {
      const partition = partitionsById.get(door.hostGeometryId);
      return partition ? derivePartitionDoorClearances(door, partition) : [];
    }),
  ].sort(
    (left, right) =>
      compareText(left.openingId, right.openingId) || compareText(left.spaceId, right.spaceId),
  );
  const violations: SpatialViolationV02[] = [
    ...unsupported,
    ...outsideSpaceViolations(scene, footprints),
    ...collisionViolations(footprints),
    ...partitionOverlapViolations(footprints, partitionSolids),
    ...doorClearanceViolations(footprints, doorwayClearances),
  ].sort((left, right) => compareText(violationSortKey(left), violationSortKey(right)));
  return {
    policyVersion: SPATIAL_POLICY_VERSION_V02,
    sceneSpecVersion: scene.sceneSpecVersion,
    projectId: scene.project.id,
    sceneId: scene.scene.id,
    revisionId: scene.scene.revisionId,
    status: violations.length === 0 ? "PASS" : "FAILED",
    assetFootprints: footprints,
    partitionSolids,
    doorwayClearances,
    violations,
  };
}

/**
 * Explicit policy dispatch by SceneSpec version: <= 0.4.0 -> spatial-policy-v0.1
 * (unchanged), 0.5.0 -> spatial-policy-v0.2. Never "latest available".
 */
export function validateSpatialSceneForVersion(
  sceneSpecValue: Record<string, unknown>,
): SpatialSceneValidationResult | SpatialSceneValidationResultV02 {
  return sceneSpecValue.sceneSpecVersion === "0.5.0"
    ? validateSpatialSceneV02(sceneSpecValue)
    : validateSpatialScene(sceneSpecValue);
}
