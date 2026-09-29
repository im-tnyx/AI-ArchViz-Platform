import {
  type ArchitecturalExtraction,
  buildOpeningCandidate,
  CAD_INTERPRET_HOST_TOLERANCE_MM,
  CadInterpretationError,
  type CadInterpretationProfile,
  type CadSpaceWallStage,
  type DoorRule,
  deriveSpaceWallStage,
  findOpeningHosts,
  type LevelCandidate,
  type OpeningCandidate,
  type OpeningHost,
  openingCenter,
  projectOntoSegment,
  resolveOpeningRule,
  type SpaceCandidate,
  semanticHash,
  validateArchitecturalExtraction,
  validateCadInterpretationProfile,
  type WallCandidate,
} from "@ai-archviz/cad-interpreter";
import { type CadDocument, validateCadDocument } from "@ai-archviz/cad-parser";
import { alongSegment, collinearOverlap, comparePoints, intervalOverlapMm } from "./geometry.js";
import {
  ARCHITECTURAL_TOPOLOGY_VERSION,
  type ArchitecturalTopology,
  type ArchitecturalTopologyInput,
  type ArchitecturalTopologySource,
  CAD_TOPOLOGY_POLICY_VERSION,
  CadTopologyError,
  type CadTopologyErrorCode,
  type CandidateBasis,
  CAD_TOPOLOGY_EPSILON_MM as EPSILON,
  type InteriorOpeningRelation,
  type OpeningRelation,
  type Point2,
  type SharedBoundary,
  type SharedBoundaryWallInterval,
  type SingleSpaceOpeningRelation,
  type SpaceAdjacency,
  type TopologyCadProvenance,
  type TopologyDerivedProvenance,
  type TopologyProfileProvenance,
  type TopologyWallInput,
  type WallCandidateProvenance,
  type WallClassification,
} from "./types.js";

/*
 * cad-topology-policy-v0.1. Pass order (and therefore error precedence) is
 * fixed:
 *   1. validate the input bundle: cad-document-v0.1, the interpretation
 *      profile, and either a READY_FOR_REVIEW architectural-extraction-v0.1
 *      whose hash chain matches both, or null (space_wall_stage basis)
 *   2. candidate basis: the extraction's own level/spaces/walls, or the
 *      shared 10B space/wall stage (never a second derivation)
 *   3. shared boundaries: positive-length collinear overlaps between walls
 *      of different spaces; interval conflicts, then direction
 *   4. space adjacencies and wall classifications
 *   5. opening relations (single-space or one interior shared-boundary door)
 * Geometry comes only from 10B wall candidates; meaning only from the
 * profile's exact rules. Nothing is guessed, and nothing becomes SceneSpec.
 */

function fail(
  code: CadTopologyErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new CadTopologyError(code, message, details);
}

const pad4 = (value: number) => String(value).padStart(4, "0");
const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const point = (value: readonly number[]): Point2 => [value[0] as number, value[1] as number];

function derived(derivation: string): TopologyDerivedProvenance {
  return { authority: "derived", derivation };
}

function fromProfile(field: string, ruleId: string | null = null): TopologyProfileProvenance {
  return { authority: "profile", field, ruleId };
}

/** Runs a shared 10B step; its rejection is reported, never reinterpreted. */
function interpretationStep<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (!(error instanceof CadInterpretationError)) throw error;
    fail(
      "CAD_TOPOLOGY_INTERPRETATION_REJECTED",
      `cad-interpretation-policy-v0.1 rejects the source: ${error.message}`,
      { interpretationErrorCode: error.code, ...error.details },
    );
  }
}

// ------------------------------------------------------- shared boundaries

export interface DetectedSharedBoundary {
  /** Sorted lexically. */
  wallCandidateIds: [string, string];
  /** Sorted lexically. */
  spaceCandidateIds: [string, string];
  worldStart: Point2;
  worldEnd: Point2;
  lengthMm: number;
  /** One entry per participating wall, in wallCandidateIds order. */
  wallIntervals: SharedBoundaryWallInterval[];
}

/**
 * Shared-boundary detection over 10B wall candidates. Two walls of
 * different spaces share a boundary only over a positive-length collinear
 * overlap. A wall may share several disjoint intervals (with one or more
 * neighbors); any positive overlap between two of its intervals is a
 * conflict. Coincident edges must run in opposite directions (normalized
 * CCW rooms on either side); same-direction edges are malformed topology.
 * Output is ordered by the sorted wall-candidate pair, then worldStart.
 */
export function detectSharedBoundaries(
  walls: readonly TopologyWallInput[],
): DetectedSharedBoundary[] {
  const ordered = [...walls].sort((left, right) =>
    compareText(left.candidateId, right.candidateId),
  );
  const detected: (DetectedSharedBoundary & { direction: "opposite" | "same" })[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const first = ordered[i] as TopologyWallInput;
      const second = ordered[j] as TopologyWallInput;
      if (first.spaceCandidateId === second.spaceCandidateId) continue;
      const overlap = collinearOverlap(
        point(first.start),
        point(first.end),
        point(second.start),
        point(second.end),
      );
      if (!overlap) continue;
      const wallIntervals = [first, second].map((wall): SharedBoundaryWallInterval => {
        const along = [overlap.worldStart, overlap.worldEnd]
          .map((end) => alongSegment(end, point(wall.start), point(wall.end)))
          .sort((low, high) => low - high);
        return {
          wallCandidateId: wall.candidateId,
          spaceCandidateId: wall.spaceCandidateId,
          fromMm: along[0] as number,
          toMm: along[1] as number,
        };
      });
      detected.push({
        wallCandidateIds: [first.candidateId, second.candidateId],
        spaceCandidateIds: [first.spaceCandidateId, second.spaceCandidateId].sort(compareText) as [
          string,
          string,
        ],
        worldStart: overlap.worldStart,
        worldEnd: overlap.worldEnd,
        lengthMm: overlap.lengthMm,
        wallIntervals,
        direction: overlap.direction,
      });
    }
  }

  for (const wall of ordered) {
    const intervals = detected.flatMap((boundary) =>
      boundary.wallIntervals
        .filter((interval) => interval.wallCandidateId === wall.candidateId)
        .map((interval) => ({
          interval,
          otherWallCandidateId: boundary.wallCandidateIds.find(
            (id) => id !== wall.candidateId,
          ) as string,
          otherSpaceCandidateId: boundary.wallIntervals.find(
            (other) => other.wallCandidateId !== wall.candidateId,
          )?.spaceCandidateId as string,
        })),
    );
    for (let p = 0; p < intervals.length; p += 1) {
      for (let q = p + 1; q < intervals.length; q += 1) {
        const left = intervals[p] as (typeof intervals)[number];
        const right = intervals[q] as (typeof intervals)[number];
        const overlapMm = intervalOverlapMm(left.interval, right.interval);
        if (overlapMm > EPSILON) {
          fail(
            "CAD_TOPOLOGY_SHARED_INTERVAL_CONFLICT",
            `Wall ${wall.candidateId} shares overlapping intervals with ${left.otherWallCandidateId} and ${right.otherWallCandidateId}`,
            {
              wallCandidateId: wall.candidateId,
              conflictingWallCandidateIds: [
                left.otherWallCandidateId,
                right.otherWallCandidateId,
              ].sort(compareText),
              neighborSpaceCandidateIds: [
                left.otherSpaceCandidateId,
                right.otherSpaceCandidateId,
              ].sort(compareText),
              overlapMm,
            },
          );
        }
      }
    }
  }

  for (const boundary of detected) {
    if (boundary.direction === "same") {
      fail(
        "CAD_TOPOLOGY_SHARED_EDGE_DIRECTION_INVALID",
        `Coincident walls ${boundary.wallCandidateIds.join(" and ")} run in the same direction; normalized adjacent spaces must traverse a shared edge oppositely`,
        {
          wallCandidateIds: boundary.wallCandidateIds,
          spaceCandidateIds: boundary.spaceCandidateIds,
        },
      );
    }
  }

  return detected
    .map(({ direction: _direction, ...boundary }) => boundary)
    .sort(
      (left, right) =>
        compareText(left.wallCandidateIds[0], right.wallCandidateIds[0]) ||
        compareText(left.wallCandidateIds[1], right.wallCandidateIds[1]) ||
        comparePoints(left.worldStart, right.worldStart),
    );
}

/** An opening center lies on a shared interval under the 10B host rule. */
function isOnSharedBoundary(center: Point2, boundary: SharedBoundary): boolean {
  const projection = projectOntoSegment(center, boundary.worldStart, boundary.worldEnd);
  return (
    projection.perpendicularMm <= CAD_INTERPRET_HOST_TOLERANCE_MM &&
    projection.alongMm >= -EPSILON &&
    projection.alongMm <= projection.lengthMm + EPSILON
  );
}

// -------------------------------------------------------- candidate basis

interface CandidateSet {
  candidateBasis: CandidateBasis;
  architecturalExtractionHash: string | null;
  level: LevelCandidate;
  spaces: readonly SpaceCandidate[];
  walls: readonly WallCandidate[];
  extraction: ArchitecturalExtraction | null;
  stage: CadSpaceWallStage | null;
}

function extractionBasis(
  value: unknown,
  cadDocument: CadDocument,
  profile: CadInterpretationProfile,
): CandidateSet {
  const result = validateArchitecturalExtraction(value);
  if (!result.ok) {
    fail("CAD_TOPOLOGY_INPUT_INVALID", "Input is not a valid architectural-extraction-v0.1", {
      artifact: "architectural-extraction-v0.1",
      errors: result.errors,
    });
  }
  const extraction = result.value;
  if (extraction.status !== "READY_FOR_REVIEW") {
    fail("CAD_TOPOLOGY_INPUT_INVALID", "Architectural extraction is not READY_FOR_REVIEW");
  }
  const mismatches = [
    ...(extraction.source.sourceHash === cadDocument.sourceHash ? [] : ["sourceHash"]),
    ...(extraction.source.cadDocumentHash === semanticHash(cadDocument) ? [] : ["cadDocumentHash"]),
    ...(extraction.profileHash === semanticHash(profile) ? [] : ["profileHash"]),
    ...(extraction.profileId === profile.profileId ? [] : ["profileId"]),
  ];
  if (mismatches.length > 0) {
    fail(
      "CAD_TOPOLOGY_INPUT_HASH_MISMATCH",
      `Architectural extraction is not bound to the supplied inputs (${mismatches.join(", ")})`,
      { mismatches },
    );
  }
  return {
    candidateBasis: "architectural_extraction",
    architecturalExtractionHash: semanticHash(extraction),
    level: extraction.level,
    spaces: extraction.spaces,
    walls: extraction.walls,
    extraction,
    stage: null,
  };
}

function stageBasis(cadDocument: CadDocument, profile: CadInterpretationProfile): CandidateSet {
  const stage = interpretationStep(() => deriveSpaceWallStage(cadDocument, profile));
  return {
    candidateBasis: "space_wall_stage",
    architecturalExtractionHash: null,
    level: stage.level,
    spaces: stage.spaces,
    walls: stage.walls,
    extraction: null,
    stage,
  };
}

function assertCandidateConsistency(candidates: CandidateSet): void {
  const invalid = (message: string, details: Record<string, unknown>): never =>
    fail("CAD_TOPOLOGY_INPUT_INVALID", message, details);
  const spaceIds = new Set<string>();
  for (const space of candidates.spaces) {
    if (spaceIds.has(space.candidateId)) {
      invalid(`Duplicate space candidate ${space.candidateId}`, {
        spaceCandidateId: space.candidateId,
      });
    }
    spaceIds.add(space.candidateId);
  }
  const wallIds = new Set<string>();
  for (const wall of candidates.walls) {
    if (wallIds.has(wall.candidateId)) {
      invalid(`Duplicate wall candidate ${wall.candidateId}`, {
        wallCandidateId: wall.candidateId,
      });
    }
    wallIds.add(wall.candidateId);
    if (!spaceIds.has(wall.spaceCandidateId)) {
      invalid(`Wall ${wall.candidateId} references unknown space ${wall.spaceCandidateId}`, {
        wallCandidateId: wall.candidateId,
      });
    }
    if (wall.levelCandidateId !== candidates.level.levelCandidateId) {
      invalid(`Wall ${wall.candidateId} is not on level ${candidates.level.levelCandidateId}`, {
        wallCandidateId: wall.candidateId,
      });
    }
  }
}

// --------------------------------------------------------------- openings

interface OpeningContext {
  sharedBoundaries: readonly SharedBoundary[];
  basisHash: string;
}

function sharedBoundariesAt(
  center: Point2,
  context: OpeningContext,
  details: Record<string, unknown>,
): SharedBoundary | null {
  const hits = context.sharedBoundaries.filter((boundary) => isOnSharedBoundary(center, boundary));
  if (hits.length > 1) {
    fail(
      "CAD_TOPOLOGY_OPENING_AMBIGUOUS",
      `Opening (source ordinal ${String(details.sourceOrdinal)}) lies on ${hits.length} shared boundaries`,
      {
        ...details,
        reason: "MULTIPLE_SHARED_BOUNDARIES",
        sharedBoundaryCandidateIds: hits.map((hit) => hit.sharedBoundaryCandidateId),
      },
    );
  }
  return hits[0] ?? null;
}

function rejectSharedWindow(boundary: SharedBoundary, details: Record<string, unknown>): never {
  fail(
    "CAD_TOPOLOGY_WINDOW_ON_SHARED_BOUNDARY_UNSUPPORTED",
    `Window (source ordinal ${String(details.sourceOrdinal)}) lies on room-to-room boundary ${boundary.sharedBoundaryCandidateId}; interior glazing is unsupported in v0.1`,
    { ...details, sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId },
  );
}

function interiorDoor(
  cadSource: TopologyCadProvenance,
  blockName: string,
  center: Point2,
  rule: DoorRule,
  boundary: SharedBoundary,
  details: Record<string, unknown>,
): Omit<InteriorOpeningRelation, "topologyOpeningId"> {
  const projection = projectOntoSegment(center, boundary.worldStart, boundary.worldEnd);
  const rawOffset = projection.alongMm - rule.widthMm / 2;
  if (rawOffset < -EPSILON || rawOffset + rule.widthMm > boundary.lengthMm + EPSILON) {
    fail(
      "CAD_TOPOLOGY_OPENING_OUTSIDE_SHARED_BOUNDARY",
      `Door (source ordinal ${cadSource.sourceOrdinal}) of width ${rule.widthMm} does not fit shared boundary ${boundary.sharedBoundaryCandidateId} (${boundary.lengthMm} mm)`,
      {
        ...details,
        sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId,
        centerDistanceFromWorldStartMm: projection.alongMm,
        widthMm: rule.widthMm,
        sharedLengthMm: boundary.lengthMm,
      },
    );
  }
  const sharedSource = {
    authority: "shared_boundary" as const,
    sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId,
  };
  return {
    relationKind: "interior_shared_boundary",
    type: "door",
    openingSourceOrdinal: cadSource.sourceOrdinal,
    openingSourceHandle: cadSource.sourceHandle,
    blockName,
    connectsSpaces: [boundary.spaceCandidateIds[0], boundary.spaceCandidateIds[1]],
    sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId,
    centerXY: center,
    hostDistanceMm: projection.perpendicularMm,
    centerDistanceFromWorldStartMm: projection.alongMm,
    // Epsilon snap into [0, length - width]; values already inside are exact.
    offsetFromWorldStartMm: Math.min(Math.max(rawOffset, 0), boundary.lengthMm - rule.widthMm),
    resolvedWidthMm: rule.widthMm,
    resolvedHeightMm: rule.heightMm,
    resolvedSillMm: rule.sillMm,
    doorRule: {
      ruleId: rule.ruleId,
      hingeSide: rule.hingeSide,
      swingDirection: rule.swingDirection,
    },
    provenance: {
      center: [cadSource],
      host: [cadSource, sharedSource, derived("shared_opening_resolution_v0.1")],
      offsetFromWorldStartMm: [
        cadSource,
        sharedSource,
        fromProfile("doorRules.widthMm", rule.ruleId),
        derived("shared_opening_offset_v0.1"),
      ],
      resolvedWidthMm: [fromProfile("doorRules.widthMm", rule.ruleId)],
      resolvedHeightMm: [fromProfile("doorRules.heightMm", rule.ruleId)],
      resolvedSillMm: [fromProfile("doorRules.sillMm", rule.ruleId)],
      doorRule: [
        fromProfile("doorRules.hingeSide", rule.ruleId),
        fromProfile("doorRules.swingDirection", rule.ruleId),
      ],
    },
  };
}

function singleSpace(
  cadSource: TopologyCadProvenance,
  openingCandidate: OpeningCandidate,
  relationSource: SingleSpaceOpeningRelation["provenance"]["relation"][number],
): Omit<SingleSpaceOpeningRelation, "topologyOpeningId"> {
  return {
    relationKind: "single_space",
    type: openingCandidate.type,
    openingSourceOrdinal: cadSource.sourceOrdinal,
    openingSourceHandle: cadSource.sourceHandle,
    blockName: openingCandidate.blockName,
    connectsSpaces: [openingCandidate.spaceCandidateId],
    hostWallCandidateId: openingCandidate.hostWallCandidateId,
    openingCandidate: structuredClone(openingCandidate),
    provenance: { relation: [relationSource, derived("single_space_opening_v0.1")] },
  };
}

type OpeningDraft = Omit<OpeningRelation, "topologyOpeningId">;

/** Stage basis: resolve every mapped INSERT with the shared 10B rule/host helpers. */
function stageOpenings(stage: CadSpaceWallStage, context: OpeningContext): OpeningDraft[] {
  return stage.openingSources.map((source): OpeningDraft => {
    const { entity, role } = source;
    const details = {
      sourceOrdinal: entity.sourceOrdinal,
      sourceHandle: entity.sourceHandle,
      blockName: entity.blockName,
      role,
    };
    const rule = interpretationStep(() => resolveOpeningRule(stage, source));
    const center = openingCenter(source);
    const cadSource: TopologyCadProvenance = {
      authority: "cad",
      sourceOrdinal: entity.sourceOrdinal,
      sourceHandle: entity.sourceHandle,
      role: role === "door" ? "door_insert" : "window_insert",
    };
    const boundary = sharedBoundariesAt(center, context, details);
    const hosts = findOpeningHosts(center, stage.walls);
    if (boundary) {
      if (role === "window") rejectSharedWindow(boundary, details);
      const extra = hosts.filter(
        (host) => !boundary.wallCandidateIds.includes(host.wall.candidateId),
      );
      if (extra.length > 0) {
        fail(
          "CAD_TOPOLOGY_OPENING_AMBIGUOUS",
          `Door (source ordinal ${entity.sourceOrdinal}) on ${boundary.sharedBoundaryCandidateId} also touches ${extra.map((host) => host.wall.candidateId).join(", ")}`,
          {
            ...details,
            reason: "ADDITIONAL_WALL_HOST",
            sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId,
            hostWallCandidateIds: hosts.map((host) => host.wall.candidateId),
          },
        );
      }
      return interiorDoor(cadSource, entity.blockName, center, rule as DoorRule, boundary, details);
    }
    if (hosts.length === 0) {
      fail(
        "CAD_TOPOLOGY_INTERPRETATION_REJECTED",
        `Opening (source ordinal ${entity.sourceOrdinal}) is within ${CAD_INTERPRET_HOST_TOLERANCE_MM} mm of no wall segment`,
        { ...details, interpretationErrorCode: "CAD_INTERPRET_OPENING_HOST_UNRESOLVED" },
      );
    }
    if (hosts.length > 1) {
      fail(
        "CAD_TOPOLOGY_OPENING_AMBIGUOUS",
        `Opening (source ordinal ${entity.sourceOrdinal}) matches ${hosts.length} wall segments and no single shared boundary`,
        {
          ...details,
          reason: "MULTIPLE_WALL_HOSTS",
          hostWallCandidateIds: hosts.map((host) => host.wall.candidateId),
        },
      );
    }
    const candidate = interpretationStep(() =>
      buildOpeningCandidate(source, rule, hosts[0] as OpeningHost),
    );
    return singleSpace(cadSource, candidate, cadSource);
  });
}

/** Extraction basis: every 10B opening is uniquely hosted; reference it as-is. */
function extractionOpenings(
  extraction: ArchitecturalExtraction,
  context: OpeningContext,
): OpeningDraft[] {
  const wallsById = new Map(extraction.walls.map((wall) => [wall.candidateId, wall]));
  return extraction.openings.map((opening): OpeningDraft => {
    const cadSource = opening.provenance.center.find((entry) => entry.authority === "cad");
    const host = wallsById.get(opening.hostWallCandidateId);
    if (
      !cadSource ||
      (cadSource.role !== "door_insert" && cadSource.role !== "window_insert") ||
      !host ||
      host.spaceCandidateId !== opening.spaceCandidateId
    ) {
      fail(
        "CAD_TOPOLOGY_INPUT_INVALID",
        `Opening candidate ${opening.candidateId} has no consistent CAD source and host wall`,
        { openingCandidateId: opening.candidateId },
      );
    }
    const source: TopologyCadProvenance = {
      authority: "cad",
      sourceOrdinal: cadSource.sourceOrdinal,
      sourceHandle: cadSource.sourceHandle,
      role: cadSource.role,
    };
    const details = {
      sourceOrdinal: source.sourceOrdinal,
      sourceHandle: source.sourceHandle,
      blockName: opening.blockName,
      role: opening.type,
      openingCandidateId: opening.candidateId,
    };
    const boundary = sharedBoundariesAt(point(opening.sourceCenter), context, details);
    if (boundary) {
      if (opening.type === "window") rejectSharedWindow(boundary, details);
      fail(
        "CAD_TOPOLOGY_OPENING_AMBIGUOUS",
        `Door candidate ${opening.candidateId} claims one host but lies on shared boundary ${boundary.sharedBoundaryCandidateId}`,
        {
          ...details,
          reason: "SINGLE_HOST_ON_SHARED_BOUNDARY",
          sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId,
        },
      );
    }
    return singleSpace(source, opening, {
      authority: "opening_candidate",
      openingCandidateId: opening.candidateId,
      basisHash: context.basisHash,
    });
  });
}

// ---------------------------------------------------------------- analyze

export function analyzeArchitecturalTopology(
  input: ArchitecturalTopologyInput,
): ArchitecturalTopology {
  // 1. The bundle and every artifact in it must satisfy its contract.
  if (
    typeof input !== "object" ||
    input === null ||
    !("cadDocument" in input) ||
    !("interpretationProfile" in input) ||
    !("architecturalExtraction" in input)
  ) {
    fail(
      "CAD_TOPOLOGY_INPUT_INVALID",
      "Topology input must contain cadDocument, interpretationProfile, and architecturalExtraction (or null)",
    );
  }
  const cadResult = validateCadDocument(input.cadDocument);
  if (!cadResult.ok) {
    fail("CAD_TOPOLOGY_INPUT_INVALID", "Input is not a valid cad-document-v0.1", {
      artifact: "cad-document-v0.1",
      errors: cadResult.errors,
    });
  }
  const profileResult = validateCadInterpretationProfile(input.interpretationProfile);
  if (!profileResult.ok) {
    fail("CAD_TOPOLOGY_INPUT_INVALID", "Input is not a valid cad-interpretation-profile-v0.1", {
      artifact: "cad-interpretation-profile-v0.1",
      errors: profileResult.errors,
    });
  }
  const cadDocument = cadResult.value;
  const profile = profileResult.value;

  // 2. Candidate basis: the exact 10B spaces and walls.
  const candidates =
    input.architecturalExtraction === null
      ? stageBasis(cadDocument, profile)
      : extractionBasis(input.architecturalExtraction, cadDocument, profile);
  assertCandidateConsistency(candidates);
  const spaceWallStageHash = semanticHash({
    level: candidates.level,
    spaces: candidates.spaces,
    walls: candidates.walls,
  });
  const basisHash = candidates.architecturalExtractionHash ?? spaceWallStageHash;
  const wallsById = new Map(candidates.walls.map((wall) => [wall.candidateId, wall]));
  const wallProvenance = (wallCandidateId: string): WallCandidateProvenance => ({
    authority: "wall_candidate",
    wallCandidateId,
    spaceCandidateId: (wallsById.get(wallCandidateId) as WallCandidate).spaceCandidateId,
    basisHash,
  });

  // 3. Shared boundaries.
  const sharedBoundaries: SharedBoundary[] = detectSharedBoundaries(candidates.walls).map(
    (boundary, index): SharedBoundary => ({
      sharedBoundaryCandidateId: `shared_boundary_${pad4(index)}`,
      relationship: "shared_partition_boundary",
      spaceCandidateIds: boundary.spaceCandidateIds,
      wallCandidateIds: boundary.wallCandidateIds,
      worldStart: boundary.worldStart,
      worldEnd: boundary.worldEnd,
      lengthMm: boundary.lengthMm,
      directionRelationship: "opposite",
      wallIntervals: boundary.wallIntervals,
      provenance: {
        geometry: [
          wallProvenance(boundary.wallCandidateIds[0]),
          wallProvenance(boundary.wallCandidateIds[1]),
          derived("shared_collinear_overlap_v0.1"),
        ],
      },
    }),
  );

  // 4. Space adjacencies (one per touching pair) and wall classifications.
  const byPair = new Map<string, SharedBoundary[]>();
  for (const boundary of sharedBoundaries) {
    const key = boundary.spaceCandidateIds.join("\u0000");
    byPair.set(key, [...(byPair.get(key) ?? []), boundary]);
  }
  const spaceAdjacencies: SpaceAdjacency[] = [...byPair.values()]
    .map((boundaries): SpaceAdjacency => {
      const [first, second] = (boundaries[0] as SharedBoundary).spaceCandidateIds;
      return {
        spaceAdjacencyCandidateId: `space_adjacency_${first.slice(-4)}_${second.slice(-4)}`,
        spaceCandidateIds: [first, second],
        sharedBoundaryCandidateIds: boundaries.map(
          (boundary) => boundary.sharedBoundaryCandidateId,
        ),
        totalSharedLengthMm: boundaries.reduce((total, boundary) => total + boundary.lengthMm, 0),
        provenance: {
          adjacency: [
            ...boundaries.map((boundary) => ({
              authority: "shared_boundary" as const,
              sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId,
            })),
            derived("space_adjacency_v0.1"),
          ],
        },
      };
    })
    .sort(
      (left, right) =>
        compareText(left.spaceCandidateIds[0], right.spaceCandidateIds[0]) ||
        compareText(left.spaceCandidateIds[1], right.spaceCandidateIds[1]),
    );

  const wallClassifications: WallClassification[] = [...candidates.walls]
    .sort((left, right) => compareText(left.candidateId, right.candidateId))
    .map((wall): WallClassification => {
      const shared = sharedBoundaries.filter((boundary) =>
        boundary.wallCandidateIds.includes(wall.candidateId),
      );
      const sharedLengthMm = shared.reduce((total, boundary) => total + boundary.lengthMm, 0);
      const remainder = wall.lengthMm - sharedLengthMm;
      return {
        wallCandidateId: wall.candidateId,
        spaceCandidateId: wall.spaceCandidateId,
        boundaryRole: shared.length > 0 ? "shared_boundary_participant" : "exterior_or_unpaired",
        sharedBoundaryCandidateIds: shared.map((boundary) => boundary.sharedBoundaryCandidateId),
        lengthMm: wall.lengthMm,
        sharedLengthMm,
        unpairedLengthMm: remainder <= EPSILON ? 0 : remainder,
      };
    });

  // 5. Opening relations.
  const context: OpeningContext = { sharedBoundaries, basisHash };
  const drafts = candidates.stage
    ? stageOpenings(candidates.stage, context)
    : extractionOpenings(candidates.extraction as ArchitecturalExtraction, context);
  if (
    candidates.stage &&
    !drafts.some((draft) => draft.relationKind === "interior_shared_boundary")
  ) {
    fail(
      "CAD_TOPOLOGY_EXTRACTION_REQUIRED",
      "cad-interpretation-policy-v0.1 accepts this source (no opening lies on a shared boundary); supply its architectural-extraction-v0.1",
    );
  }
  const openingRelations = drafts
    .sort((left, right) => left.openingSourceOrdinal - right.openingSourceOrdinal)
    .map(
      (draft, index) =>
        ({ topologyOpeningId: `topology_opening_${pad4(index)}`, ...draft }) as OpeningRelation,
    );

  const spaces = [...candidates.spaces]
    .sort((left, right) => compareText(left.candidateId, right.candidateId))
    .map((space) => ({
      spaceCandidateId: space.candidateId,
      spaceType: space.spaceType,
      labelText: space.labelText,
      wallCandidateIds: candidates.walls
        .filter((wall) => wall.spaceCandidateId === space.candidateId)
        .map((wall) => wall.candidateId)
        .sort(compareText),
    }));

  const source: ArchitecturalTopologySource = {
    sourceFormat: cadDocument.sourceFormat,
    sourceHash: cadDocument.sourceHash,
    cadDocumentVersion: cadDocument.cadDocumentVersion,
    cadDocumentHash: semanticHash(cadDocument),
    profileId: profile.profileId,
    profileHash: semanticHash(profile),
    interpretationPolicyVersion: profile.interpretationPolicy,
    architecturalExtractionVersion: "0.1.0",
    candidateBasis: candidates.candidateBasis,
    architecturalExtractionHash: candidates.architecturalExtractionHash,
    spaceWallStageHash,
  };

  return {
    architecturalTopologyVersion: ARCHITECTURAL_TOPOLOGY_VERSION,
    topologyPolicyVersion: CAD_TOPOLOGY_POLICY_VERSION,
    identityScope: "topology_local_non_canonical",
    source,
    canonicalUnits: "millimeters",
    levelCandidateId: candidates.level.levelCandidateId,
    spaces,
    sharedBoundaries,
    spaceAdjacencies,
    openingRelations,
    wallClassifications,
    summary: {
      spaceCount: spaces.length,
      wallCandidateCount: wallClassifications.length,
      sharedBoundaryCount: sharedBoundaries.length,
      adjacencyCount: spaceAdjacencies.length,
      singleSpaceOpeningCount: openingRelations.filter(
        (relation) => relation.relationKind === "single_space",
      ).length,
      interiorOpeningCount: openingRelations.filter(
        (relation) => relation.relationKind === "interior_shared_boundary",
      ).length,
      unpairedWallCount: wallClassifications.filter(
        (wall) => wall.boundaryRole === "exterior_or_unpaired",
      ).length,
      sharedParticipantWallCount: wallClassifications.filter(
        (wall) => wall.boundaryRole === "shared_boundary_participant",
      ).length,
    },
    status: "READY_FOR_REVIEW",
  };
}
