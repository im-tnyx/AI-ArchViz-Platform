import type {
  DoorRule,
  OpeningCandidate,
  Point2,
  WallCandidate,
} from "@ai-archviz/cad-interpreter";

/**
 * cad-topology-policy-v0.1 (software-owned algorithm) analyzes the 10B
 * space/wall candidates of one CAD source and produces
 * architectural-topology-v0.1: which interpreted spaces touch, over what
 * exact boundary interval, and which opening connects them. It is a
 * human-review artifact. It is NOT SceneSpec, NOT approved canonical
 * topology, and NOT a DCC plan; every ID in it is topology-local and never
 * a canonical SceneSpec logical ID. Whether a shared boundary becomes one
 * SceneSpec wall, two walls, or a dual-space partition is deliberately not
 * decided here.
 */

export const CAD_TOPOLOGY_POLICY_VERSION = "cad-topology-policy-v0.1";
export const ARCHITECTURAL_TOPOLOGY_VERSION = "0.1.0";

/** Fixed, implementation-owned geometric equivalence epsilon (never user/profile input). */
export const CAD_TOPOLOGY_EPSILON_MM = 0.001;

export type { Point2 };

/**
 * Where the 10B space/wall candidates came from:
 * - architectural_extraction: a supplied, validated, READY_FOR_REVIEW
 *   architectural-extraction-v0.1 (its hash is bound);
 * - space_wall_stage: the shared 10B space/wall derivation run on the bound
 *   cad-document + profile, used only when 10B v0.1 itself rejects the
 *   source because an opening lies on a shared boundary
 *   (CAD_INTERPRET_OPENING_HOST_AMBIGUOUS), so no extraction can exist.
 */
export type CandidateBasis = "architectural_extraction" | "space_wall_stage";

export interface ArchitecturalTopologyInput {
  cadDocument: unknown;
  interpretationProfile: unknown;
  /** The 10B extraction for this exact source/profile, or null (space_wall_stage basis). */
  architecturalExtraction: unknown;
}

export interface ArchitecturalTopologySource {
  sourceFormat: "dxf";
  sourceHash: string;
  cadDocumentVersion: "0.1.0";
  cadDocumentHash: string;
  profileId: string;
  profileHash: string;
  interpretationPolicyVersion: "cad-interpretation-policy-v0.1";
  architecturalExtractionVersion: "0.1.0";
  candidateBasis: CandidateBasis;
  /** semantic hash of the supplied extraction; null only for space_wall_stage. */
  architecturalExtractionHash: string | null;
  /** semantic hash of {level, spaces, walls}: the exact 10B candidates analyzed. */
  spaceWallStageHash: string;
}

// ------------------------------------------------------------- provenance

/** A 10B wall candidate (and its space) that a relation was derived from. */
export interface WallCandidateProvenance {
  authority: "wall_candidate";
  wallCandidateId: string;
  spaceCandidateId: string;
  /** architecturalExtractionHash, or spaceWallStageHash for the stage basis. */
  basisHash: string;
}

export interface SharedBoundaryProvenance {
  authority: "shared_boundary";
  sharedBoundaryCandidateId: string;
}

/** An existing, uniquely hosted 10B opening candidate, referenced as-is. */
export interface OpeningCandidateProvenance {
  authority: "opening_candidate";
  openingCandidateId: string;
  basisHash: string;
}

export interface TopologyCadProvenance {
  authority: "cad";
  sourceOrdinal: number;
  sourceHandle: string | null;
  role: "door_insert" | "window_insert";
}

export interface TopologyProfileProvenance {
  authority: "profile";
  field: string;
  ruleId: string | null;
}

export interface TopologyDerivedProvenance {
  authority: "derived";
  derivation: string;
}

export type TopologyProvenance =
  | WallCandidateProvenance
  | SharedBoundaryProvenance
  | OpeningCandidateProvenance
  | TopologyCadProvenance
  | TopologyProfileProvenance
  | TopologyDerivedProvenance;

// --------------------------------------------------------------- topology

export interface TopologySpace {
  spaceCandidateId: string;
  spaceType: string;
  labelText: string;
  wallCandidateIds: string[];
}

export interface SharedBoundaryWallInterval {
  wallCandidateId: string;
  spaceCandidateId: string;
  /** Interval along the wall's own start->end direction, mm from its start. */
  fromMm: number;
  toMm: number;
}

export interface SharedBoundary {
  sharedBoundaryCandidateId: string;
  relationship: "shared_partition_boundary";
  /** Exactly two, sorted lexically. */
  spaceCandidateIds: [string, string];
  /** The two participating 10B wall candidates, sorted lexically. */
  wallCandidateIds: [string, string];
  /** Canonical world direction: lexicographically lower (x, then y) endpoint first. */
  worldStart: Point2;
  worldEnd: Point2;
  lengthMm: number;
  directionRelationship: "opposite";
  wallIntervals: SharedBoundaryWallInterval[];
  provenance: { geometry: TopologyProvenance[] };
}

export interface SpaceAdjacency {
  spaceAdjacencyCandidateId: string;
  spaceCandidateIds: [string, string];
  sharedBoundaryCandidateIds: string[];
  totalSharedLengthMm: number;
  provenance: { adjacency: TopologyProvenance[] };
}

export interface InteriorOpeningRelation {
  topologyOpeningId: string;
  relationKind: "interior_shared_boundary";
  type: "door";
  openingSourceOrdinal: number;
  openingSourceHandle: string | null;
  blockName: string;
  /** Actual room-to-room connectivity evidence; exactly two, sorted lexically. */
  connectsSpaces: [string, string];
  sharedBoundaryCandidateId: string;
  centerXY: Point2;
  /** Perpendicular distance from the center to the shared interval's line. */
  hostDistanceMm: number;
  centerDistanceFromWorldStartMm: number;
  /** Opening start along the shared interval: center distance - width / 2. */
  offsetFromWorldStartMm: number;
  resolvedWidthMm: number;
  resolvedHeightMm: number;
  resolvedSillMm: number;
  /**
   * The exact matched profile door rule. Its hinge/swing values are recorded
   * verbatim; resolving them against a shared partition (which room is
   * "into", which jamb is "start") is deferred to canonicalization.
   */
  doorRule: {
    ruleId: string;
    hingeSide: DoorRule["hingeSide"];
    swingDirection: DoorRule["swingDirection"];
  };
  provenance: Record<
    | "center"
    | "host"
    | "offsetFromWorldStartMm"
    | "resolvedWidthMm"
    | "resolvedHeightMm"
    | "resolvedSillMm"
    | "doorRule",
    TopologyProvenance[]
  >;
}

export interface SingleSpaceOpeningRelation {
  topologyOpeningId: string;
  relationKind: "single_space";
  type: "door" | "window";
  openingSourceOrdinal: number;
  openingSourceHandle: string | null;
  blockName: string;
  connectsSpaces: [string];
  hostWallCandidateId: string;
  /** The uniquely hosted 10B opening candidate, verbatim (never reinterpreted). */
  openingCandidate: OpeningCandidate;
  provenance: { relation: TopologyProvenance[] };
}

export type OpeningRelation = InteriorOpeningRelation | SingleSpaceOpeningRelation;

export type WallBoundaryRole = "exterior_or_unpaired" | "shared_boundary_participant";

export interface WallClassification {
  wallCandidateId: string;
  spaceCandidateId: string;
  /**
   * exterior_or_unpaired: no positive shared overlap with any SUPPLIED space.
   * This is not a claim that the wall is a building exterior wall.
   */
  boundaryRole: WallBoundaryRole;
  sharedBoundaryCandidateIds: string[];
  lengthMm: number;
  sharedLengthMm: number;
  unpairedLengthMm: number;
}

export interface ArchitecturalTopologySummary {
  spaceCount: number;
  wallCandidateCount: number;
  sharedBoundaryCount: number;
  adjacencyCount: number;
  singleSpaceOpeningCount: number;
  interiorOpeningCount: number;
  unpairedWallCount: number;
  sharedParticipantWallCount: number;
}

export interface ArchitecturalTopology {
  architecturalTopologyVersion: typeof ARCHITECTURAL_TOPOLOGY_VERSION;
  topologyPolicyVersion: typeof CAD_TOPOLOGY_POLICY_VERSION;
  identityScope: "topology_local_non_canonical";
  source: ArchitecturalTopologySource;
  canonicalUnits: "millimeters";
  levelCandidateId: string;
  spaces: TopologySpace[];
  sharedBoundaries: SharedBoundary[];
  spaceAdjacencies: SpaceAdjacency[];
  openingRelations: OpeningRelation[];
  wallClassifications: WallClassification[];
  summary: ArchitecturalTopologySummary;
  status: "READY_FOR_REVIEW";
}

// ----------------------------------------------------------------- errors

export type CadTopologyErrorCode =
  | "CAD_TOPOLOGY_INPUT_INVALID"
  | "CAD_TOPOLOGY_INPUT_HASH_MISMATCH"
  | "CAD_TOPOLOGY_EXTRACTION_REQUIRED"
  | "CAD_TOPOLOGY_INTERPRETATION_REJECTED"
  | "CAD_TOPOLOGY_SHARED_INTERVAL_CONFLICT"
  | "CAD_TOPOLOGY_SHARED_EDGE_DIRECTION_INVALID"
  | "CAD_TOPOLOGY_OPENING_AMBIGUOUS"
  | "CAD_TOPOLOGY_OPENING_OUTSIDE_SHARED_BOUNDARY"
  | "CAD_TOPOLOGY_WINDOW_ON_SHARED_BOUNDARY_UNSUPPORTED";

export class CadTopologyError extends Error {
  readonly code: CadTopologyErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CadTopologyErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CadTopologyError";
    this.code = code;
    this.details = details;
  }
}

/** Candidate walls exactly as 10B emitted them (the boundary-edge authority). */
export type TopologyWallInput = Pick<
  WallCandidate,
  "candidateId" | "spaceCandidateId" | "start" | "end" | "lengthMm"
>;
