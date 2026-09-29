import { validateSpatialScene, validateSpatialSceneV02 } from "@ai-archviz/spatial-engine";
import {
  type SpatialValidationEvidence,
  type SpatialValidationEvidenceV02,
  semanticJsonHash,
  validateSpatialValidationEvidenceV02,
} from "@ai-archviz/worker-contracts";

/**
 * Builds the versioned `spatial-validation-evidence-v0.1` wrapper around the
 * pure `@ai-archviz/spatial-engine` result: identity fields plus
 * `sceneSpecHash` (hashing is a worker-contracts concern, not the pure
 * engine's).
 */
export function spatialValidationEvidence(
  sceneSpec: Record<string, unknown>,
): SpatialValidationEvidence {
  const result = validateSpatialScene(sceneSpec);
  return {
    evidenceVersion: "0.1.0",
    policyVersion: result.policyVersion,
    projectId: result.projectId,
    sceneId: result.sceneId,
    revisionId: result.revisionId,
    sceneSpecVersion: result.sceneSpecVersion,
    sceneSpecHash: semanticJsonHash(sceneSpec),
    status: result.status,
    assetFootprints: result.assetFootprints,
    doorwayClearances: result.doorwayClearances,
    violations: result.violations,
  };
}

/**
 * `spatial-validation-evidence-v0.2` for a SceneSpec v0.5 (spatial-policy-v0.2):
 * the v0.1 identity fields plus the physical partition solids and two-sided
 * doorway clearances. v0.1 evidence is never produced for v0.5.
 */
export function spatialValidationEvidenceV02(
  sceneSpec: Record<string, unknown>,
): SpatialValidationEvidenceV02 {
  const result = validateSpatialSceneV02(sceneSpec);
  const evidence: SpatialValidationEvidenceV02 = {
    evidenceVersion: "0.2.0",
    policyVersion: result.policyVersion,
    projectId: result.projectId,
    sceneId: result.sceneId,
    revisionId: result.revisionId,
    sceneSpecVersion: result.sceneSpecVersion,
    sceneSpecHash: semanticJsonHash(sceneSpec),
    status: result.status,
    assetFootprints: result.assetFootprints,
    partitionSolids: result.partitionSolids,
    doorwayClearances: result.doorwayClearances,
    violations: result.violations,
  };
  const validation = validateSpatialValidationEvidenceV02(evidence);
  if (!validation.ok) {
    throw new Error(
      `spatial-validation-evidence-v0.2 is invalid: ${JSON.stringify(validation.errors)}`,
    );
  }
  return evidence;
}
