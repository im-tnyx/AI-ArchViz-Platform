import { analyzeCirculation, analyzeCirculationV02 } from "@ai-archviz/spatial-engine";
import {
  type CirculationAnalysisEvidence,
  type CirculationAnalysisEvidenceV02,
  semanticJsonHash,
  validateCirculationAnalysisEvidence,
  validateCirculationAnalysisEvidenceV02,
} from "@ai-archviz/worker-contracts";

/**
 * Builds the compact `circulation-analysis-evidence-v0.1` wrapper around the
 * pure circulation-policy-v0.1 result. The full walkable graph is never
 * serialized; it is committed to only through `graphSemanticHash`.
 */
export function circulationAnalysisEvidence(
  sceneSpec: Record<string, unknown>,
): CirculationAnalysisEvidence {
  const result = analyzeCirculation(sceneSpec);
  const evidence: CirculationAnalysisEvidence = {
    evidenceVersion: "0.1.0",
    policyVersion: result.policyVersion,
    projectId: result.projectId,
    sceneId: result.sceneId,
    revisionId: result.revisionId,
    sceneSpecVersion: result.sceneSpecVersion,
    sceneSpecHash: semanticJsonHash(sceneSpec),
    spatialPolicyVersion: result.spatialPolicyVersion,
    spatialValidationStatus: result.spatialValidationStatus,
    gridStepMm: result.gridStepMm,
    agentRadiusMm: result.agentRadiusMm,
    spaces: result.spaces,
    graphSemanticHash: semanticJsonHash(result.graph),
    status: result.status,
    violations: result.violations,
  };
  const validation = validateCirculationAnalysisEvidence(evidence);
  if (!validation.ok) {
    throw new Error(
      `circulation-analysis-evidence-v0.1 is invalid: ${JSON.stringify(validation.errors)}`,
    );
  }
  return evidence;
}

/**
 * `circulation-analysis-evidence-v0.2` for a SceneSpec v0.5
 * (circulation-policy-v0.2 over spatial-policy-v0.2). Same compact shape as
 * v0.1; the graph is committed to only through `graphSemanticHash`.
 */
export function circulationAnalysisEvidenceV02(
  sceneSpec: Record<string, unknown>,
): CirculationAnalysisEvidenceV02 {
  const result = analyzeCirculationV02(sceneSpec);
  const evidence: CirculationAnalysisEvidenceV02 = {
    evidenceVersion: "0.2.0",
    policyVersion: result.policyVersion,
    projectId: result.projectId,
    sceneId: result.sceneId,
    revisionId: result.revisionId,
    sceneSpecVersion: result.sceneSpecVersion,
    sceneSpecHash: semanticJsonHash(sceneSpec),
    spatialPolicyVersion: result.spatialPolicyVersion,
    spatialValidationStatus: result.spatialValidationStatus,
    gridStepMm: result.gridStepMm,
    agentRadiusMm: result.agentRadiusMm,
    spaces: result.spaces,
    graphSemanticHash: semanticJsonHash(result.graph),
    status: result.status,
    violations: result.violations,
  };
  const validation = validateCirculationAnalysisEvidenceV02(evidence);
  if (!validation.ok) {
    throw new Error(
      `circulation-analysis-evidence-v0.2 is invalid: ${JSON.stringify(validation.errors)}`,
    );
  }
  return evidence;
}
