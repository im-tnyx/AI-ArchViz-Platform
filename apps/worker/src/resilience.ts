import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  calculateRequestHash,
  type JobEnvelope,
  semanticJsonHash,
} from "@ai-archviz/worker-contracts";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { readLedger } from "./ledger.js";
import { resolveWithinRoot } from "./paths.js";

interface ChildInvocation {
  pid: number;
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/living-room-golden");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/resilience-1c");
const inputRoot = join(runRoot, "inputs");
const workspaceRoot = join(runRoot, "workspaces");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function materializeJob(
  name: string,
  jobId: string,
  idempotencyKey: string,
  mutateScene?: (scene: Record<string, unknown>) => void,
): string {
  const directory = join(inputRoot, name);
  mkdirSync(directory, { recursive: true });
  const scene = readJson(join(fixtureRoot, "scene-spec.json"));
  const expected = readJson(join(fixtureRoot, "expected-scene-manifest.json"));
  const job = readJson(join(fixtureRoot, "job-envelope.json")) as JobEnvelope;
  mutateScene?.(scene);
  job.jobId = jobId;
  job.idempotencyKey = idempotencyKey;
  job.inputs.sceneSpecHash = semanticJsonHash(scene);
  job.inputs.expectedManifestHash = semanticJsonHash(expected);
  job.requestHash = calculateRequestHash(job);
  writeJson(join(directory, "scene-spec.json"), scene);
  writeJson(join(directory, "expected-scene-manifest.json"), expected);
  writeJson(
    join(directory, "fixture-manifest.json"),
    readJson(join(fixtureRoot, "fixture-manifest.json")),
  );
  const path = join(directory, "job-envelope.json");
  writeJson(path, job);
  return path;
}

function createConfig(name: string, processTimeoutMs: number): string {
  const path = join(runRoot, `${name}.worker.config.json`);
  writeJson(path, {
    workspaceRoot: relative(repositoryRoot, workspaceRoot).replaceAll("\\", "/"),
    processTimeoutMs,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: true,
  });
  return path;
}

async function invoke(
  jobPath: string,
  configPath: string,
  controls: Partial<{
    buildFailure: boolean;
    verificationFailure: boolean;
    manifestMismatch: boolean;
    dccTimeout: boolean;
  }> = {},
): Promise<ChildInvocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(process.execPath, [cliPath, "build-scene", jobPath], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        AI_ARCHVIZ_WORKER_CONFIG: configPath,
        AI_ARCHVIZ_TEST_FORCE_BUILD_FAILURE: controls.buildFailure ? "1" : "0",
        AI_ARCHVIZ_TEST_FORCE_VERIFICATION_FAILURE: controls.verificationFailure ? "1" : "0",
        AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH: controls.manifestMismatch ? "1" : "0",
        AI_ARCHVIZ_TEST_FORCE_DCC_TIMEOUT: controls.dccTimeout ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      try {
        resolveInvocation({
          pid: child.pid ?? -1,
          exitCode,
          result: JSON.parse(stdout) as Record<string, unknown>,
          stderr,
        });
      } catch (error) {
        reject(
          new Error(
            `Worker child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function errorCode(invocation: ChildInvocation): unknown {
  const report = invocation.result.report as { error?: { code?: unknown } } | null;
  const error = invocation.result.error as { code?: unknown } | null;
  return report?.error?.code ?? error?.code;
}

function outputHash(invocation: ChildInvocation): string {
  const workspace = invocation.result.workspace;
  if (typeof workspace !== "string") throw new Error("Successful result has no workspace path");
  return `sha256:${createHash("sha256")
    .update(readFileSync(join(workspace, "output", "project.max")))
    .digest("hex")}`;
}

function semanticCount(invocation: ChildInvocation): number {
  const outputPath = invocation.result.verifiedOutputPath;
  if (typeof outputPath !== "string") {
    throw new Error("Successful result has no verified output path");
  }
  const manifest = readJson(
    join(dirname(dirname(outputPath)), "verification", "scene-manifest.json"),
  ) as { nodes?: unknown[]; cameras?: unknown[] };
  return (manifest.nodes?.length ?? 0) + (manifest.cameras?.length ?? 0);
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(inputRoot, { recursive: true });
  const normalConfig = createConfig("normal", 180_000);
  const timeoutConfig = createConfig("timeout", 45_000);
  const originalKey = "resilience.golden.success.rev_golden_0001";

  const a = await invoke(
    materializeJob("a-success", "job_resilience_a_0001", originalKey),
    normalConfig,
  );
  assert.equal(a.exitCode, 0);
  assert.equal(a.result.status, "SUCCESS");
  assert.equal(a.result.replayed, false);
  assert.ok(a.result.buildProcess);
  assert.ok(a.result.verificationProcess);
  const baselineHash = outputHash(a);
  const baselineManagedNodeCount = semanticCount(a);

  const b = await invoke(
    materializeJob("b-replay", "job_resilience_b_0002", originalKey),
    normalConfig,
  );
  assert.equal(b.exitCode, 0);
  assert.equal(b.result.status, "SUCCESS");
  assert.equal(b.result.replayed, true);
  assert.equal(b.result.originalJobId, "job_resilience_a_0001");
  assert.equal(b.result.currentJobId, "job_resilience_b_0002");
  assert.equal(b.result.buildProcess, null);
  assert.equal(b.result.verificationProcess, null);
  assert.notEqual(a.pid, b.pid);
  assert.equal(outputHash(b), baselineHash);
  assert.equal(semanticCount(b), baselineManagedNodeCount);

  const c = await invoke(
    materializeJob("c-mismatch", "job_resilience_c_0003", originalKey, (scene) => {
      (scene.project as Record<string, unknown>).name = "Valid but different request";
    }),
    normalConfig,
  );
  assert.equal(c.exitCode, 1);
  assert.equal(errorCode(c), "IDEMPOTENCY_KEY_REUSE_MISMATCH");
  assert.equal(c.result.buildProcess, null);
  assert.equal(c.result.verificationProcess, null);
  assert.equal(outputHash(a), baselineHash);

  const d = await invoke(
    materializeJob(
      "d-build-failure",
      "job_resilience_d_0004",
      "resilience.golden.build-failure.rev_golden_0001",
    ),
    normalConfig,
    { buildFailure: true },
  );
  assert.equal(d.exitCode, 1);
  assert.equal(errorCode(d), "BUILD_FAILED");
  assert.equal(d.result.verificationProcess, null);
  assert.equal(outputHash(a), baselineHash);

  const e = await invoke(
    materializeJob(
      "e-verification-failure",
      "job_resilience_e_0005",
      "resilience.golden.verify-failure.rev_golden_0001",
    ),
    normalConfig,
    { verificationFailure: true },
  );
  assert.equal(e.exitCode, 1);
  assert.equal(errorCode(e), "VERIFICATION_FAILED");
  assert.equal(outputHash(a), baselineHash);

  const manifestMismatch = await invoke(
    materializeJob(
      "e2-manifest-mismatch",
      "job_resilience_e2_0006",
      "resilience.golden.manifest-mismatch.rev_golden_0001",
    ),
    normalConfig,
    { manifestMismatch: true },
  );
  assert.equal(manifestMismatch.exitCode, 1);
  assert.equal(errorCode(manifestMismatch), "MANIFEST_MISMATCH");
  assert.equal(outputHash(a), baselineHash);
  assert.equal(
    existsSync(join(String(manifestMismatch.result.workspace), "output", "project.max")),
    false,
  );

  const timeoutKey = "resilience.golden.timeout.rev_golden_0001";
  const f = await invoke(
    materializeJob("f-timeout", "job_resilience_f_0007", timeoutKey),
    timeoutConfig,
    { dccTimeout: true },
  );
  assert.equal(f.exitCode, 1);
  assert.equal(errorCode(f), "PROCESS_TIMEOUT");
  const timedOutLedger = readLedger(workspaceRoot, timeoutKey);
  assert.equal(timedOutLedger?.status, "FAILED_RETRYABLE");
  assert.equal(outputHash(a), baselineHash);

  const g = await invoke(
    materializeJob("g-timeout-retry", "job_resilience_g_0008", timeoutKey),
    normalConfig,
  );
  assert.equal(g.exitCode, 0);
  assert.equal(g.result.status, "SUCCESS");
  assert.equal(g.result.replayed, false);
  assert.equal(readLedger(workspaceRoot, timeoutKey)?.attemptCount, 2);

  const h = await invoke(
    materializeJob("h-restart-replay", "job_resilience_h_0009", timeoutKey),
    normalConfig,
  );
  assert.equal(h.exitCode, 0);
  assert.equal(h.result.replayed, true);
  assert.equal(h.result.buildProcess, null);
  assert.equal(h.result.verificationProcess, null);
  assert.notEqual(g.pid, h.pid);
  assert.equal(outputHash(h), outputHash(g));

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 1C resilience A-H",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: a.result.dccVersion,
        compatibilityMode: a.result.compatibilityMode,
        baselineOutputHash: baselineHash,
        baselineManagedNodeCount,
        processIds: { a: a.pid, b: b.pid, g: g.pid, h: h.pid },
        cases: {
          A: "fresh build and verification PASS",
          B: "fresh-process success replay without DCC PASS",
          C: "key/hash mismatch blocked without DCC PASS",
          D: "forced build failure preserves output PASS",
          E: "forced verification and manifest failures preserve output PASS",
          F: "owned DCC timeout becomes FAILED_RETRYABLE PASS",
          G: "new-job retry succeeds and attemptCount increments PASS",
          H: "fresh-process durable replay without DCC PASS",
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
