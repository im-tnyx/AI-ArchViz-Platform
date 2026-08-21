import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  validateCoronaExecutionPlan,
  validateRendererRealizationEvidence,
  validateRenderJobV02,
} from "@ai-archviz/worker-contracts";
import {
  type CoronaAdapterExecutionConfig,
  executeCoronaAdapter,
} from "./corona-adapter-execution.js";
import { CoronaRendererAdapter } from "./corona-renderer-adapter.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/corona-adapter");
const runRoot = resolve(repositoryRoot, ".workspace/corona-adapter-8b");

interface EvidenceView {
  renderer: { engine: string; className: string; version: string | null };
  dcc: { product: string; version: string; compatibilityMode: boolean };
  materials: Array<Record<string, unknown>>;
  materialAssignments: Array<{
    targetId: string;
    materialId: string;
    materialInstanceName: string;
    sharedMaterialInstance: boolean;
  }>;
  lights: Array<Record<string, unknown>>;
  camera: { logicalId: string; lookAtTarget: boolean };
  render: { termination: { value: number }; resolution: { width: number; height: number } };
  output: { byteLength: number; sha256: string };
}

function requireDccTestApproval(): void {
  if (process.env.AI_ARCHVIZ_ALLOW_DCC_TESTS !== "1") {
    throw new Error(
      "AI_ARCHVIZ_ALLOW_DCC_TESTS=1 is required before running a DCC integration suite",
    );
  }
}

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), "utf8")) as Record<string, unknown>;
}

function config(timeoutMs = 180_000): CoronaAdapterExecutionConfig {
  return {
    repositoryRoot,
    workspaceRoot: runRoot,
    processTimeoutMs: timeoutMs,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
  };
}

async function expectTrustedFailure(
  sceneSpec: Record<string, unknown>,
  renderJob: Record<string, unknown>,
  hook: string,
  expectedCode: string,
  timeoutMs = 180_000,
): Promise<void> {
  const result = await executeCoronaAdapter({
    config: config(timeoutMs),
    sceneSpec,
    renderJob,
    authorizeDccExecution: true,
    executionEnvironment: {
      ...process.env,
      AI_ARCHVIZ_TEST_FORCE_CORONA_ADAPTER_FAILURE: hook,
    },
  });
  assert.equal(result.status, "FAILED", `${hook}: ${JSON.stringify(result)}`);
  assert.equal(result.error?.code, expectedCode, `${hook}: ${JSON.stringify(result)}`);
  assert.equal(result.evidence, null, `${hook} must not emit PASS evidence`);
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  try {
    const sceneSpec = readJson("scene-spec.json");
    const renderJob = readJson("render-job.json");
    const expectedPlan = readJson("expected-plan.json");
    assert.equal(validateSceneSpec(sceneSpec).ok, true);
    assert.equal(validateRenderJobV02(renderJob).ok, true);
    const plan = new CoronaRendererAdapter().compile(sceneSpec, renderJob);
    assert.deepEqual(plan, expectedPlan);
    assert.equal(validateCoronaExecutionPlan(plan).ok, true);

    const blocked = await executeCoronaAdapter({
      config: config(),
      sceneSpec,
      renderJob,
      authorizeDccExecution: false,
    });
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.error?.code, "DCC_EXECUTION_DISABLED");
    assert.equal(blocked.process, null);

    const result = await executeCoronaAdapter({
      config: config(),
      sceneSpec,
      renderJob,
      authorizeDccExecution: true,
    });
    assert.equal(result.status, "PASS", JSON.stringify(result));
    assert.equal(result.error, null);
    assert.ok(result.process?.processId && result.process.processId > 0, "DCC PID is required");
    assert.ok(result.evidence, "realization evidence is required");
    assert.equal(validateRendererRealizationEvidence(result.evidence).ok, true);
    const evidence = result.evidence as unknown as EvidenceView;
    assert.equal(evidence.renderer.engine, "corona");
    assert.equal(evidence.camera.logicalId, "camera_adapter_main");
    assert.equal(evidence.camera.lookAtTarget, true);
    assert.equal(evidence.render.termination.value, 4);
    assert.deepEqual(evidence.render.resolution, { width: 320, height: 240 });
    assert.ok(evidence.output.byteLength > 0);
    assert.match(evidence.output.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(evidence).includes(repositoryRoot), false);
    const wallAssignments = evidence.materialAssignments.filter(
      (entry) => entry.materialId === "material_adapter_wall",
    );
    assert.equal(wallAssignments.length, 2);
    const firstWallAssignment = wallAssignments[0];
    const secondWallAssignment = wallAssignments[1];
    assert.ok(firstWallAssignment);
    assert.ok(secondWallAssignment);
    assert.equal(
      firstWallAssignment.materialInstanceName,
      secondWallAssignment.materialInstanceName,
    );
    assert.ok(wallAssignments.every((entry) => entry.sharedMaterialInstance));

    await expectTrustedFailure(sceneSpec, renderJob, "renderer_missing", "CORONA_NOT_FOUND");
    await expectTrustedFailure(
      sceneSpec,
      renderJob,
      "material_missing",
      "CORONA_MATERIAL_CLASS_NOT_FOUND",
    );
    await expectTrustedFailure(
      sceneSpec,
      renderJob,
      "light_missing",
      "CORONA_LIGHT_CLASS_NOT_FOUND",
    );
    await expectTrustedFailure(
      sceneSpec,
      renderJob,
      "property_missing",
      "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
    );
    await expectTrustedFailure(sceneSpec, renderJob, "safe_scene", "SAFE_SCENE_REQUIRED");
    await expectTrustedFailure(
      sceneSpec,
      renderJob,
      "invalid_evidence",
      "RENDERER_REALIZATION_EVIDENCE_INVALID",
    );
    await expectTrustedFailure(sceneSpec, renderJob, "png_invalid", "RENDER_OUTPUT_INVALID");
    await expectTrustedFailure(sceneSpec, renderJob, "timeout", "PROCESS_TIMEOUT", 1_000);

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 8B Corona renderer adapter",
          status: "PASS",
          targetDccVersion: "2026",
          testedDccVersion: evidence.dcc.version,
          compatibilityMode: evidence.dcc.compatibilityMode,
          renderer: evidence.renderer,
          materials: evidence.materials,
          lights: evidence.lights,
          camera: evidence.camera,
          render: evidence.render,
          output: evidence.output,
          processId: result.process.processId,
          safeScene: "PASS through command-line locked DCC batch process",
          failures:
            "renderer/material/light/property/Safe Scene/evidence/PNG/timeout all produced no PASS evidence",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
