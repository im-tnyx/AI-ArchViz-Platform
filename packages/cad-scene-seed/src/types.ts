/**
 * cad-scene-seed-policy-v0.1 (software-owned) turns ONE exact, human-approved
 * architectural-extraction-v0.1 plus an explicit cad-scene-seed-approval-v0.1
 * into an initial canonical SceneSpec v0.4 seed. READY_FOR_REVIEW is never
 * treated as approval; the approval artifact maps IDs and supplies non-CAD
 * state but can never change an architectural fact.
 */

export const CAD_SCENE_SEED_POLICY_VERSION = "cad-scene-seed-policy-v0.1";
export const CAD_SCENE_SEED_APPROVAL_VERSION = "0.1.0";
export const CAD_SCENE_SEED_EXTENSION_KEY = "aiarchviz.cad_seed";
export const CAD_SCENE_SEED_EXTENSION_VERSION = "0.1.0";

export interface CandidateMapping {
  candidateId: string;
  logicalId: string;
}

export interface SpaceMapping extends CandidateMapping {
  floorSurfaceId: string;
  ceilingSurfaceId: string;
}

export type SceneSpecObject = Record<string, unknown>;

export interface CadSceneSeedApproval {
  approvalVersion: typeof CAD_SCENE_SEED_APPROVAL_VERSION;
  approvalId: string;
  canonicalizationPolicy: typeof CAD_SCENE_SEED_POLICY_VERSION;
  decision: "approved_as_is" | "rejected" | "changes_requested";
  extraction: {
    architecturalExtractionVersion: "0.1.0";
    interpretationPolicyVersion: "cad-interpretation-policy-v0.1";
    profileId: string;
    architecturalExtractionHash: string;
    sourceHash: string;
    cadDocumentHash: string;
    profileHash: string;
  };
  canonical: {
    project: { id: string; name: string };
    scene: { id: string; revisionId: string; createdAt: string };
  };
  lockPolicy: "all_unlocked";
  mappings: {
    levels: CandidateMapping[];
    spaces: SpaceMapping[];
    walls: CandidateMapping[];
    openings: CandidateMapping[];
  };
  nonCadState: {
    sources: SceneSpecObject[];
    assetDefinitions: SceneSpecObject[];
    assets: SceneSpecObject[];
    materials: SceneSpecObject[];
    materialAssignments: SceneSpecObject[];
    lights: SceneSpecObject[];
    cameras: SceneSpecObject[];
    render: SceneSpecObject;
    circulationRequirements: SceneSpecObject[];
  };
}

export type CadSceneSeedErrorCode =
  | "CAD_SCENE_SEED_EXTRACTION_INVALID"
  | "CAD_SCENE_SEED_APPROVAL_INVALID"
  | "CAD_SCENE_SEED_NOT_APPROVED"
  | "CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH"
  | "CAD_SCENE_SEED_MAPPING_UNSORTED"
  | "CAD_SCENE_SEED_MAPPING_DUPLICATE"
  | "CAD_SCENE_SEED_MAPPING_UNKNOWN_CANDIDATE"
  | "CAD_SCENE_SEED_MAPPING_INCOMPLETE"
  | "CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE"
  | "CAD_SCENE_SEED_SCENESPEC_INVALID"
  | "CAD_SCENE_SEED_REFERENCE_INVALID"
  | "CAD_SCENE_SEED_SOURCE_INVALID";

export class CadSceneSeedError extends Error {
  readonly code: CadSceneSeedErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CadSceneSeedErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CadSceneSeedError";
    this.code = code;
    this.details = details;
  }
}
