import {
  type ArchitecturalExtraction,
  CadInterpretationError,
  deriveSpaceWallStage,
  type LevelCandidate,
  type SpaceCandidate,
  semanticHash,
  type WallCandidate,
} from "@ai-archviz/cad-interpreter";
import {
  CadPartitionError,
  createReviewedPartitionModel,
  type ReviewedPartitionModel,
  validateReviewedPartitionModel,
} from "@ai-archviz/cad-partition-model";
import type { ArchitecturalTopology, SingleSpaceOpeningRelation } from "@ai-archviz/cad-topology";
import { type SceneSpec, validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  assertReferences,
  assertSourceMetadata,
  COORDINATE_SYSTEM,
  compareCodePoints,
  fail,
  IDENTITY_TRANSFORM,
  mapped,
  resolveMappings,
  unlocked,
} from "./seed.js";
import {
  CAD_MULTISPACE_SEED_EXTENSION_KEY,
  CAD_MULTISPACE_SEED_EXTENSION_VERSION,
  CAD_SCENE_SEED_POLICY_VERSION_V02,
  type CadSceneSeedApprovalV02,
  type MultiSpaceSeedInput,
  type SpaceMapping,
} from "./types.js";
import { validateCadSceneSeedApprovalV02 } from "./validate.js";

/*
 * cad-scene-seed-policy-v0.2. Fixed order:
 *   1. validate the seven-artifact bundle, the scene approval v0.2, and the
 *      reviewed-partition-model-v0.1
 *   2. decision must be approved_as_is
 *   3. re-derive the reviewed partition model from its own inputs (10E) and
 *      require it to equal the supplied model exactly
 *   4. the scene approval must bind that model's exact hash chain
 *   5. mappings (levels, spaces, unpaired wall segments, partitions,
 *      openings): sorted, unique, known, complete; logical IDs unique
 *   6. generate SceneSpec v0.5: reviewed room boundaries unchanged, ordinary
 *      walls ONLY for unpaired intervals, one shared_partition per reviewed
 *      partition, partition doors, unshared openings re-hosted on the one
 *      unpaired segment that contains their full span
 *   7. validateSceneSpec (v0.5), then non-CAD reference and source checks
 * Spatial-policy-v0.2 and circulation-policy-v0.2 follow at the worker
 * boundary before anything is written. Nothing is inferred.
 */

const EPSILON_MM = 0.001;
const pad4 = (value: number) => String(value).padStart(4, "0");
const clean = (value: number) => value + 0;

/** A derived, NON-canonical reference to one 10E unpaired interval of one 10B wall. */
export interface UnpairedWallSegmentCandidate {
  candidateId: string;
  wallCandidateId: string;
  ordinal: number;
  fromMm: number;
  toMm: number;
}

export function unpairedWallSegmentCandidateId(wallCandidateId: string, ordinal: number): string {
  return `unpaired_wall_segment_${wallCandidateId}_${pad4(ordinal)}`;
}

/** Every unpaired interval of the reviewed model, in wall then interval order. */
export function unpairedWallSegments(
  model: ReviewedPartitionModel,
): UnpairedWallSegmentCandidate[] {
  return model.wallSegments.flatMap((segmentation) =>
    segmentation.intervals
      .filter((interval) => interval.role === "unpaired")
      .map((interval, ordinal) => ({
        candidateId: unpairedWallSegmentCandidateId(segmentation.wallCandidateId, ordinal),
        wallCandidateId: segmentation.wallCandidateId,
        ordinal,
        fromMm: interval.fromMm,
        toMm: interval.toMm,
      })),
  );
}

/**
 * The single unpaired segment of a wall that contains an opening's COMPLETE
 * span [offset, offset + width] (within epsilon), and the segment-local
 * offset. An opening crossing an unpaired/shared boundary or two segments
 * has no host and fails closed.
 */
export function hostOnUnpairedSegment(
  opening: { candidateId: string; offsetMm: number; widthMm: number },
  segments: readonly UnpairedWallSegmentCandidate[],
): { segment: UnpairedWallSegmentCandidate; localOffsetMm: number } {
  const from = opening.offsetMm;
  const to = opening.offsetMm + opening.widthMm;
  const hosts = segments.filter(
    (segment) => from >= segment.fromMm - EPSILON_MM && to <= segment.toMm + EPSILON_MM,
  );
  if (hosts.length !== 1) {
    fail(
      "CAD_SCENE_SEED_OPENING_SEGMENT_INVALID",
      `Opening ${opening.candidateId} [${from}, ${to}] is not contained by exactly one unpaired wall segment`,
      {
        openingCandidateId: opening.candidateId,
        span: [from, to],
        segments: segments.map((segment) => [segment.candidateId, segment.fromMm, segment.toMm]),
      },
    );
  }
  const segment = hosts[0] as UnpairedWallSegmentCandidate;
  return { segment, localOffsetMm: Math.max(0, clean(from - segment.fromMm)) };
}

function pointAlong(wall: WallCandidate, distanceMm: number, z: number): number[] {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dy);
  if (distanceMm <= 0) return [wall.start[0], wall.start[1], z];
  if (Math.abs(distanceMm - length) <= EPSILON_MM) return [wall.end[0], wall.end[1], z];
  return [
    clean(wall.start[0] + (dx / length) * distanceMm),
    clean(wall.start[1] + (dy / length) * distanceMm),
    z,
  ];
}

export interface CreateMultiSpaceSeedResult {
  sceneSpec: SceneSpec;
  sceneApprovalHash: string;
  reviewedPartitionModelHash: string;
  partitionApprovalHash: string;
  model: ReviewedPartitionModel;
}

interface Candidates {
  level: LevelCandidate;
  spaces: readonly SpaceCandidate[];
  walls: readonly WallCandidate[];
}

export function createMultiSpaceSceneSpecSeed(
  input: MultiSpaceSeedInput,
): CreateMultiSpaceSeedResult {
  // 1. The bundle and every contract first.
  const keys = [
    "cadDocument",
    "interpretationProfile",
    "architecturalExtraction",
    "architecturalTopology",
    "partitionApproval",
    "reviewedPartitionModel",
    "sceneApproval",
  ];
  if (typeof input !== "object" || input === null || keys.some((key) => !(key in input))) {
    fail(
      "CAD_SCENE_SEED_INPUT_INVALID",
      `Multi-space seed input must contain ${keys.join(", ")} (architecturalExtraction may be null)`,
    );
  }
  const approvalResult = validateCadSceneSeedApprovalV02(input.sceneApproval);
  if (!approvalResult.ok) {
    fail("CAD_SCENE_SEED_APPROVAL_INVALID", "Input is not a valid cad-scene-seed-approval-v0.2", {
      errors: approvalResult.errors,
    });
  }
  const modelResult = validateReviewedPartitionModel(input.reviewedPartitionModel);
  if (!modelResult.ok) {
    fail(
      "CAD_SCENE_SEED_PARTITION_MODEL_INVALID",
      "Input is not a valid reviewed-partition-model-v0.1",
      { errors: modelResult.errors },
    );
  }
  const approval: CadSceneSeedApprovalV02 = approvalResult.value;
  const model = modelResult.value;

  // 2. Only an explicit approved_as_is canonicalizes.
  if (approval.decision !== "approved_as_is") {
    fail(
      "CAD_SCENE_SEED_NOT_APPROVED",
      `Approval decision ${approval.decision} is not canonicalizable`,
      { decision: approval.decision },
    );
  }

  // 3. The supplied model must be exactly what 10E derives from its own inputs.
  let derived: ReviewedPartitionModel;
  try {
    derived = createReviewedPartitionModel({
      cadDocument: input.cadDocument,
      interpretationProfile: input.interpretationProfile,
      architecturalExtraction: input.architecturalExtraction,
      architecturalTopology: input.architecturalTopology,
      approval: input.partitionApproval,
    });
  } catch (error) {
    if (!(error instanceof CadPartitionError)) throw error;
    fail(
      "CAD_SCENE_SEED_PARTITION_MODEL_INVALID",
      `The reviewed partition model cannot be re-derived: ${error.message}`,
      { partitionErrorCode: error.code },
    );
  }
  const reviewedPartitionModelHash = semanticHash(model);
  if (semanticHash(derived) !== reviewedPartitionModelHash) {
    fail(
      "CAD_SCENE_SEED_PARTITION_MODEL_MISMATCH",
      "The supplied reviewed partition model differs from the 10E derivation of its bound inputs",
    );
  }

  // 4. Exact model binding (stage basis keeps architecturalExtractionHash = null).
  const bound = approval.reviewedPartitionModel;
  const mismatches = (
    [
      ["reviewedPartitionModelVersion", model.reviewedPartitionModelVersion],
      ["reviewedPartitionModelHash", reviewedPartitionModelHash],
      ["partitionPolicyVersion", model.partitionPolicyVersion],
      ["architecturalTopologyHash", model.source.architecturalTopologyHash],
      ["candidateBasis", model.source.candidateBasis],
      ["sourceHash", model.source.sourceHash],
      ["cadDocumentHash", model.source.cadDocumentHash],
      ["profileHash", model.source.profileHash],
      ["spaceWallStageHash", model.source.spaceWallStageHash],
      ["architecturalExtractionHash", model.source.architecturalExtractionHash],
    ] as const
  ).filter(([field, actual]) => bound[field] !== actual);
  if (mismatches.length > 0) {
    fail(
      "CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH",
      "Approval does not bind this exact reviewed partition model (stale or foreign approval)",
      { fields: mismatches.map(([field]) => field) },
    );
  }

  // The exact 10B candidates (the 10E derivation above already proved the chain).
  const candidates: Candidates =
    input.architecturalExtraction === null
      ? deriveCandidates(input)
      : (input.architecturalExtraction as ArchitecturalExtraction);
  const topology = input.architecturalTopology as ArchitecturalTopology;

  // 5. Explicit, complete, unique mappings.
  const segments = unpairedWallSegments(model);
  const unsharedRelations = topology.openingRelations.filter(
    (relation): relation is SingleSpaceOpeningRelation => relation.relationKind === "single_space",
  );
  const partitionDoors = model.sharedPartitions.flatMap((partition) =>
    partition.openings.map((door) => ({ partition, door })),
  );
  const levels = resolveMappings("level", approval.mappings.levels, [
    candidates.level.levelCandidateId,
  ]);
  const spaces = resolveMappings<SpaceMapping>(
    "space",
    approval.mappings.spaces,
    candidates.spaces.map((space) => space.candidateId),
  );
  const walls = resolveMappings(
    "wall segment",
    approval.mappings.walls,
    segments.map((segment) => segment.candidateId),
  );
  const partitions = resolveMappings(
    "partition",
    approval.mappings.partitions,
    model.sharedPartitions.map((partition) => partition.partitionCandidateId),
  );
  const openings = resolveMappings(
    "opening",
    approval.mappings.openings,
    [
      ...partitionDoors.map(({ door }) => door.topologyOpeningId),
      ...unsharedRelations.map((relation) => relation.topologyOpeningId),
    ].sort(compareCodePoints),
  );
  const state = approval.nonCadState;
  const logicalIds = [
    ...approval.mappings.levels.map((mapping) => mapping.logicalId),
    ...approval.mappings.spaces.flatMap((mapping) => [
      mapping.logicalId,
      mapping.floorSurfaceId,
      mapping.ceilingSurfaceId,
    ]),
    ...approval.mappings.walls.map((mapping) => mapping.logicalId),
    ...approval.mappings.partitions.map((mapping) => mapping.logicalId),
    ...approval.mappings.openings.map((mapping) => mapping.logicalId),
    ...[...state.assets, ...state.cameras, ...state.lights].map((entry) => String(entry.id)),
  ];
  const seen = new Set<string>();
  for (const logicalId of logicalIds) {
    if (seen.has(logicalId)) {
      fail(
        "CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE",
        `Canonical logical ID ${logicalId} is used twice`,
        { logicalId },
      );
    }
    seen.add(logicalId);
  }

  // 6. Generate. Every architectural fact is copied from 10B / 10E.
  const level = candidates.level;
  const levelId = mapped(levels, level.levelCandidateId).logicalId;
  const spaceId = (candidateId: string) => mapped(spaces, candidateId).logicalId;
  const wallsById = new Map(candidates.walls.map((wall) => [wall.candidateId, wall]));
  const elevate = ([x, y]: readonly number[], z: number) => [x as number, y as number, z];

  // Reviewed room boundaries are kept exactly; never rewritten to partition faces.
  const sceneSpaces = candidates.spaces.map((space) => ({
    id: spaceId(space.candidateId),
    levelId,
    type: space.spaceType,
    boundary: space.boundary.map((point) => elevate(point, space.floorElevationMm)),
    boundaryWinding: space.boundaryWinding,
    floorElevation: space.floorElevationMm,
    ceilingHeight: space.ceilingHeightMm,
    transform: structuredClone(IDENTITY_TRANSFORM),
  }));

  // Ordinary single-space walls ONLY for unpaired intervals (no duplicate geometry).
  const sceneWalls = segments.map((segment) => {
    const wall = wallsById.get(segment.wallCandidateId) as WallCandidate;
    return {
      id: mapped(walls, segment.candidateId).logicalId,
      type: "wall",
      levelId,
      spaceId: spaceId(wall.spaceCandidateId),
      start: pointAlong(wall, segment.fromMm, level.elevationMm),
      end: pointAlong(wall, segment.toMm, level.elevationMm),
      baseElevation: wall.baseElevationMm,
      height: wall.heightMm,
      thickness: wall.thicknessMm,
      referenceLine: wall.referenceLine,
      thicknessDirection: wall.thicknessDirection,
      transform: structuredClone(IDENTITY_TRANSFORM),
      locks: unlocked(),
    };
  });

  const scenePartitions = model.sharedPartitions.map((partition) => {
    const z = partition.baseElevationMm;
    return {
      id: mapped(partitions, partition.partitionCandidateId).logicalId,
      type: "shared_partition",
      levelId,
      adjacentSpaceIds: partition.adjacentSpaceCandidateIds.map(spaceId).sort(compareCodePoints),
      start: elevate(partition.centerLineStart, z),
      end: elevate(partition.centerLineEnd, z),
      baseElevation: partition.baseElevationMm,
      height: partition.heightMm,
      thickness: partition.thicknessMm,
      referenceLine: "centerline",
      spaceFaces: partition.spaceFaces.map((face) => ({
        spaceId: spaceId(face.spaceCandidateId),
        side: face.side,
        start: elevate(face.start, z),
        end: elevate(face.end, z),
      })),
      transform: structuredClone(IDENTITY_TRANSFORM),
      locks: unlocked(),
    };
  });

  const surfaces = candidates.spaces.flatMap((space) => {
    const mapping = mapped(spaces, space.candidateId);
    const boundary = space.boundary.map((point) => elevate(point, space.floorElevationMm));
    const ceilingElevation = space.floorElevationMm + space.ceilingHeightMm;
    const surface = (id: string, type: "floor" | "ceiling", elevation: number) => ({
      id,
      type,
      levelId,
      spaceId: mapping.logicalId,
      boundary: structuredClone(boundary),
      elevation,
      thickness: 0,
      extrusionDirection: "none",
      transform: { position: [0, 0, elevation], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      locks: unlocked(),
    });
    return [
      surface(mapping.floorSurfaceId, "floor", space.floorElevationMm),
      surface(mapping.ceilingSurfaceId, "ceiling", ceilingElevation),
    ];
  });

  const openingTransform = (offset: number, sill: number) => ({
    position: [offset, 0, sill],
    rotationEuler: [0, 0, 0],
    scale: [1, 1, 1],
  });
  const sceneOpenings = [
    ...partitionDoors.map(({ partition, door }) => ({
      order: door.topologyOpeningId,
      value: {
        id: mapped(openings, door.topologyOpeningId).logicalId,
        type: "door",
        hostGeometryId: mapped(partitions, partition.partitionCandidateId).logicalId,
        connectsSpaceIds: door.connectsSpaces.map(spaceId).sort(compareCodePoints),
        // Offset along the reviewed centerline worldStart -> worldEnd (never a room-wall direction).
        offset: door.offsetFromWorldStartMm,
        width: door.widthMm,
        sill: door.sillMm,
        height: door.heightMm,
        hingeEndpoint: door.hingeEndpoint === "world_start" ? "host_start" : "host_end",
        swingIntoSpaceId: spaceId(door.swingIntoSpaceCandidateId),
        transform: openingTransform(door.offsetFromWorldStartMm, door.sillMm),
        locks: unlocked(),
      } as Record<string, unknown>,
    })),
    ...unsharedRelations.map((relation) => {
      const opening = relation.openingCandidate;
      const { segment, localOffsetMm } = hostOnUnpairedSegment(
        { candidateId: opening.candidateId, offsetMm: opening.offsetMm, widthMm: opening.widthMm },
        segments.filter((entry) => entry.wallCandidateId === opening.hostWallCandidateId),
      );
      const common = {
        id: mapped(openings, relation.topologyOpeningId).logicalId,
        type: opening.type,
        hostGeometryId: mapped(walls, segment.candidateId).logicalId,
        offset: localOffsetMm,
        width: opening.widthMm,
        sill: opening.sillMm,
        height: opening.heightMm,
      };
      return {
        order: relation.topologyOpeningId,
        value: (opening.type === "door"
          ? {
              ...common,
              hingeSide: opening.hingeSide,
              swingDirection: opening.swingDirection,
              transform: openingTransform(localOffsetMm, opening.sillMm),
              locks: unlocked(),
            }
          : {
              ...common,
              transform: openingTransform(localOffsetMm, opening.sillMm),
              locks: unlocked(),
            }) as Record<string, unknown>,
      };
    }),
  ]
    .sort((left, right) => compareCodePoints(left.order, right.order))
    .map((entry) => entry.value);

  const sceneApprovalHash = semanticHash(approval);
  const sceneSpec: SceneSpec = {
    sceneSpecVersion: "0.5.0",
    project: structuredClone(approval.canonical.project),
    scene: {
      id: approval.canonical.scene.id,
      revisionId: approval.canonical.scene.revisionId,
      headRevisionId: approval.canonical.scene.revisionId,
    },
    coordinateSystem: structuredClone(COORDINATE_SYSTEM),
    sources: structuredClone(state.sources),
    levels: [
      {
        id: levelId,
        name: level.name,
        elevation: level.elevationMm,
        defaultCeilingHeight: level.defaultCeilingHeightMm,
      },
    ],
    spaces: sceneSpaces,
    geometry: [...sceneWalls, ...scenePartitions, ...surfaces],
    openings: sceneOpenings,
    assetDefinitions: structuredClone(state.assetDefinitions),
    assets: structuredClone(state.assets),
    materials: structuredClone(state.materials),
    materialAssignments: structuredClone(state.materialAssignments),
    cameras: structuredClone(state.cameras),
    render: structuredClone(state.render),
    revisions: [
      {
        revisionId: approval.canonical.scene.revisionId,
        parentRevisionId: null,
        status: "committed",
        createdAt: approval.canonical.scene.createdAt,
      },
    ],
    extensions: {
      [CAD_MULTISPACE_SEED_EXTENSION_KEY]: {
        version: CAD_MULTISPACE_SEED_EXTENSION_VERSION,
        seedPolicy: CAD_SCENE_SEED_POLICY_VERSION_V02,
        sceneApprovalId: approval.approvalId,
        sceneApprovalHash,
        partitionPolicyVersion: model.partitionPolicyVersion,
        partitionApprovalId: model.approvalId,
        partitionApprovalHash: model.approvalHash,
        reviewedPartitionModelHash,
        architecturalTopologyHash: model.source.architecturalTopologyHash,
        candidateBasis: model.source.candidateBasis,
        spaceWallStageHash: model.source.spaceWallStageHash,
        // Legitimately null for the space_wall_stage basis; never a placeholder.
        architecturalExtractionHash: model.source.architecturalExtractionHash,
        profileId: model.source.profileId,
        profileHash: model.source.profileHash,
        cadDocumentHash: model.source.cadDocumentHash,
        sourceHash: model.source.sourceHash,
        mappings: structuredClone(approval.mappings),
      },
    },
    lights: structuredClone(state.lights),
    circulationRequirements: structuredClone(state.circulationRequirements),
  };

  // 7. The generated seed must satisfy SceneSpec v0.5 and its references.
  const sceneResult = validateSceneSpec(sceneSpec);
  if (!sceneResult.ok) {
    fail("CAD_SCENE_SEED_SCENESPEC_INVALID", "Generated seed is not a valid SceneSpec v0.5", {
      errors: sceneResult.errors,
    });
  }
  assertReferences(sceneSpec);
  assertSourceMetadata(sceneSpec, model.source.sourceHash);
  return {
    sceneSpec,
    sceneApprovalHash,
    reviewedPartitionModelHash,
    partitionApprovalHash: model.approvalHash,
    model,
  };
}

function deriveCandidates(input: MultiSpaceSeedInput): Candidates {
  try {
    return deriveSpaceWallStage(input.cadDocument, input.interpretationProfile);
  } catch (error) {
    if (!(error instanceof CadInterpretationError)) throw error;
    fail("CAD_SCENE_SEED_INPUT_INVALID", "The bound CAD source fails the 10B space/wall stage", {
      interpretationErrorCode: error.code,
    });
  }
}
