import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCoronaAdapter } from "../../apps/worker/src/corona-adapter-execution.js";
import { renderCoronaBaseline } from "../../apps/worker/src/corona-baseline.js";
import { isDccExecutionAuthorized } from "../../apps/worker/src/dcc-execution-guard.js";
import { buildGoldenScene } from "../../apps/worker/src/golden-build.js";
import { executeGoldenCoronaPreview } from "../../apps/worker/src/golden-corona-preview-execution.js";
import { runThreeDsMaxProbe } from "../../apps/worker/src/probe.js";
import { applySceneChangeSet } from "../../apps/worker/src/revision.js";

const repositoryRoot = resolve(".");
const coronaAdapterFixtureRoot = resolve("tests/fixtures/corona-adapter");
const goldenFixtureRoot = resolve("tests/fixtures/living-room-golden");

function config(allowDccExecution: boolean, workspaceRoot = join(repositoryRoot, ".workspace")) {
  return {
    repositoryRoot,
    workspaceRoot,
    processTimeoutMs: 5_000,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution,
    trustedAssetRoot: null,
  };
}

const disabledCombinations: ReadonlyArray<readonly [boolean, boolean]> = [
  [false, true],
  [true, false],
  [false, false],
];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("uniform default-deny DCC execution guard", () => {
  it("allows execution only when config and call-site authorization are both true", () => {
    expect(
      isDccExecutionAuthorized({ allowDccExecution: false, authorizeDccExecution: true }),
    ).toBe(false);
    expect(
      isDccExecutionAuthorized({ allowDccExecution: true, authorizeDccExecution: false }),
    ).toBe(false);
    expect(
      isDccExecutionAuthorized({ allowDccExecution: false, authorizeDccExecution: false }),
    ).toBe(false);
    expect(isDccExecutionAuthorized({ allowDccExecution: true, authorizeDccExecution: true })).toBe(
      true,
    );
  });

  it("blocks Corona baseline and adapter before discovery for every disabled combination", async () => {
    const baselineJob = {
      renderJobVersion: "0.1.0",
      engine: "corona",
      cameraId: "camera_corona_baseline",
      mode: "preview",
      resolution: { width: 320, height: 240 },
    };
    const adapterScene = readJson(join(coronaAdapterFixtureRoot, "scene-spec.json"));
    const adapterJob = readJson(join(coronaAdapterFixtureRoot, "render-job.json"));
    for (const [allowDccExecution, authorizeDccExecution] of disabledCombinations) {
      const baseline = await renderCoronaBaseline({
        config: config(allowDccExecution),
        job: baselineJob,
        authorizeDccExecution,
      });
      expect(baseline).toMatchObject({
        status: "BLOCKED",
        error: { code: "DCC_EXECUTION_DISABLED" },
        dcc: null,
        process: null,
      });

      const adapter = await executeCoronaAdapter({
        config: config(allowDccExecution),
        sceneSpec: adapterScene,
        renderJob: adapterJob,
        authorizeDccExecution,
        executionEnvironment: { AI_ARCHVIZ_ALLOW_DCC_TESTS: "1" },
      });
      expect(adapter).toMatchObject({
        status: "BLOCKED",
        error: { code: "DCC_EXECUTION_DISABLED" },
        dcc: null,
        process: null,
      });
    }
  });

  it("blocks Golden Corona preview before discovery even when test approval is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-preview-guard-"));
    try {
      const artifactPath = join(root, "verified.max");
      writeFileSync(artifactPath, "verified artifact", "utf8");
      const sceneSpec = readJson(
        join(goldenFixtureRoot, "revisions/rev_golden_0008/scene-spec.json"),
      );
      const expectedManifest = readJson(
        join(goldenFixtureRoot, "revisions/rev_golden_0008/expected-scene-manifest.json"),
      );
      for (const [allowDccExecution, authorizeDccExecution] of disabledCombinations) {
        const result = await executeGoldenCoronaPreview({
          config: config(allowDccExecution, join(root, "workspace")),
          sceneSpec,
          expectedManifest,
          verifiedArtifactPath: artifactPath,
          authorizeDccExecution,
          executionEnvironment: { AI_ARCHVIZ_ALLOW_DCC_TESTS: "1" },
        });
        expect(result).toMatchObject({
          status: "BLOCKED",
          error: { code: "DCC_EXECUTION_DISABLED" },
          dcc: null,
          process: null,
          evidence: null,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks build, revision, and probe without creating a DCC workspace or discovering Max", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-execution-guard-"));
    try {
      for (const [allowDccExecution, authorizeDccExecution] of disabledCombinations) {
        const workerConfig = config(allowDccExecution, join(root, "workspace"));
        const build = await buildGoldenScene(
          workerConfig,
          "tests/fixtures/living-room-golden/job-envelope.json",
          { authorizeDccExecution },
        );
        expect(build).toMatchObject({
          status: "BLOCKED",
          dcc: null,
          buildProcess: null,
          verificationProcess: null,
          error: { code: "DCC_EXECUTION_DISABLED" },
        });
        expect(existsSync(join(root, "workspace"))).toBe(false);

        const revision = await applySceneChangeSet(workerConfig, "not-read.json", "not-read.json", {
          authorizeDccExecution,
        });
        expect(revision).toMatchObject({
          status: "BLOCKED",
          error: { code: "DCC_EXECUTION_DISABLED" },
          dcc: null,
          mutationProcess: null,
          verificationProcess: null,
        });

        const probe = await runThreeDsMaxProbe(workerConfig, { authorizeDccExecution });
        expect(probe).toMatchObject({
          status: "BLOCKED",
          errorCode: "DCC_EXECUTION_DISABLED",
          dcc: null,
          process: null,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
