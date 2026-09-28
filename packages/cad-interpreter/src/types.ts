/**
 * cad-interpretation-policy-v0.1 (software-owned algorithm) applied to a
 * cad-document-v0.1 under a human-authored cad-interpretation-profile-v0.1
 * produces architectural-extraction-v0.1: deterministic architectural
 * CANDIDATES awaiting human review. It is not SceneSpec, and candidate IDs
 * are local interpretation identity, never canonical SceneSpec logical IDs.
 */

export const CAD_INTERPRETATION_POLICY_VERSION = "cad-interpretation-policy-v0.1";
export const CAD_INTERPRETATION_PROFILE_VERSION = "0.1.0";
export const ARCHITECTURAL_EXTRACTION_VERSION = "0.1.0";

/** Fixed, implementation-owned opening-host tolerance (never user input). */
export const CAD_INTERPRET_HOST_TOLERANCE_MM = 1;
/** Shared numeric epsilon for degeneracy, containment, and offset bounds. */
export const CAD_INTERPRET_EPSILON_MM = 0.001;

export type Point2 = [number, number];

// ---------------------------------------------------------------- profile

export interface CadInterpretationLayers {
  spaceBoundary: string;
  spaceLabel: string;
  door: string;
  window: string;
}

export interface CadInterpretationLevel {
  levelCandidateId: string;
  name: string;
  elevationMm: number;
  defaultCeilingHeightMm: number;
}

export interface SpaceLabelRule {
  ruleId: string;
  /** Exact, case-sensitive TEXT content. */
  text: string;
  spaceType: string;
}

export interface DoorRule {
  ruleId: string;
  blockName: string;
  widthMm: number;
  heightMm: number;
  sillMm: 0;
  anchorPolicy: "center";
  hingeSide: "start_jamb" | "end_jamb";
  swingDirection: "into_room" | "out_of_room";
}

export interface WindowRule {
  ruleId: string;
  blockName: string;
  widthMm: number;
  heightMm: number;
  sillMm: number;
  anchorPolicy: "center";
}

export interface CadInterpretationProfile {
  profileVersion: typeof CAD_INTERPRETATION_PROFILE_VERSION;
  profileId: string;
  cadDocumentVersion: "0.1.0";
  interpretationPolicy: typeof CAD_INTERPRETATION_POLICY_VERSION;
  layers: CadInterpretationLayers;
  level: CadInterpretationLevel;
  wallDefaults: { wallThicknessMm: number };
  spaceLabelRules: SpaceLabelRule[];
  doorRules: DoorRule[];
  windowRules: WindowRule[];
}

// ------------------------------------------------------------- provenance

export type CadSourceRole = "space_boundary" | "space_label" | "door_insert" | "window_insert";

/** A value read from CAD source evidence (cad-document-v0.1). */
export interface CadProvenance {
  authority: "cad";
  sourceOrdinal: number;
  sourceHandle: string | null;
  role: CadSourceRole;
}

/** A value supplied by the human-authored profile. */
export interface ProfileProvenance {
  authority: "profile";
  field: string;
  ruleId: string | null;
}

/** A value computed by cad-interpretation-policy-v0.1. */
export interface DerivedProvenance {
  authority: "derived";
  derivation: string;
}

export type Provenance = CadProvenance | ProfileProvenance | DerivedProvenance;

// ------------------------------------------------------------- extraction

export interface LevelCandidate {
  levelCandidateId: string;
  name: string;
  elevationMm: number;
  defaultCeilingHeightMm: number;
  provenance: Record<"name" | "elevationMm" | "defaultCeilingHeightMm", Provenance[]>;
}

export type SourceWinding = "counter_clockwise" | "clockwise";

export interface SpaceCandidate {
  candidateId: string;
  levelCandidateId: string;
  spaceType: string;
  labelText: string;
  boundary: Point2[];
  boundaryWinding: "counter_clockwise";
  sourceWinding: SourceWinding;
  normalization: "none" | "reversed_to_counter_clockwise";
  floorElevationMm: number;
  ceilingHeightMm: number;
  provenance: Record<
    "boundary" | "spaceType" | "floorElevationMm" | "ceilingHeightMm",
    Provenance[]
  >;
}

export interface WallCandidate {
  candidateId: string;
  spaceCandidateId: string;
  levelCandidateId: string;
  edgeIndex: number;
  start: Point2;
  end: Point2;
  lengthMm: number;
  baseElevationMm: number;
  heightMm: number;
  thicknessMm: number;
  referenceLine: "interior_face";
  thicknessDirection: "exterior_right_of_u";
  provenance: Record<
    "geometry" | "baseElevationMm" | "heightMm" | "thicknessMm" | "referenceConvention",
    Provenance[]
  >;
}

interface OpeningCandidateBase {
  candidateId: string;
  hostWallCandidateId: string;
  spaceCandidateId: string;
  blockName: string;
  /** Source INSERT insertion point XY (the declared opening center), mm. */
  sourceCenter: Point2;
  /** Source INSERT rotation, recorded as provenance only; never interpreted. */
  sourceRotationDegrees: number;
  /** Perpendicular distance from the center to the host wall line (<= tolerance). */
  hostDistanceMm: number;
  offsetMm: number;
  widthMm: number;
  heightMm: number;
  sillMm: number;
}

export interface DoorCandidate extends OpeningCandidateBase {
  type: "door";
  hingeSide: DoorRule["hingeSide"];
  swingDirection: DoorRule["swingDirection"];
  provenance: Record<
    | "center"
    | "host"
    | "offsetMm"
    | "widthMm"
    | "heightMm"
    | "sillMm"
    | "hingeSide"
    | "swingDirection",
    Provenance[]
  >;
}

export interface WindowCandidate extends OpeningCandidateBase {
  type: "window";
  provenance: Record<
    "center" | "host" | "offsetMm" | "widthMm" | "heightMm" | "sillMm",
    Provenance[]
  >;
}

export type OpeningCandidate = DoorCandidate | WindowCandidate;

export type UnconsumedReason = "UNMAPPED_LAYER" | "UNSUPPORTED_SOURCE_ENTITY";

export interface UnconsumedEntity {
  sourceOrdinal: number;
  sourceHandle: string | null;
  type: string;
  layer: string;
  reason: UnconsumedReason;
}

export interface ArchitecturalExtractionSummary {
  spaceCount: number;
  wallCount: number;
  openingCount: number;
  doorCount: number;
  windowCount: number;
  sourceEntityCount: number;
  consumedEntityCount: number;
  unconsumedEntityCount: number;
}

export interface ArchitecturalExtraction {
  architecturalExtractionVersion: typeof ARCHITECTURAL_EXTRACTION_VERSION;
  interpretationPolicyVersion: typeof CAD_INTERPRETATION_POLICY_VERSION;
  profileId: string;
  profileHash: string;
  source: {
    cadDocumentVersion: "0.1.0";
    sourceFormat: "dxf";
    sourceHash: string;
    cadDocumentHash: string;
  };
  canonicalUnits: "millimeters";
  level: LevelCandidate;
  spaces: SpaceCandidate[];
  walls: WallCandidate[];
  openings: OpeningCandidate[];
  unconsumedEntities: UnconsumedEntity[];
  summary: ArchitecturalExtractionSummary;
  status: "READY_FOR_REVIEW";
}

// ----------------------------------------------------------------- errors

export type CadInterpretationErrorCode =
  | "CAD_INTERPRET_CAD_DOCUMENT_INVALID"
  | "CAD_INTERPRET_PROFILE_INVALID"
  | "CAD_INTERPRET_UNSUPPORTED_ENTITY_ON_MAPPED_LAYER"
  | "CAD_INTERPRET_ENTITY_ROLE_MISMATCH"
  | "CAD_INTERPRET_SPACE_BOUNDARY_CURVED_UNSUPPORTED"
  | "CAD_INTERPRET_SPACE_BOUNDARY_INVALID"
  | "CAD_INTERPRET_SPACE_MISSING"
  | "CAD_INTERPRET_SPACE_OVERLAP"
  | "CAD_INTERPRET_SPACE_LABEL_UNMAPPED"
  | "CAD_INTERPRET_SPACE_LABEL_ORPHANED"
  | "CAD_INTERPRET_SPACE_LABEL_MISSING"
  | "CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS"
  | "CAD_INTERPRET_BLOCK_REFERENCE_INVALID"
  | "CAD_INTERPRET_EXTERNAL_BLOCK_UNSUPPORTED"
  | "CAD_INTERPRET_OPENING_RULE_MISSING"
  | "CAD_INTERPRET_OPENING_SCALE_UNSUPPORTED"
  | "CAD_INTERPRET_OPENING_HOST_UNRESOLVED"
  | "CAD_INTERPRET_OPENING_HOST_AMBIGUOUS"
  | "CAD_INTERPRET_OPENING_OUTSIDE_HOST";

export class CadInterpretationError extends Error {
  readonly code: CadInterpretationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CadInterpretationErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CadInterpretationError";
    this.code = code;
    this.details = details;
  }
}
