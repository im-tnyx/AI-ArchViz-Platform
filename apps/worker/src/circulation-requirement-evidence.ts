import { validateSceneSpec } from "@ai-archviz/scene-spec";
import { evaluateCirculationRequirements } from "@ai-archviz/spatial-engine";
import {
  type CirculationRequirementEvidence,
  type CirculationRequirementEvidenceV02,
  semanticJsonHash,
  validateCirculationRequirementEvidence,
  validateCirculationRequirementEvidenceV02,
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

export interface CirculationRequirementGateFailure {
  code: "CIRCULATION_REQUIREMENT_UNSATISFIED";
  /** First unsatisfied requirement in canonical order; null only when 9A fails with no requirement declared. */
  requirementId: string | null;
  failureCode: string;
  message: string;
}

/**
 * The single shared canonical-circulation gate (Spike 9D). SceneSpec
 * v0.1-v0.3 targets carry no circulation intent and are never gated; every
 * v0.4 target must satisfy all of its canonical requirements. Callers pass
 * the COMPLETE candidate target SceneSpec (operation applied and revision
 * metadata appended) and convert a failure into their own boundary's error.
 */
export function circulationRequirementGateFailure(
  targetSceneSpec: Record<string, unknown>,
): CirculationRequirementGateFailure | null {
  if (targetSceneSpec.sceneSpecVersion !== "0.4.0") return null;
  const evaluation = evaluateCirculationRequirements(targetSceneSpec);
  if (evaluation.status === "PASS") return null;
  const first = evaluation.requirements.find((entry) => entry.status !== "SATISFIED");
  const failureCode = first?.failureCode ?? "CIRCULATION_SOURCE_SPATIAL_INVALID";
  const requirementId = first?.requirementId ?? null;
  return {
    code: "CIRCULATION_REQUIREMENT_UNSATISFIED",
    requirementId,
    failureCode,
    message: requirementId
      ? `Canonical circulation requirement ${requirementId} is UNSATISFIED (${failureCode})`
      : `Canonical circulation requirements cannot be evaluated (${failureCode})`,
  };
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

/**
 * Builds `circulation-requirement-evidence-v0.2` for a SceneSpec v0.5: the
 * canonical contract is validated first, then requirements are evaluated by
 * the version-dispatched evaluator under circulation-policy-v0.2 (a shared
 * door portal resolves to the requirement space's own side). Never
 * launches a DCC.
 */
export function circulationRequirementEvidenceV02(
  sceneSpec: Record<string, unknown>,
): CirculationRequirementEvidenceV02 {
  const validation = validateSceneSpec(sceneSpec);
  if (!validation.ok) {
    throw new CirculationRequirementContractError(
      "CIRCULATION_REQUIREMENT_SCENE_INVALID",
      `SceneSpec failed validation: ${validation.errors.map((error) => error.keyword).join(", ")}`,
      validation.errors,
    );
  }
  if (sceneSpec.sceneSpecVersion !== "0.5.0") {
    throw new CirculationRequirementContractError(
      "CIRCULATION_REQUIREMENT_SCENE_INVALID",
      "circulation-requirement-evidence-v0.2 applies only to SceneSpec v0.5",
    );
  }
  const evaluation = evaluateCirculationRequirements(sceneSpec);
  if (evaluation.circulationPolicyVersion !== "circulation-policy-v0.2") {
    throw new CirculationRequirementContractError(
      "CIRCULATION_REQUIREMENT_SCENE_INVALID",
      "SceneSpec v0.5 must be evaluated under circulation-policy-v0.2",
    );
  }
  const evidence: CirculationRequirementEvidenceV02 = {
    evidenceVersion: "0.2.0",
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
  const evidenceValidation = validateCirculationRequirementEvidenceV02(evidence);
  if (!evidenceValidation.ok) {
    throw new CirculationRequirementContractError(
      "CIRCULATION_REQUIREMENT_EVIDENCE_INVALID",
      "circulation-requirement-evidence-v0.2 is invalid",
      evidenceValidation.errors,
    );
  }
  return evidence;
}
