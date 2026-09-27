import { validateSceneSpec } from "@ai-archviz/scene-spec";
import { evaluateCirculationRequirements } from "@ai-archviz/spatial-engine";
import {
  type CirculationRequirementEvidence,
  semanticJsonHash,
  validateCirculationRequirementEvidence,
} from "@ai-archviz/worker-contracts";

export class CirculationRequirementContractError extends Error {
  constructor(
    readonly code:
      | "CIRCULATION_REQUIREMENT_SCENE_INVALID"
      | "CIRCULATION_REQUIREMENT_EVIDENCE_INVALID",
    message: string,
    readonly details: readonly unknown[] = [],
  ) {
    super(message);
    this.name = "CirculationRequirementContractError";
  }
}

/**
 * Builds `circulation-requirement-evidence-v0.1` for a SceneSpec v0.4: validates
 * the canonical contract first (structural coherence), then evaluates
 * satisfaction through the pure 9B-backed evaluator. An unsatisfied
 * requirement is evidence, never a validation error. Never launches a DCC.
 */
export function circulationRequirementEvidence(
  sceneSpec: Record<string, unknown>,
): CirculationRequirementEvidence {
  const validation = validateSceneSpec(sceneSpec);
  if (!validation.ok) {
    throw new CirculationRequirementContractError(
      "CIRCULATION_REQUIREMENT_SCENE_INVALID",
      `SceneSpec failed validation: ${validation.errors.map((error) => error.keyword).join(", ")}`,
      validation.errors,
    );
  }
  if (sceneSpec.sceneSpecVersion !== "0.4.0") {
    throw new CirculationRequirementContractError(
      "CIRCULATION_REQUIREMENT_SCENE_INVALID",
      "Canonical circulation requirements exist only in SceneSpec v0.4",
    );
  }
  const evaluation = evaluateCirculationRequirements(sceneSpec);
  const evidence: CirculationRequirementEvidence = {
    evidenceVersion: "0.1.0",
    projectId: evaluation.projectId,
    sceneId: evaluation.sceneId,
    revisionId: evaluation.revisionId,
    sceneSpecVersion: evaluation.sceneSpecVersion,
    sceneSpecHash: semanticJsonHash(sceneSpec),
    circulationPolicyVersion: evaluation.circulationPolicyVersion,
    spatialPolicyVersion: evaluation.spatialPolicyVersion,
    requirementSetHash: semanticJsonHash(sceneSpec.circulationRequirements),
    graphSemanticHash: semanticJsonHash(evaluation.analysis.graph),
    requirements: evaluation.requirements.map(({ route, ...result }) => ({
      ...result,
      routeSemanticHash: route ? semanticJsonHash(route) : null,
    })),
    status: evaluation.status,
  };
  const evidenceValidation = validateCirculationRequirementEvidence(evidence);
  if (!evidenceValidation.ok) {
    throw new CirculationRequirementContractError(
      "CIRCULATION_REQUIREMENT_EVIDENCE_INVALID",
      "circulation-requirement-evidence-v0.1 is invalid",
      evidenceValidation.errors,
    );
  }
  return evidence;
}
