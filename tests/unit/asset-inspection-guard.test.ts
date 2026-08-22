import { describe, expect, it } from "vitest";
import { inspectExternalMaxArtifact } from "../../apps/worker/src/asset-inspection.js";

describe("isolated external asset inspection guard", () => {
  it("does not resolve or launch DCC unless both capabilities are true", async () => {
    for (const { allowDccExecution, authorizeDccExecution } of [
      { allowDccExecution: false, authorizeDccExecution: true },
      { allowDccExecution: true, authorizeDccExecution: false },
      { allowDccExecution: false, authorizeDccExecution: false },
    ]) {
      const result = await inspectExternalMaxArtifact({
        config: {
          repositoryRoot: "C:/repo",
          workspaceRoot: "C:/repo/.workspace",
          processTimeoutMs: 5_000,
          threeDsMaxInstallationPath: null,
          allowCompatibilityVersionForSpike: true,
          allowDccExecution,
        },
        registry: { records: [] },
        job: {
          inspectionJobVersion: "0.1.0",
          artifactId: "artifact_guard_test",
          artifactSha256: `sha256:${"a".repeat(64)}`,
          format: "3ds_max",
        },
        trustedAssetRoot: "C:/trusted-assets",
        authorizeDccExecution,
      });

      expect(result).toMatchObject({
        status: "BLOCKED",
        failureCode: "DCC_EXECUTION_DISABLED",
        dcc: null,
        process: null,
      });
    }
  });
});
