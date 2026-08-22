import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  validateCanonicalRenderStateEvidence,
  validateCoronaExecutionPlan,
  validateRenderJobV02,
} from "@ai-archviz/worker-contracts";
import { CoronaRendererAdapter } from "./corona-renderer-adapter.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { planSceneRevision } from "./revision.js";

interface Invocation {
  pid: number;
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolve(repositoryRoot, ".workspace/canonical-render-state-revision-8d");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "worker.config.json");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/living-room-golden");
const baseJobPath = resolve(fixtureRoot, "job-envelope.json");
const existingChangeSets = [
  "move-coffee-table-r2.json",
  "update-window-sill-r3.json",
  "assign-wall-south-material-r4.json",
  "lock-coffee-table-transform-r5.json",
  "unlock-coffee-table-transform-r6.json",
  "move-coffee-table-after-unlock-r7.json",
  "replace-sofa-r8.json",
].map((name) => resolve(fixtureRoot, "changesets", name));
const r9ChangeSetPath = resolve(fixtureRoot, "changesets/set-render-intent-r9.json");
const r10ChangeSetPath = resolve(fixtureRoot, "changesets/add-key-area-light-r10.json");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fileHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function invoke(
  command: string[],
  revisionJobId?: string,
  failureHook?: string,
): Promise<Invocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(process.execPath, [cliPath, ...command], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        AI_ARCHVIZ_WORKER_CONFIG: configPath,
        ...(revisionJobId ? { AI_ARCHVIZ_REVISION_JOB_ID: revisionJobId } : {}),
        ...(failureHook ? { AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE: failureHook } : {}),
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
            `Canonical render-state child returned invalid JSON: ${String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function assertRenderState(
  result: Record<string, unknown>,
  revisionId: string,
  lightCount: number,
): void {
  assert.equal(result.status, "SUCCESS", JSON.stringify(result));
  assert.ok(result.renderStateEvidence, "render-state evidence is required");
  const evidence = result.renderStateEvidence as Record<string, unknown>;
  assert.equal(validateCanonicalRenderStateEvidence(evidence).ok, true);
  assert.equal(evidence.sceneId, "scene_golden_living_001");
  assert.equal(evidence.revisionId, revisionId);
  assert.deepEqual(evidence.render, {
    engine: "corona",
    mode: "preview",
    actualRendererClass: "Corona",
  });
  const lights = evidence.lights as Array<Record<string, unknown>>;
  assert.equal(lights.length, lightCount);
  if (lightCount === 1) {
    assert.deepEqual(lights[0], {
      logicalId: "light_living_key_area",
      type: "area",
      actualClass: "CoronaLight",
      position: [3000, 1600, 2800],
      rotationEuler: [-35, 0, 0],
      canonicalIntensity: 1.25,
      mappedIntensity: 150,
      widthMm: 800,
    });
  }
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  writeJson(configPath, {
    workspaceRoot: relative(repositoryRoot, workspaceRoot).replaceAll("\\", "/"),
    processTimeoutMs: 180_000,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: true,
  });

  try {
    const rev8Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0008/scene-spec.json"));
    const rev9ChangeSet = readJson(r9ChangeSetPath);
    const rev9Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0009/scene-spec.json"));
    const rev10ChangeSet = readJson(r10ChangeSetPath);
    const rev10Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0010/scene-spec.json"));
    assert.equal(validateSceneSpec(rev8Scene).ok, true);
    assert.equal(validateSceneSpec(rev9Scene).ok, true);
    assert.equal(validateSceneSpec(rev10Scene).ok, true);
    assert.deepEqual(planSceneRevision(rev8Scene, rev9ChangeSet).targetSceneSpec, rev9Scene);
    assert.deepEqual(planSceneRevision(rev9Scene, rev10ChangeSet).targetSceneSpec, rev10Scene);

    const base = await invoke(["build-scene", baseJobPath]);
    assert.equal(base.exitCode, 0, `${base.stderr}\n${JSON.stringify(base.result)}`);
    assert.equal(base.result.status, "SUCCESS");
    const rev8Path = base.result.verifiedOutputPath;
    if (typeof rev8Path !== "string") throw new Error("rev8 build returned no verified artifact");
    const rev8Hash = fileHash(rev8Path);

    let latest = base;
    for (const [index, changeSetPath] of existingChangeSets.entries()) {
      latest = await invoke(
        ["apply-change-set", baseJobPath, changeSetPath],
        `job_golden_canonical_render_state_r${index + 2}`,
      );
      assert.equal(latest.exitCode, 0, `${latest.stderr}\n${JSON.stringify(latest.result)}`);
      assert.equal(latest.result.status, "SUCCESS", JSON.stringify(latest.result));
    }
    assert.equal(latest.result.revisionId ?? "rev_golden_0008", "rev_golden_0008");
    assert.equal(fileHash(rev8Path), rev8Hash);

    const rev9 = await invoke(
      ["apply-change-set", baseJobPath, r9ChangeSetPath],
      "job_golden_canonical_render_state_r9",
    );
    assert.equal(rev9.exitCode, 0, rev9.stderr);
    assert.equal(rev9.result.replayed, false);
    assertRenderState(rev9.result, "rev_golden_0009", 0);
    const rev9Path = rev9.result.verifiedOutputPath;
    if (typeof rev9Path !== "string") throw new Error("rev9 returned no verified artifact");
    const rev9Hash = fileHash(rev9Path);
    assert.equal(fileHash(rev8Path), rev8Hash);
    assert.equal((rev9.result.semanticDiff as { unchanged?: unknown[] }).unchanged?.length, 14);

    const rev9Replay = await invoke(
      ["apply-change-set", baseJobPath, r9ChangeSetPath],
      "job_golden_canonical_render_state_r9_replay",
    );
    assert.equal(rev9Replay.exitCode, 0, rev9Replay.stderr);
    assert.equal(rev9Replay.result.replayed, true);
    assert.equal(rev9Replay.result.mutationProcess, null);
    assert.equal(rev9Replay.result.verificationProcess, null);
    assert.equal(rev9Replay.result.renderStateVerificationProcess, null);
    assertRenderState(rev9Replay.result, "rev_golden_0009", 0);
    assert.equal(fileHash(rev9Path), rev9Hash);

    const rev10 = await invoke(
      ["apply-change-set", baseJobPath, r10ChangeSetPath],
      "job_golden_canonical_render_state_r10",
    );
    assert.equal(rev10.exitCode, 0, `${rev10.stderr}\n${JSON.stringify(rev10.result)}`);
    assert.equal(rev10.result.replayed, false);
    assertRenderState(rev10.result, "rev_golden_0010", 1);
    const rev10Path = rev10.result.verifiedOutputPath;
    if (typeof rev10Path !== "string") throw new Error("rev10 returned no verified artifact");
    const rev10Hash = fileHash(rev10Path);
    assert.equal(fileHash(rev8Path), rev8Hash);
    assert.equal(fileHash(rev9Path), rev9Hash);
    assert.equal(JSON.stringify(rev10Scene).includes("preview_key_area"), false);
    assert.equal(JSON.stringify(rev10Scene).includes("AVZ_PREVIEW_CORONA_KEY"), false);
    assert.equal((rev10.result.semanticDiff as { unchanged?: unknown[] }).unchanged?.length, 14);

    const rev10Replay = await invoke(
      ["apply-change-set", baseJobPath, r10ChangeSetPath],
      "job_golden_canonical_render_state_r10_replay",
    );
    assert.equal(rev10Replay.exitCode, 0, rev10Replay.stderr);
    assert.equal(rev10Replay.result.replayed, true);
    assert.equal(rev10Replay.result.mutationProcess, null);
    assert.equal(rev10Replay.result.verificationProcess, null);
    assert.equal(rev10Replay.result.renderStateVerificationProcess, null);
    assertRenderState(rev10Replay.result, "rev_golden_0010", 1);
    assert.equal(fileHash(rev10Path), rev10Hash);

    const renderJob = readJson(resolve(fixtureRoot, "render-job-v0.2-camera-living-a.json"));
    assert.equal(validateRenderJobV02(renderJob).ok, true);
    const plan = new CoronaRendererAdapter().compile(rev10Scene, renderJob);
    assert.equal(validateCoronaExecutionPlan(plan).ok, true);
    assert.equal(plan.revisionId, "rev_golden_0010");
    assert.deepEqual(plan.lights, [
      {
        logicalId: "light_living_key_area",
        type: "area",
        position: [3000, 1600, 2800],
        rotationEuler: [-35, 0, 0],
        canonicalIntensity: 1.25,
        mappedIntensity: 150,
        widthMm: 800,
      },
    ]);

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 8D Canonical Render State Revision",
          status: "PASS",
          targetDccVersion: "2025.3",
          testedDccVersion: rev10.result.dccVersion,
          compatibilityMode: rev10.result.compatibilityMode,
          rev8ArtifactHash: rev8Hash,
          rev9ArtifactHash: rev9Hash,
          rev10ArtifactHash: rev10Hash,
          results: {
            rev9: "SetRenderIntent Corona preview + fresh semantic/render-state verification PASS",
            rev10: "AddLight canonical CoronaLight + fresh semantic/render-state verification PASS",
            light:
              "light_living_key_area, area, [3000,1600,2800], [-35,0,0], 1.25 -> 150, width 800",
            preservation: "rev8 and rev9 artifacts unchanged after later revision",
            replay: "r9/r10 replay returned recorded evidence without mutation or verifier DCC",
            adapter: "rev10 compiled through CoronaRendererAdapter with camera_living_a",
          },
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
