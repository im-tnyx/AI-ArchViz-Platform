import { validateSpatialScene } from "@ai-archviz/spatial-engine";
import { type SpatialValidationEvidence, semanticJsonHash } from "@ai-archviz/worker-contracts";

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
