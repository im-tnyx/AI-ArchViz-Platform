import type { Point2 } from "@ai-archviz/cad-interpreter";

/**
 * cad-shared-partition-policy-v0.1 (software-owned algorithm) turns one
 * architectural-topology-v0.1 plus an explicit human
 * cad-topology-approval-v0.1 into reviewed-partition-model-v0.1: the
 * physical shared partitions (centerline, thickness, height, one interior
 * face per adjacent space), their interior doors with reviewed hinge/swing
 * orientation, and exact per-wall segmentation. It is NOT SceneSpec; every
 * ID is model-local and never a canonical logical ID. How the model is
 * represented in SceneSpec is deliberately not decided here.
 */

export const CAD_SHARED_PARTITION_POLICY_VERSION = "cad-shared-partition-policy-v0.1";
export const CAD_TOPOLOGY_APPROVAL_VERSION = "0.1.0";
export const REVIEWED_PARTITION_MODEL_VERSION = "0.1.0";

/** Fixed, implementation-owned geometric equivalence epsilon (never user/profile input). */
export const CAD_PARTITION_EPSILON_MM = 0.001;

export type { Point2 };

// --------------------------------------------------------------- approval

export type CandidateBasis = "architectural_extraction" | "space_wall_stage";
export type HingeEndpoint = "world_start" | "world_end";

export interface SharedBoundaryReview {
  sharedBoundaryCandidateId: string;
  /** The only v0.1 policy: the 10D interval IS the physical partition centerline. */
  referencePolicy: "partition_centerline";
}

export interface InteriorDoorReview {
  topologyOpeningId: string;
  /** Which door jamb (along the canonical worldStart -> worldEnd direction) is hinged. */
  hingeEndpoint: HingeEndpoint;
  /** One of the door's two connectsSpaces. */
  swingIntoSpaceCandidateId: string;
}

/** Declarative review of one exact topology; semantics only, never geometry. */
export interface CadTopologyApproval {
  approvalVersion: typeof CAD_TOPOLOGY_APPROVAL_VERSION;
  approvalId: string;
  partitionPolicy: typeof CAD_SHARED_PARTITION_POLICY_VERSION;
  decision: "approved_as_shared_partition_model" | "rejected" | "changes_requested";
  topology: {
    architecturalTopologyVersion: "0.1.0";
    architecturalTopologyHash: string;
    candidateBasis: CandidateBasis;
    sourceHash: string;
    cadDocumentHash: string;
    profileHash: string;
    spaceWallStageHash: string;
    /** Legitimately null for the space_wall_stage basis (no extraction exists). */
    architecturalExtractionHash: string | null;
  };
  /** Sorted by sharedBoundaryCandidateId; exactly one per topology shared boundary. */
  sharedBoundaryReviews: SharedBoundaryReview[];
  /** Sorted by topologyOpeningId; exactly one per interior shared-boundary door. */
  interiorDoorReviews: InteriorDoorReview[];
}

export interface ReviewedPartitionModelInput {
  cadDocument: unknown;
  interpretationProfile: unknown;
  /** The 10B extraction, or null exactly when the topology basis is space_wall_stage. */
  architecturalExtraction: unknown;
  architecturalTopology: unknown;
  approval: unknown;
}

// ------------------------------------------------------------- provenance

export interface TopologyReference {
  authority: "topology";
  relation: "shared_boundary" | "opening";
  id: string;
}

export interface WallCandidateReference {
  authority: "wall_candidate";
  wallCandidateId: string;
  spaceCandidateId: string;
}

export interface ApprovalProvenance {
  authority: "approval";
  approvalId: string;
  field: string;
}

export interface PartitionProfileProvenance {
  authority: "profile";
  field: string;
  ruleId: string | null;
}

export interface PartitionCadProvenance {
  authority: "cad";
  sourceOrdinal: number;
  sourceHandle: string | null;
  role: "door_insert";
}

export interface PartitionReference {
  authority: "partition";
  partitionCandidateId: string;
}

export interface PartitionDerivedProvenance {
  authority: "derived";
  derivation: string;
}

export type PartitionProvenance =
  | TopologyReference
  | WallCandidateReference
  | ApprovalProvenance
  | PartitionProfileProvenance
  | PartitionCadProvenance
  | PartitionReference
  | PartitionDerivedProvenance;

// ------------------------------------------------------------------ model

export type PartitionSide = "left" | "right";

export interface PartitionSpaceFace {
  side: PartitionSide;
  spaceCandidateId: string;
  /** The 10B wall candidate whose CCW direction placed this space on this side. */
  sourceWallCandidateId: string;
  /** Same canonical direction as the centerline (worldStart -> worldEnd). */
  start: Point2;
  end: Point2;
  offsetFromCenterlineMm: number;
}

export interface ReviewedInteriorDoor {
  topologyOpeningId: string;
  type: "door";
  openingSourceOrdinal: number;
  openingSourceHandle: string | null;
  blockName: string;
  /** Sorted lexically; exactly the partition's two adjacent spaces. */
  connectsSpaces: [string, string];
  centerXY: Point2;
  centerDistanceFromWorldStartMm: number;
  offsetFromWorldStartMm: number;
  widthMm: number;
  heightMm: number;
  sillMm: number;
  /** Reviewed: which jamb (along worldStart -> worldEnd) carries the hinge. */
  hingeEndpoint: HingeEndpoint;
  /** Derived: the hinge jamb on the partition centerline. */
  hingeJambCenterlinePoint: Point2;
  /** Reviewed: the adjacent space the leaf swings into. */
  swingIntoSpaceCandidateId: string;
  /** Derived: the partition side of that space. */
  swingIntoSide: PartitionSide;
  /** The original profile rule, preserved as provenance only (not the reviewed orientation). */
  profileDoorRule: { ruleId: string; hingeSide: string; swingDirection: string };
  provenance: Record<
    | "topologyRelation"
    | "source"
    | "dimensions"
    | "host"
    | "hingeEndpoint"
    | "swingIntoSpaceCandidateId"
    | "profileDoorRule",
    PartitionProvenance[]
  >;
}

export interface SharedPartition {
  partitionCandidateId: string;
  sharedBoundaryCandidateId: string;
  /** Sorted lexically. */
  adjacentSpaceCandidateIds: [string, string];
  /** Sorted lexically. */
  sourceWallCandidateIds: [string, string];
  referencePolicy: "partition_centerline";
  levelCandidateId: string;
  centerLineStart: Point2;
  centerLineEnd: Point2;
  lengthMm: number;
  unitDirection: Point2;
  leftNormal: Point2;
  rightNormal: Point2;
  baseElevationMm: number;
  heightMm: number;
  thicknessMm: number;
  /** Left face first, then right face. */
  spaceFaces: [PartitionSpaceFace, PartitionSpaceFace];
  openings: ReviewedInteriorDoor[];
  provenance: Record<
    "centerLine" | "referencePolicy" | "thicknessMm" | "vertical" | "spaceSides" | "spaceFaces",
    PartitionProvenance[]
  >;
}

export interface WallSegmentInterval {
  fromMm: number;
  toMm: number;
  role: "shared_partition" | "unpaired";
  /** Set for shared_partition intervals only. */
  partitionCandidateId: string | null;
}

export interface WallSegmentation {
  wallCandidateId: string;
  spaceCandidateId: string;
  lengthMm: number;
  /** Cover [0, lengthMm] exactly once along the wall's own direction: no gaps, no overlap. */
  intervals: WallSegmentInterval[];
}

export interface UnsharedOpeningReference {
  topologyOpeningId: string;
  openingCandidateId: string;
  type: "door" | "window";
  openingSourceOrdinal: number;
  spaceCandidateId: string;
  hostWallCandidateId: string;
}

export interface PartitionModelSpace {
  spaceCandidateId: string;
  spaceType: string;
  partitionCandidateIds: string[];
  adjacentSpaceCandidateIds: string[];
}

export interface ReviewedPartitionModelSummary {
  spaceCount: number;
  sharedPartitionCount: number;
  reviewedInteriorDoorCount: number;
  unsharedOpeningCount: number;
  wallCandidateCount: number;
  sharedWallIntervalCount: number;
  unpairedWallIntervalCount: number;
}

export interface ReviewedPartitionModel {
  reviewedPartitionModelVersion: typeof REVIEWED_PARTITION_MODEL_VERSION;
  partitionPolicyVersion: typeof CAD_SHARED_PARTITION_POLICY_VERSION;
  identityScope: "model_local_non_canonical";
  approvalId: string;
  approvalHash: string;
  source: {
    architecturalTopologyVersion: "0.1.0";
    architecturalTopologyHash: string;
    topologyPolicyVersion: "cad-topology-policy-v0.1";
    candidateBasis: CandidateBasis;
    sourceHash: string;
    cadDocumentHash: string;
    profileId: string;
    profileHash: string;
    interpretationPolicyVersion: "cad-interpretation-policy-v0.1";
    architecturalExtractionHash: string | null;
    spaceWallStageHash: string;
  };
  canonicalUnits: "millimeters";
  levelCandidateId: string;
  spaces: PartitionModelSpace[];
  sharedPartitions: SharedPartition[];
  wallSegments: WallSegmentation[];
  unsharedOpeningReferences: UnsharedOpeningReference[];
  summary: ReviewedPartitionModelSummary;
  status: "APPROVED_FOR_SCENE_CANONICALIZATION";
}

// ----------------------------------------------------------------- errors

export type CadPartitionErrorCode =
  | "CAD_PARTITION_INPUT_INVALID"
  | "CAD_PARTITION_INPUT_HASH_MISMATCH"
  | "CAD_PARTITION_APPROVAL_INVALID"
  | "CAD_PARTITION_APPROVAL_NOT_APPROVED"
  | "CAD_PARTITION_APPROVAL_HASH_MISMATCH"
  | "CAD_PARTITION_APPROVAL_REVIEW_DUPLICATE"
  | "CAD_PARTITION_APPROVAL_REVIEW_UNSORTED"
  | "CAD_PARTITION_APPROVAL_REVIEW_UNKNOWN"
  | "CAD_PARTITION_APPROVAL_REVIEW_MISSING"
  | "CAD_PARTITION_DOOR_SWING_SPACE_INVALID"
  | "CAD_PARTITION_SHARED_WINDOW_INVALID"
  | "CAD_PARTITION_TOPOLOGY_INCONSISTENT"
  | "CAD_PARTITION_THICKNESS_CONFLICT"
  | "CAD_PARTITION_VERTICAL_CONFLICT"
  | "CAD_PARTITION_SPACE_SIDE_INVALID"
  | "CAD_PARTITION_OPENING_OUTSIDE_PARTITION"
  | "CAD_PARTITION_SEGMENTATION_INVALID";

export class CadPartitionError extends Error {
  readonly code: CadPartitionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CadPartitionErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CadPartitionError";
    this.code = code;
    this.details = details;
  }
}
