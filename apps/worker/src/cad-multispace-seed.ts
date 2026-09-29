import { deriveSpaceWallStage } from "@ai-archviz/cad-interpreter";
import {
  CadSceneSeedError,
  type CadSceneSeedErrorCode,
  createMultiSpaceSceneSpecSeed,
  type MultiSpaceSeedInput,
} from "@ai-archviz/cad-scene-seed";
import type { SceneSpec } from "@ai-archviz/scene-spec";
import {
  evaluateCirculationRequirements,
  validateSpatialSceneV02,
} from "@ai-archviz/spatial-engine";
import {
  type CadSceneSeedEvidenceV02,
  semanticJsonHash,
  validateCadSceneSeedEvidenceV02,
} from "@ai-archviz/worker-contracts";

/**
 * Technical Spike 10F worker boundary: the reviewed multi-space chain
 * (cad-document, profile, extraction or null, topology, partition approval,
 * reviewed partition model) + cad-scene-seed-approval-v0.2 -> pure
 * SceneSpec v0.5 seed -> spatial-policy-v0.2 -> circulation-policy-v0.2
 * requirement evaluation -> cad-scene-seed-evidence-v0.2. Every hash is
 * recomputed here. No DCC: SceneSpec v0.5 physical realization is deferred
 * (the initial build refuses v0.5 before any DCC process).
 */

export type CadMultiSpaceSeedWorkerErrorCode =
  | CadSceneSeedErrorCode
  | "CAD_SCENE_SEED_SPATIAL_INVALID"
  | "CAD_SCENE_SEED_CIRCULATION_UNSATISFIED"
  | "CAD_SCENE_SEED_HASH_MISMATCH"
  | "CAD_SCENE_SEED_EVIDENCE_INVALID";

export class CadMultiSpaceSeedWorkerError extends Error {
  readonly code: CadMultiSpaceSeedWorkerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CadMultiSpaceSeedWorkerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CadMultiSpaceSeedWorkerError";
    this.code = code;
    this.details = details;
  }
}

export interface CadMultiSpaceSeedResult {
  sceneSpec: SceneSpec;
  sceneSpecHash: string;
  sceneApprovalHash: string;
  evidence: CadSceneSeedEvidenceV02;
}

export function createCadMultiSpaceSeed(inputs: MultiSpaceSeedInput): CadMultiSpaceSeedResult {
  let seeded: ReturnType<typeof createMultiSpaceSceneSpecSeed>;
  try {
    seeded = createMultiSpaceSceneSpecSeed(inputs);
  } catch (error) {
    if (error instanceof CadSceneSeedError) {
      throw new CadMultiSpaceSeedWorkerError(error.code, error.message, { ...error.details });
    }
    throw error;
  }
  const { sceneSpec, model } = seeded;

  // Recompute the complete chain with the shared worker-contracts primitive.
  const extraction = inputs.architecturalExtraction as {
    level: unknown;
    spaces: unknown;
    walls: unknown;
  } | null;
  const candidates =
    extraction ?? deriveSpaceWallStage(inputs.cadDocument, inputs.interpretationProfile);
  const recomputed = {
    sceneApprovalHash: semanticJsonHash(inputs.sceneApproval),
    reviewedPartitionModelHash: semanticJsonHash(inputs.reviewedPartitionModel),
    partitionApprovalHash: semanticJsonHash(inputs.partitionApproval),
    architecturalTopologyHash: semanticJsonHash(inputs.architecturalTopology),
    cadDocumentHash: semanticJsonHash(inputs.cadDocument),
    profileHash: semanticJsonHash(inputs.interpretationProfile),
    architecturalExtractionHash: extraction === null ? null : semanticJsonHash(extraction),
    spaceWallStageHash: semanticJsonHash({
      level: candidates.level,
      spaces: candidates.spaces,
      walls: candidates.walls,
    }),
  };
  const expected = {
    sceneApprovalHash: seeded.sceneApprovalHash,
    reviewedPartitionModelHash: seeded.reviewedPartitionModelHash,
    partitionApprovalHash: seeded.partitionApprovalHash,
    architecturalTopologyHash: model.source.architecturalTopologyHash,
    cadDocumentHash: model.source.cadDocumentHash,
    profileHash: model.source.profileHash,
    architecturalExtractionHash: model.source.architecturalExtractionHash,
    spaceWallStageHash: model.source.spaceWallStageHash,
  };
  const mismatched = (Object.keys(recomputed) as (keyof typeof recomputed)[]).filter(
    (key) => recomputed[key] !== expected[key],
  );
  if (mismatched.length > 0) {
    throw new CadMultiSpaceSeedWorkerError(
      "CAD_SCENE_SEED_HASH_MISMATCH",
      "Seed hashes disagree with the worker semantic hashes",
      { mismatched },
    );
  }

  // Approval can never bypass spatial-policy-v0.2 or circulation-policy-v0.2.
  const spatial = validateSpatialSceneV02(sceneSpec);
  if (spatial.status !== "PASS") {
    const [first] = spatial.violations;
    throw new CadMultiSpaceSeedWorkerError(
      "CAD_SCENE_SEED_SPATIAL_INVALID",
      `Seed fails spatial-policy-v0.2 (${first?.code ?? "unknown"})`,
      { spatialCode: first?.code ?? null, violations: spatial.violations },
    );
  }
  const circulation = evaluateCirculationRequirements(sceneSpec);
  if (circulation.circulationPolicyVersion !== "circulation-policy-v0.2") {
    throw new Error("SceneSpec v0.5 must be evaluated under circulation-policy-v0.2");
  }
  if (circulation.status !== "PASS") {
    throw new CadMultiSpaceSeedWorkerError(
      "CAD_SCENE_SEED_CIRCULATION_UNSATISFIED",
      "Seed does not satisfy its canonical circulation requirements",
    );
  }

  const scene = sceneSpec.scene as { id: string; revisionId: string };
  const geometry = sceneSpec.geometry as { type: string }[];
  const openings = sceneSpec.openings as { connectsSpaceIds?: unknown }[];
  const sceneApproval = inputs.sceneApproval as { approvalId: string };
  const evidence: CadSceneSeedEvidenceV02 = {
    evidenceVersion: "0.2.0",
    seedPolicyVersion: "cad-scene-seed-policy-v0.2",
    sceneSpecVersion: "0.5.0",
    sourceHash: model.source.sourceHash,
    cadDocumentHash: recomputed.cadDocumentHash,
    profileHash: recomputed.profileHash,
    candidateBasis: model.source.candidateBasis,
    architecturalExtractionHash: recomputed.architecturalExtractionHash,
    spaceWallStageHash: recomputed.spaceWallStageHash,
    architecturalTopologyHash: recomputed.architecturalTopologyHash,
    partitionPolicyVersion: model.partitionPolicyVersion,
    partitionApprovalId: model.approvalId,
    partitionApprovalHash: recomputed.partitionApprovalHash,
    reviewedPartitionModelHash: recomputed.reviewedPartitionModelHash,
    sceneApprovalId: sceneApproval.approvalId,
    sceneApprovalHash: recomputed.sceneApprovalHash,
    sceneSpecHash: semanticJsonHash(sceneSpec),
    projectId: (sceneSpec.project as { id: string }).id,
    sceneId: scene.id,
    revisionId: scene.revisionId,
    mappingSummary: {
      levelCount: (sceneSpec.levels as unknown[]).length,
      spaceCount: (sceneSpec.spaces as unknown[]).length,
      wallCount: geometry.filter((entry) => entry.type === "wall").length,
      sharedPartitionCount: geometry.filter((entry) => entry.type === "shared_partition").length,
      surfaceCount: geometry.filter((entry) => entry.type === "floor" || entry.type === "ceiling")
        .length,
      openingCount: openings.length,
      partitionDoorCount: openings.filter((entry) => entry.connectsSpaceIds !== undefined).length,
    },
    spatialPolicyVersion: "spatial-policy-v0.2",
    spatialValidationStatus: "PASS",
    circulationPolicyVersion: "circulation-policy-v0.2",
    circulationRequirementStatus: "PASS",
    status: "PASS",
  };
  const evidenceResult = validateCadSceneSeedEvidenceV02(evidence);
  if (!evidenceResult.ok) {
    throw new CadMultiSpaceSeedWorkerError(
      "CAD_SCENE_SEED_EVIDENCE_INVALID",
      "Seed evidence does not satisfy cad-scene-seed-evidence-v0.2",
      { errors: evidenceResult.errors },
    );
  }
  return {
    sceneSpec,
    sceneSpecHash: evidence.sceneSpecHash,
    sceneApprovalHash: recomputed.sceneApprovalHash,
    evidence,
  };
}
