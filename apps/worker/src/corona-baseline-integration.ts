import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRenderEvidence, validateRenderJob } from "@ai-archviz/worker-contracts";
import {
  type CoronaBaselineConfig,
  coronaBaselineCameraId,
  coronaBaselinePassLimit,
  coronaBaselineResolution,
  renderCoronaBaseline,
} from "./corona-baseline.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolve(repositoryRoot, ".workspace/corona-baseline-8a");
const jobPath = resolve(repositoryRoot, "tests/fixtures/corona-baseline/render-job.json");

interface RenderEvidenceView {
  renderer: { engine: string; className: string; version: string | null };
  dcc: { product: string; version: string; compatibilityMode: boolean };
  camera: { logicalId: string; className: string };
  material: { className: string; baseColorRgb: number[]; targetLogicalId: string };
  light: { logicalId: string; className: string; strategy: string };
  termination: { type: string; value: number };
  resolution: { width: number; height: number };
  output: { format: string; byteLength: number; sha256: string };
}

function config(timeoutMs = 180_000): CoronaBaselineConfig {
  return {
    repositoryRoot,
    workspaceRoot: runRoot,
    processTimeoutMs: timeoutMs,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: true,
  };
}

function fixtureJob(): Record<string, unknown> {
  return JSON.parse(readFileSync(jobPath, "utf8")) as Record<string, unknown>;
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  try {
    const job = fixtureJob();
    assert.equal(validateRenderJob(job).ok, true);

    const blocked = await renderCoronaBaseline({
      config: config(),
      job,
      authorizeDccExecution: false,
    });
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.error?.code, "DCC_EXECUTION_DISABLED");
    assert.equal(blocked.process, null);

    const result = await renderCoronaBaseline({
      config: config(),
      job,
      authorizeDccExecution: true,
    });
    assert.equal(result.status, "PASS", JSON.stringify(result));
    assert.equal(result.error, null);
    assert.ok(result.process?.processId && result.process.processId > 0, "DCC PID is required");
    assert.ok(result.evidence, "normalized render evidence is required");
    assert.equal(validateRenderEvidence(result.evidence).ok, true);
    const evidence = result.evidence as unknown as RenderEvidenceView;
    assert.equal(evidence.renderer.engine, "corona");
    assert.ok(typeof evidence.renderer.className === "string");
    assert.equal(evidence.camera.logicalId, coronaBaselineCameraId);
    assert.equal(evidence.termination.type, "pass_limit");
    assert.equal(evidence.termination.value, coronaBaselinePassLimit);
    assert.deepEqual(evidence.resolution, coronaBaselineResolution);
    assert.equal(evidence.output.format, "png");
    assert.ok(evidence.output.byteLength > 0);
    assert.match(evidence.output.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(evidence).includes(repositoryRoot), false);
    assert.equal(existsSync(runRoot), true);

    const timeoutEnvironment = process.env.AI_ARCHVIZ_TEST_FORCE_CORONA_TIMEOUT;
    process.env.AI_ARCHVIZ_TEST_FORCE_CORONA_TIMEOUT = "1";
    try {
      const timedOut = await renderCoronaBaseline({
        config: config(1_000),
        job,
        authorizeDccExecution: true,
      });
      assert.equal(timedOut.status, "FAILED", JSON.stringify(timedOut));
      assert.equal(timedOut.error?.code, "PROCESS_TIMEOUT");
      assert.equal(timedOut.evidence, null);
      assert.equal(timedOut.process?.timedOut, true);
    } finally {
      if (timeoutEnvironment === undefined) delete process.env.AI_ARCHVIZ_TEST_FORCE_CORONA_TIMEOUT;
      else process.env.AI_ARCHVIZ_TEST_FORCE_CORONA_TIMEOUT = timeoutEnvironment;
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 8A Corona discovery and deterministic baseline render",
          status: "PASS",
          targetDccVersion: "2026",
          testedDccVersion: evidence.dcc.version,
          compatibilityMode: evidence.dcc.compatibilityMode,
          renderer: evidence.renderer,
          material: evidence.material,
          light: evidence.light,
          camera: evidence.camera,
          termination: evidence.termination,
          resolution: evidence.resolution,
          output: evidence.output,
          processId: result.process.processId,
          safeScene: "PASS through command-line locked DCC batch process",
          failureSafety: "timeout produced no PASS evidence and owned process was terminated",
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
