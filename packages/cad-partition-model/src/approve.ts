import {
  CadInterpretationError,
  deriveSpaceWallStage,
  type LevelCandidate,
  type SpaceCandidate,
  semanticHash,
  validateArchitecturalExtraction,
  validateCadInterpretationProfile,
  type WallCandidate,
} from "@ai-archviz/cad-interpreter";
import { validateCadDocument } from "@ai-archviz/cad-parser";
import {
  type ArchitecturalTopology,
  type InteriorOpeningRelation,
  type SharedBoundary,
  type SingleSpaceOpeningRelation,
  validateArchitecturalTopology,
} from "@ai-archviz/cad-topology";
import {
  alongSegment,
  distanceToLine,
  normals,
  offsetSegment,
  pointAlong,
  spaceSideOfWall,
  unitDirection,
} from "./geometry.js";
import {
  type ApprovalProvenance,
  CAD_SHARED_PARTITION_POLICY_VERSION,
  CadPartitionError,
  type CadPartitionErrorCode,
  type CadTopologyApproval,
  CAD_PARTITION_EPSILON_MM as EPSILON,
  type PartitionDerivedProvenance,
  type PartitionModelSpace,
  type PartitionProfileProvenance,
  type PartitionSide,
  type PartitionSpaceFace,
  type Point2,
  REVIEWED_PARTITION_MODEL_VERSION,
  type ReviewedInteriorDoor,
  type ReviewedPartitionModel,
  type ReviewedPartitionModelInput,
  type SharedPartition,
  type TopologyReference,
  type UnsharedOpeningReference,
  type WallCandidateReference,
  type WallSegmentation,
  type WallSegmentInterval,
} from "./types.js";
import { validateCadTopologyApproval } from "./validate.js";

/*
 * cad-shared-partition-policy-v0.1. Pass order (and therefore error
 * precedence) is fixed:
 *   1. validate the five-artifact bundle (cad-document, profile, extraction
 *      or null, architectural-topology-v0.1, cad-topology-approval-v0.1)
 *   2. the approval decision must be approved_as_shared_partition_model
 *   3. recompute the topology's upstream hash chain from the supplied inputs
 *      (the stage basis reruns only the shared 10B space/wall stage)
 *   4. the approval must bind the exact topology (hash + chain)
 *   5. reviews: exactly one per shared boundary and interior door, sorted
 *   6. partitions: wall agreement, space sides, faces, reviewed doors
 *   7. exact wall segmentation, unshared opening references
 * Topology and 10B supply every length; the approval supplies only
 * semantics (centerline meaning, hinge jamb, swing space). No SceneSpec.
 */

function fail(
  code: CadPartitionErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new CadPartitionError(code, message, details);
}

const pad4 = (value: number) => String(value).padStart(4, "0");
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sortedPair = (first: string, second: string): [string, string] =>
  compareText(first, second) <= 0 ? [first, second] : [second, first];

function derived(derivation: string): PartitionDerivedProvenance {
  return { authority: "derived", derivation };
}

function inconsistent(message: string, details: Record<string, unknown> = {}): never {
  fail("CAD_PARTITION_TOPOLOGY_INCONSISTENT", message, details);
}

interface Candidates {
  level: LevelCandidate;
  spaces: readonly SpaceCandidate[];
  walls: readonly WallCandidate[];
}

// ------------------------------------------------------- 1-4 input chain

function validateBundle(input: ReviewedPartitionModelInput) {
  const keys = [
    "cadDocument",
    "interpretationProfile",
    "architecturalExtraction",
    "architecturalTopology",
    "approval",
  ];
  if (typeof input !== "object" || input === null || keys.some((key) => !(key in input))) {
    fail(
      "CAD_PARTITION_INPUT_INVALID",
      `Partition input must contain ${keys.join(", ")} (architecturalExtraction may be null)`,
    );
  }
  const cadResult = validateCadDocument(input.cadDocument);
  if (!cadResult.ok) {
    fail("CAD_PARTITION_INPUT_INVALID", "Input is not a valid cad-document-v0.1", {
      artifact: "cad-document-v0.1",
      errors: cadResult.errors,
    });
  }
  const profileResult = validateCadInterpretationProfile(input.interpretationProfile);
  if (!profileResult.ok) {
    fail("CAD_PARTITION_INPUT_INVALID", "Input is not a valid cad-interpretation-profile-v0.1", {
      artifact: "cad-interpretation-profile-v0.1",
      errors: profileResult.errors,
    });
  }
  const topologyResult = validateArchitecturalTopology(input.architecturalTopology);
  if (!topologyResult.ok) {
    // A window on a room-to-room boundary is never valid topology (10D
    // rejects it); name it explicitly when a tampered artifact carries one.
    const relations = (input.architecturalTopology as { openingRelations?: unknown })
      ?.openingRelations;
    const sharedWindow =
      Array.isArray(relations) &&
      relations.some(
        (relation) =>
          (relation as { relationKind?: unknown })?.relationKind === "interior_shared_boundary" &&
          (relation as { type?: unknown })?.type !== "door",
      );
    if (sharedWindow) {
      fail(
        "CAD_PARTITION_SHARED_WINDOW_INVALID",
        "Topology carries a non-door opening on a shared boundary; interior glazing is unsupported",
      );
    }
    fail("CAD_PARTITION_INPUT_INVALID", "Input is not a valid architectural-topology-v0.1", {
      artifact: "architectural-topology-v0.1",
      errors: topologyResult.errors,
    });
  }
  const approvalResult = validateCadTopologyApproval(input.approval);
  if (!approvalResult.ok) {
    fail("CAD_PARTITION_APPROVAL_INVALID", "Input is not a valid cad-topology-approval-v0.1", {
      errors: approvalResult.errors,
    });
  }
  return {
    cadDocument: cadResult.value,
    profile: profileResult.value,
    topology: topologyResult.value,
    approval: approvalResult.value,
  };
}

function recomputeCandidates(
  input: ReviewedPartitionModelInput,
  bundle: ReturnType<typeof validateBundle>,
): Candidates {
  const { cadDocument, profile, topology } = bundle;
  const { source } = topology;
  const cadDocumentHash = semanticHash(cadDocument);
  const profileHash = semanticHash(profile);
  const mismatches = [
    ...(source.sourceHash === cadDocument.sourceHash ? [] : ["sourceHash"]),
    ...(source.cadDocumentHash === cadDocumentHash ? [] : ["cadDocumentHash"]),
    ...(source.profileHash === profileHash ? [] : ["profileHash"]),
    ...(source.profileId === profile.profileId ? [] : ["profileId"]),
  ];
  let candidates: Candidates;
  if (source.candidateBasis === "architectural_extraction") {
    if (input.architecturalExtraction === null) {
      fail(
        "CAD_PARTITION_INPUT_INVALID",
        "The architectural_extraction basis requires the exact supplied extraction (null is invalid)",
      );
    }
    const extractionResult = validateArchitecturalExtraction(input.architecturalExtraction);
    if (!extractionResult.ok) {
      fail("CAD_PARTITION_INPUT_INVALID", "Input is not a valid architectural-extraction-v0.1", {
        artifact: "architectural-extraction-v0.1",
        errors: extractionResult.errors,
      });
    }
    const extraction = extractionResult.value;
    if (semanticHash(extraction) !== source.architecturalExtractionHash) {
      mismatches.push("architecturalExtractionHash");
    }
    if (
      extraction.source.sourceHash !== cadDocument.sourceHash ||
      extraction.source.cadDocumentHash !== cadDocumentHash ||
      extraction.profileHash !== profileHash ||
      extraction.profileId !== profile.profileId
    ) {
      mismatches.push("architecturalExtraction.source");
    }
    candidates = extraction;
  } else {
    if (input.architecturalExtraction !== null) {
      fail(
        "CAD_PARTITION_INPUT_INVALID",
        "The space_wall_stage basis has no architectural extraction; supply null",
      );
    }
    // Rerun ONLY the shared 10B space/wall stage (full 10B interpretation is
    // expected to reject the shared door and is never required to succeed).
    try {
      candidates = deriveSpaceWallStage(cadDocument, profile);
    } catch (error) {
      if (!(error instanceof CadInterpretationError)) throw error;
      fail("CAD_PARTITION_INPUT_INVALID", "The bound CAD source fails the 10B space/wall stage", {
        interpretationErrorCode: error.code,
      });
    }
  }
  const spaceWallStageHash = semanticHash({
    level: candidates.level,
    spaces: candidates.spaces,
    walls: candidates.walls,
  });
  if (spaceWallStageHash !== source.spaceWallStageHash) mismatches.push("spaceWallStageHash");
  if (mismatches.length > 0) {
    fail(
      "CAD_PARTITION_INPUT_HASH_MISMATCH",
      `Topology is not bound to the supplied inputs (${mismatches.join(", ")})`,
      { mismatches },
    );
  }
  return candidates;
}

function assertApprovalBinding(topology: ArchitecturalTopology, approval: CadTopologyApproval) {
  const expected: CadTopologyApproval["topology"] = {
    architecturalTopologyVersion: topology.architecturalTopologyVersion,
    architecturalTopologyHash: semanticHash(topology),
    candidateBasis: topology.source.candidateBasis,
    sourceHash: topology.source.sourceHash,
    cadDocumentHash: topology.source.cadDocumentHash,
    profileHash: topology.source.profileHash,
    spaceWallStageHash: topology.source.spaceWallStageHash,
    architecturalExtractionHash: topology.source.architecturalExtractionHash,
  };
  const mismatches = (Object.keys(expected) as (keyof typeof expected)[]).filter(
    (key) => approval.topology[key] !== expected[key],
  );
  if (mismatches.length > 0) {
    fail(
      "CAD_PARTITION_APPROVAL_HASH_MISMATCH",
      `Approval ${approval.approvalId} does not bind this exact topology (${mismatches.join(", ")})`,
      { mismatches },
    );
  }
}

// ------------------------------------------------------------ 5 reviews

function assertReviewSet(kind: string, reviewed: readonly string[], expected: readonly string[]) {
  const seen = new Set<string>();
  for (const id of reviewed) {
    if (seen.has(id)) {
      fail("CAD_PARTITION_APPROVAL_REVIEW_DUPLICATE", `${kind} ${id} is reviewed more than once`, {
        id,
      });
    }
    seen.add(id);
  }
  for (let index = 1; index < reviewed.length; index += 1) {
    if (compareText(reviewed[index - 1] as string, reviewed[index] as string) > 0) {
      fail(
        "CAD_PARTITION_APPROVAL_REVIEW_UNSORTED",
        `${kind} reviews must be sorted by ID; reviewed intent is never reordered`,
        { ids: [...reviewed] },
      );
    }
  }
  const known = new Set(expected);
  const unknown = reviewed.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    fail(
      "CAD_PARTITION_APPROVAL_REVIEW_UNKNOWN",
      `Unknown ${kind} reviewed: ${unknown.join(", ")}`,
      {
        ids: unknown,
      },
    );
  }
  const missing = expected.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    fail("CAD_PARTITION_APPROVAL_REVIEW_MISSING", `Unreviewed ${kind}: ${missing.join(", ")}`, {
      ids: missing,
    });
  }
}

// --------------------------------------------------------- 6 partitions

function wallReference(wall: WallCandidate): WallCandidateReference {
  return {
    authority: "wall_candidate",
    wallCandidateId: wall.candidateId,
    spaceCandidateId: wall.spaceCandidateId,
  };
}

/** The profile provenance 10B recorded on the participating walls (deduplicated). */
function wallProfileProvenance(
  walls: readonly WallCandidate[],
  fields: readonly ("thicknessMm" | "baseElevationMm" | "heightMm")[],
): PartitionProfileProvenance[] {
  const entries = new Map<string, PartitionProfileProvenance>();
  for (const wall of walls) {
    for (const field of fields) {
      for (const entry of wall.provenance[field]) {
        if (entry.authority !== "profile") continue;
        const value = { authority: "profile" as const, field: entry.field, ruleId: entry.ruleId };
        entries.set(JSON.stringify(value), value);
      }
    }
  }
  return [...entries.values()];
}

interface WallShare {
  partitionCandidateId: string;
  fromMm: number;
  toMm: number;
}

function buildPartition(
  boundary: SharedBoundary,
  index: number,
  context: {
    wallsById: ReadonlyMap<string, WallCandidate>;
    approval: CadTopologyApproval;
    doors: readonly InteriorOpeningRelation[];
    shares: Map<string, WallShare[]>;
  },
): SharedPartition {
  const partitionCandidateId = `partition_candidate_${pad4(index)}`;
  const id = boundary.sharedBoundaryCandidateId;
  const walls = boundary.wallCandidateIds.map((wallId) => context.wallsById.get(wallId));
  const [wallA, wallB] = walls;
  if (!wallA || !wallB) {
    inconsistent(`Shared boundary ${id} references unknown wall candidates`, {
      sharedBoundaryCandidateId: id,
    });
  }
  const spaces = sortedPair(wallA.spaceCandidateId, wallB.spaceCandidateId);
  if (spaces[0] !== boundary.spaceCandidateIds[0] || spaces[1] !== boundary.spaceCandidateIds[1]) {
    inconsistent(`Shared boundary ${id} spaces disagree with its wall candidates`, {
      sharedBoundaryCandidateId: id,
    });
  }

  // Thickness and vertical extent come from the two 10B walls, which must agree.
  if (Math.abs(wallA.thicknessMm - wallB.thicknessMm) > EPSILON) {
    fail(
      "CAD_PARTITION_THICKNESS_CONFLICT",
      `Walls ${wallA.candidateId} (${wallA.thicknessMm} mm) and ${wallB.candidateId} (${wallB.thicknessMm} mm) disagree on thickness; values are never averaged or chosen`,
      {
        sharedBoundaryCandidateId: id,
        wallCandidateIds: [wallA.candidateId, wallB.candidateId],
        thicknessMm: [wallA.thicknessMm, wallB.thicknessMm],
      },
    );
  }
  if (
    wallA.levelCandidateId !== wallB.levelCandidateId ||
    Math.abs(wallA.baseElevationMm - wallB.baseElevationMm) > EPSILON ||
    Math.abs(wallA.heightMm - wallB.heightMm) > EPSILON
  ) {
    fail(
      "CAD_PARTITION_VERTICAL_CONFLICT",
      `Walls ${wallA.candidateId} and ${wallB.candidateId} disagree on level, base elevation, or height`,
      {
        sharedBoundaryCandidateId: id,
        wallCandidateIds: [wallA.candidateId, wallB.candidateId],
        levelCandidateIds: [wallA.levelCandidateId, wallB.levelCandidateId],
        baseElevationMm: [wallA.baseElevationMm, wallB.baseElevationMm],
        heightMm: [wallA.heightMm, wallB.heightMm],
      },
    );
  }

  // The topology interval must lie on both walls exactly as 10D recorded it.
  const start: Point2 = [boundary.worldStart[0], boundary.worldStart[1]];
  const end: Point2 = [boundary.worldEnd[0], boundary.worldEnd[1]];
  const lengthMm = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (Math.abs(lengthMm - boundary.lengthMm) > EPSILON) {
    inconsistent(`Shared boundary ${id} length disagrees with its endpoints`, {
      sharedBoundaryCandidateId: id,
    });
  }
  for (const wall of [wallA, wallB]) {
    const along = [start, end]
      .map((endpoint) => {
        if (distanceToLine(endpoint, wall.start, wall.end) > EPSILON) {
          inconsistent(`Shared boundary ${id} does not lie on wall ${wall.candidateId}`, {
            sharedBoundaryCandidateId: id,
          });
        }
        return alongSegment(endpoint, wall.start, wall.end);
      })
      .sort((low, high) => low - high) as [number, number];
    const recorded = boundary.wallIntervals.find(
      (interval) => interval.wallCandidateId === wall.candidateId,
    );
    if (
      along[0] < -EPSILON ||
      along[1] > wall.lengthMm + EPSILON ||
      !recorded ||
      Math.abs(recorded.fromMm - along[0]) > EPSILON ||
      Math.abs(recorded.toMm - along[1]) > EPSILON
    ) {
      inconsistent(`Shared boundary ${id} interval disagrees with wall ${wall.candidateId}`, {
        sharedBoundaryCandidateId: id,
      });
    }
    context.shares.set(wall.candidateId, [
      ...(context.shares.get(wall.candidateId) ?? []),
      { partitionCandidateId, fromMm: along[0], toMm: along[1] },
    ]);
  }

  // Space sides, resolved geometrically from each wall's CCW direction.
  const unitDirectionValue = unitDirection(start, end);
  const { left: leftNormal, right: rightNormal } = normals(unitDirectionValue);
  const sided = [wallA, wallB].map((wall) => ({
    wall,
    side: spaceSideOfWall(wall.start, wall.end, unitDirectionValue),
  }));
  const leftWall = sided.find((entry) => entry.side === "left")?.wall;
  const rightWall = sided.find((entry) => entry.side === "right")?.wall;
  if (!leftWall || !rightWall) {
    fail(
      "CAD_PARTITION_SPACE_SIDE_INVALID",
      `Spaces of shared boundary ${id} do not resolve to exactly one left and one right side`,
      {
        sharedBoundaryCandidateId: id,
        sides: sided.map((entry) => ({
          wallCandidateId: entry.wall.candidateId,
          spaceCandidateId: entry.wall.spaceCandidateId,
          side: entry.side,
        })),
      },
    );
  }

  // Dual interior faces at thickness / 2, in the canonical centerline direction.
  const thicknessMm = wallA.thicknessMm;
  const half = thicknessMm / 2;
  const face = (side: PartitionSide, wall: WallCandidate): PartitionSpaceFace => {
    const [faceStart, faceEnd] = offsetSegment(
      start,
      end,
      side === "left" ? leftNormal : rightNormal,
      half,
    );
    return {
      side,
      spaceCandidateId: wall.spaceCandidateId,
      sourceWallCandidateId: wall.candidateId,
      start: faceStart,
      end: faceEnd,
      offsetFromCenterlineMm: half,
    };
  };
  const leftFace = face("left", leftWall);
  const rightFace = face("right", rightWall);
  for (const [value, expected] of [
    [distanceToLine(leftFace.start, start, end), half],
    [distanceToLine(leftFace.end, start, end), half],
    [distanceToLine(rightFace.start, start, end), half],
    [distanceToLine(rightFace.end, start, end), half],
    [distanceToLine(rightFace.start, leftFace.start, leftFace.end), thicknessMm],
  ] as const) {
    if (Math.abs(value - expected) > EPSILON) {
      throw new Error("Partition face derivation invariant violated");
    }
  }

  const approvalReference = (field: string): ApprovalProvenance => ({
    authority: "approval",
    approvalId: context.approval.approvalId,
    field,
  });
  const boundaryReference: TopologyReference = {
    authority: "topology",
    relation: "shared_boundary",
    id,
  };
  const sideOf = (spaceCandidateId: string): PartitionSide =>
    spaceCandidateId === leftWall.spaceCandidateId ? "left" : "right";

  const openings = context.doors
    .filter((door) => door.sharedBoundaryCandidateId === id)
    .map((door) =>
      reviewedDoor(door, {
        partitionCandidateId,
        boundaryReference,
        start,
        end,
        lengthMm: boundary.lengthMm,
        adjacent: spaces,
        sideOf,
        approval: context.approval,
      }),
    );

  return {
    partitionCandidateId,
    sharedBoundaryCandidateId: id,
    adjacentSpaceCandidateIds: spaces,
    sourceWallCandidateIds: sortedPair(wallA.candidateId, wallB.candidateId),
    referencePolicy: "partition_centerline",
    levelCandidateId: wallA.levelCandidateId,
    centerLineStart: start,
    centerLineEnd: end,
    lengthMm: boundary.lengthMm,
    unitDirection: unitDirectionValue,
    leftNormal,
    rightNormal,
    baseElevationMm: wallA.baseElevationMm,
    heightMm: wallA.heightMm,
    thicknessMm,
    spaceFaces: [leftFace, rightFace],
    openings,
    provenance: {
      centerLine: [boundaryReference, approvalReference("sharedBoundaryReviews.referencePolicy")],
      referencePolicy: [approvalReference("sharedBoundaryReviews.referencePolicy")],
      thicknessMm: [
        wallReference(wallA),
        wallReference(wallB),
        ...wallProfileProvenance([wallA, wallB], ["thicknessMm"]),
      ],
      vertical: [
        wallReference(wallA),
        wallReference(wallB),
        ...wallProfileProvenance([wallA, wallB], ["baseElevationMm", "heightMm"]),
      ],
      spaceSides: [
        wallReference(wallA),
        wallReference(wallB),
        derived("partition_space_side_v0.1"),
      ],
      spaceFaces: [derived("partition_face_offset_v0.1")],
    },
  };
}

function reviewedDoor(
  door: InteriorOpeningRelation,
  context: {
    partitionCandidateId: string;
    boundaryReference: TopologyReference;
    start: Point2;
    end: Point2;
    lengthMm: number;
    adjacent: [string, string];
    sideOf: (spaceCandidateId: string) => PartitionSide;
    approval: CadTopologyApproval;
  },
): ReviewedInteriorDoor {
  const id = door.topologyOpeningId;
  const review = context.approval.interiorDoorReviews.find(
    (entry) => entry.topologyOpeningId === id,
  );
  if (!review) {
    fail("CAD_PARTITION_APPROVAL_REVIEW_MISSING", `Unreviewed interior door ${id}`, { ids: [id] });
  }
  if (
    door.connectsSpaces[0] !== context.adjacent[0] ||
    door.connectsSpaces[1] !== context.adjacent[1]
  ) {
    inconsistent(`Door ${id} does not connect the partition's two spaces`, {
      topologyOpeningId: id,
    });
  }
  // Copied from 10D; only revalidated here, never recalculated or repaired.
  const offset = door.offsetFromWorldStartMm;
  const width = door.resolvedWidthMm;
  if (
    offset < -EPSILON ||
    offset + width > context.lengthMm + EPSILON ||
    Math.abs(offset - (door.centerDistanceFromWorldStartMm - width / 2)) > EPSILON
  ) {
    fail(
      "CAD_PARTITION_OPENING_OUTSIDE_PARTITION",
      `Door ${id} (offset ${offset}, width ${width}) does not fit partition ${context.partitionCandidateId} (${context.lengthMm} mm)`,
      { topologyOpeningId: id, partitionCandidateId: context.partitionCandidateId },
    );
  }
  if (
    Math.abs(
      alongSegment(door.centerXY, context.start, context.end) - door.centerDistanceFromWorldStartMm,
    ) > EPSILON
  ) {
    inconsistent(`Door ${id} center disagrees with its recorded interval position`, {
      topologyOpeningId: id,
    });
  }
  const approvalReference = (field: string): ApprovalProvenance => ({
    authority: "approval",
    approvalId: context.approval.approvalId,
    field,
  });
  const openingReference: TopologyReference = { authority: "topology", relation: "opening", id };
  const rule = door.doorRule;
  const ruleField = (field: string): PartitionProfileProvenance => ({
    authority: "profile",
    field: `doorRules.${field}`,
    ruleId: rule.ruleId,
  });
  return {
    topologyOpeningId: id,
    type: "door",
    openingSourceOrdinal: door.openingSourceOrdinal,
    openingSourceHandle: door.openingSourceHandle,
    blockName: door.blockName,
    connectsSpaces: [door.connectsSpaces[0], door.connectsSpaces[1]],
    centerXY: [door.centerXY[0], door.centerXY[1]],
    centerDistanceFromWorldStartMm: door.centerDistanceFromWorldStartMm,
    offsetFromWorldStartMm: offset,
    widthMm: width,
    heightMm: door.resolvedHeightMm,
    sillMm: door.resolvedSillMm,
    hingeEndpoint: review.hingeEndpoint,
    hingeJambCenterlinePoint: pointAlong(
      context.start,
      context.end,
      review.hingeEndpoint === "world_start" ? offset : offset + width,
    ),
    swingIntoSpaceCandidateId: review.swingIntoSpaceCandidateId,
    swingIntoSide: context.sideOf(review.swingIntoSpaceCandidateId),
    profileDoorRule: {
      ruleId: rule.ruleId,
      hingeSide: rule.hingeSide,
      swingDirection: rule.swingDirection,
    },
    provenance: {
      topologyRelation: [openingReference],
      source: [
        {
          authority: "cad",
          sourceOrdinal: door.openingSourceOrdinal,
          sourceHandle: door.openingSourceHandle,
          role: "door_insert",
        },
      ],
      dimensions: [
        openingReference,
        ruleField("widthMm"),
        ruleField("heightMm"),
        ruleField("sillMm"),
      ],
      host: [
        context.boundaryReference,
        { authority: "partition", partitionCandidateId: context.partitionCandidateId },
        derived("partition_opening_host_v0.1"),
      ],
      hingeEndpoint: [
        approvalReference("interiorDoorReviews.hingeEndpoint"),
        derived("partition_hinge_jamb_v0.1"),
      ],
      swingIntoSpaceCandidateId: [
        approvalReference("interiorDoorReviews.swingIntoSpaceCandidateId"),
        derived("partition_space_side_v0.1"),
      ],
      profileDoorRule: [ruleField("hingeSide"), ruleField("swingDirection")],
    },
  };
}

// ------------------------------------------------------ 7 segmentation

function segmentWall(wall: WallCandidate, shares: readonly WallShare[]): WallSegmentation {
  const length = wall.lengthMm;
  const intervals: WallSegmentInterval[] = [];
  const unpaired = (fromMm: number, toMm: number) =>
    intervals.push({ fromMm, toMm, role: "unpaired", partitionCandidateId: null });
  let cursor = 0;
  for (const share of [...shares].sort((left, right) => left.fromMm - right.fromMm)) {
    if (share.fromMm < cursor - EPSILON) {
      inconsistent(`Shared intervals overlap on wall ${wall.candidateId}`, {
        wallCandidateId: wall.candidateId,
      });
    }
    if (share.fromMm - cursor > EPSILON) unpaired(cursor, share.fromMm);
    const fromMm = share.fromMm - cursor > EPSILON ? share.fromMm : cursor;
    intervals.push({
      fromMm,
      toMm: share.toMm,
      role: "shared_partition",
      partitionCandidateId: share.partitionCandidateId,
    });
    cursor = share.toMm;
  }
  if (length - cursor > EPSILON) unpaired(cursor, length);
  else if (intervals.length > 0)
    (intervals[intervals.length - 1] as WallSegmentInterval).toMm = length;

  // Exact coverage: [0, length] once, contiguous, no gaps, no overlap.
  const covered = intervals.reduce((total, interval) => total + interval.toMm - interval.fromMm, 0);
  const contiguous = intervals.every(
    (interval, index) =>
      interval.toMm - interval.fromMm > 0 &&
      (index === 0 ? interval.fromMm === 0 : interval.fromMm === intervals[index - 1]?.toMm),
  );
  if (
    !contiguous ||
    intervals[intervals.length - 1]?.toMm !== length ||
    Math.abs(covered - length) > EPSILON
  ) {
    fail(
      "CAD_PARTITION_SEGMENTATION_INVALID",
      `Wall ${wall.candidateId} segmentation does not cover it exactly once`,
      { wallCandidateId: wall.candidateId },
    );
  }
  return {
    wallCandidateId: wall.candidateId,
    spaceCandidateId: wall.spaceCandidateId,
    lengthMm: length,
    intervals,
  };
}

// ----------------------------------------------------------------- create

export function createReviewedPartitionModel(
  input: ReviewedPartitionModelInput,
): ReviewedPartitionModel {
  const bundle = validateBundle(input);
  const { topology, approval } = bundle;
  if (approval.decision !== "approved_as_shared_partition_model") {
    fail(
      "CAD_PARTITION_APPROVAL_NOT_APPROVED",
      `Approval decision ${approval.decision} does not approve a shared partition model`,
      { decision: approval.decision },
    );
  }
  const candidates = recomputeCandidates(input, bundle);
  assertApprovalBinding(topology, approval);

  const doors = topology.openingRelations.filter(
    (relation): relation is InteriorOpeningRelation =>
      relation.relationKind === "interior_shared_boundary",
  );
  assertReviewSet(
    "shared boundary",
    approval.sharedBoundaryReviews.map((review) => review.sharedBoundaryCandidateId),
    topology.sharedBoundaries.map((boundary) => boundary.sharedBoundaryCandidateId),
  );
  assertReviewSet(
    "interior door",
    approval.interiorDoorReviews.map((review) => review.topologyOpeningId),
    doors.map((door) => door.topologyOpeningId),
  );
  for (const review of approval.interiorDoorReviews) {
    const door = doors.find((entry) => entry.topologyOpeningId === review.topologyOpeningId);
    if (door && !door.connectsSpaces.includes(review.swingIntoSpaceCandidateId)) {
      fail(
        "CAD_PARTITION_DOOR_SWING_SPACE_INVALID",
        `Door ${review.topologyOpeningId} cannot swing into ${review.swingIntoSpaceCandidateId}; it connects ${door.connectsSpaces.join(" and ")}`,
        { topologyOpeningId: review.topologyOpeningId, connectsSpaces: door.connectsSpaces },
      );
    }
  }

  // The topology must describe exactly the bound candidates.
  const candidateSpaceIds = candidates.spaces.map((space) => space.candidateId).sort(compareText);
  if (
    topology.levelCandidateId !== candidates.level.levelCandidateId ||
    JSON.stringify(topology.spaces.map((space) => space.spaceCandidateId)) !==
      JSON.stringify(candidateSpaceIds)
  ) {
    inconsistent("Topology spaces or level disagree with the bound candidates");
  }

  const wallsById = new Map(candidates.walls.map((wall) => [wall.candidateId, wall]));
  const shares = new Map<string, WallShare[]>();
  const sharedPartitions = topology.sharedBoundaries.map((boundary, index) =>
    buildPartition(boundary, index, { wallsById, approval, doors, shares }),
  );

  const hosted = sharedPartitions.reduce(
    (total, partition) => total + partition.openings.length,
    0,
  );
  if (hosted !== doors.length) {
    inconsistent("An interior door references a shared boundary that is not in the topology");
  }

  const wallSegments = [...candidates.walls]
    .sort((left, right) => compareText(left.candidateId, right.candidateId))
    .map((wall) => segmentWall(wall, shares.get(wall.candidateId) ?? []));

  const unsharedOpeningReferences: UnsharedOpeningReference[] = topology.openingRelations
    .filter(
      (relation): relation is SingleSpaceOpeningRelation =>
        relation.relationKind === "single_space",
    )
    .map((relation) => ({
      topologyOpeningId: relation.topologyOpeningId,
      openingCandidateId: relation.openingCandidate.candidateId,
      type: relation.type,
      openingSourceOrdinal: relation.openingSourceOrdinal,
      spaceCandidateId: relation.connectsSpaces[0],
      hostWallCandidateId: relation.hostWallCandidateId,
    }));

  const spaces: PartitionModelSpace[] = [...candidates.spaces]
    .sort((left, right) => compareText(left.candidateId, right.candidateId))
    .map((space) => {
      const touching = sharedPartitions.filter((partition) =>
        partition.adjacentSpaceCandidateIds.includes(space.candidateId),
      );
      return {
        spaceCandidateId: space.candidateId,
        spaceType: space.spaceType,
        partitionCandidateIds: touching.map((partition) => partition.partitionCandidateId),
        adjacentSpaceCandidateIds: [
          ...new Set(
            touching.flatMap((partition) =>
              partition.adjacentSpaceCandidateIds.filter((other) => other !== space.candidateId),
            ),
          ),
        ].sort(compareText),
      };
    });

  const intervals = wallSegments.flatMap((segment) => segment.intervals);
  return {
    reviewedPartitionModelVersion: REVIEWED_PARTITION_MODEL_VERSION,
    partitionPolicyVersion: CAD_SHARED_PARTITION_POLICY_VERSION,
    identityScope: "model_local_non_canonical",
    approvalId: approval.approvalId,
    approvalHash: semanticHash(approval),
    source: {
      architecturalTopologyVersion: topology.architecturalTopologyVersion,
      architecturalTopologyHash: semanticHash(topology),
      topologyPolicyVersion: topology.topologyPolicyVersion,
      candidateBasis: topology.source.candidateBasis,
      sourceHash: topology.source.sourceHash,
      cadDocumentHash: topology.source.cadDocumentHash,
      profileId: topology.source.profileId,
      profileHash: topology.source.profileHash,
      interpretationPolicyVersion: topology.source.interpretationPolicyVersion,
      architecturalExtractionHash: topology.source.architecturalExtractionHash,
      spaceWallStageHash: topology.source.spaceWallStageHash,
    },
    canonicalUnits: "millimeters",
    levelCandidateId: candidates.level.levelCandidateId,
    spaces,
    sharedPartitions,
    wallSegments,
    unsharedOpeningReferences,
    summary: {
      spaceCount: spaces.length,
      sharedPartitionCount: sharedPartitions.length,
      reviewedInteriorDoorCount: sharedPartitions.reduce(
        (total, partition) => total + partition.openings.length,
        0,
      ),
      unsharedOpeningCount: unsharedOpeningReferences.length,
      wallCandidateCount: wallSegments.length,
      sharedWallIntervalCount: intervals.filter((interval) => interval.role === "shared_partition")
        .length,
      unpairedWallIntervalCount: intervals.filter((interval) => interval.role === "unpaired")
        .length,
    },
    status: "APPROVED_FOR_SCENE_CANONICALIZATION",
  };
}
