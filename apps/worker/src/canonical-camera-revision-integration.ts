import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  validateCanonicalCameraStateEvidence,
  validateCanonicalMaterialStateEvidence,
  validateCanonicalRenderStateEvidence,
} from "@ai-archviz/worker-contracts";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import {
  canonicalCameraStateExpectation,
  canonicalMaterialStateExpectation,
  planSceneRevision,
} from "./revision.js";

interface Invocation {
  pid: number;
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolve(repositoryRoot, ".workspace/canonical-camera-revision-8i");
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
  "set-render-intent-r9.json",
  "add-key-area-light-r10.json",
  "migrate-material-appearance-r11.json",
].map((name) => resolve(fixtureRoot, "changesets", name));
const r12ChangeSetPath = resolve(fixtureRoot, "changesets/set-camera-r12.json");

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
  cameraFailureHook?: string,
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
        ...(cameraFailureHook
          ? { AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: cameraFailureHook }
          : {}),
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
            `Canonical camera-state child returned invalid JSON: ${String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function assertRenderStateUnchanged(result: Record<string, unknown>): void {
  assert.ok(
    result.renderStateEvidence,
    `render-state evidence is required: ${JSON.stringify(result)}`,
  );
  const evidence = result.renderStateEvidence as Record<string, unknown>;
  assert.equal(validateCanonicalRenderStateEvidence(evidence).ok, true);
  assert.equal(evidence.revisionId, "rev_golden_0012");
  assert.deepEqual(evidence.render, {
    engine: "corona",
    mode: "preview",
    actualRendererClass: "Corona",
  });
  const lights = evidence.lights as Array<Record<string, unknown>>;
  assert.equal(lights.length, 1);
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

function assertMaterialState(
  result: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  assert.ok(result.materialStateEvidence, "material-state evidence is required");
  const evidence = result.materialStateEvidence as Record<string, unknown>;
  assert.equal(validateCanonicalMaterialStateEvidence(evidence).ok, true);
  assert.deepEqual(evidence, expected);
}

function assertCameraState(
  result: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  assert.equal(result.status, "SUCCESS", JSON.stringify(result));
  assert.ok(result.cameraStateEvidence, "camera-state evidence is required");
  const evidence = result.cameraStateEvidence as Record<string, unknown>;
  assert.equal(validateCanonicalCameraStateEvidence(evidence).ok, true);
  assert.deepEqual(evidence, expected);
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

  const forcedFailureChangeSetsCreated: string[] = [];
  try {
    const rev11Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0011/scene-spec.json"));
    const r12ChangeSet = readJson(r12ChangeSetPath);
    const rev12Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0012/scene-spec.json"));
    assert.equal(validateSceneChangeSet(r12ChangeSet).ok, true);
    assert.equal(validateSceneSpec(rev11Scene).ok, true);
    assert.equal(validateSceneSpec(rev12Scene).ok, true);
    assert.equal(rev12Scene.sceneSpecVersion, "0.3.0");
    assert.deepEqual(planSceneRevision(rev11Scene, r12ChangeSet).targetSceneSpec, rev12Scene);
    const expectedMaterialState = canonicalMaterialStateExpectation(rev12Scene);
    if (!expectedMaterialState) throw new Error("Expected rev12 material-state oracle is required");
    const expectedCameraState = canonicalCameraStateExpectation(rev12Scene);
    if (!expectedCameraState) throw new Error("Expected rev12 camera-state oracle is required");
    const cameraA = (expectedCameraState.cameras as Array<Record<string, unknown>>).find(
      (camera) => camera.logicalId === "camera_living_a",
    );
    assert.ok(cameraA, "camera_living_a evidence oracle is required");
    assert.equal(cameraA?.focalLengthMm, 28);
    assert.equal(cameraA?.sensorWidthMm, 36);
    assert.ok(Math.abs((cameraA?.expectedFovRadians as number) - 1.1426749596672536) < 1e-9);

    const base = await invoke(["build-scene", baseJobPath]);
    assert.equal(base.exitCode, 0, `${base.stderr}\n${JSON.stringify(base.result)}`);
    assert.equal(base.result.status, "SUCCESS");
    const rev8Path = base.result.verifiedOutputPath;
    if (typeof rev8Path !== "string") throw new Error("rev8 build returned no verified artifact");

    let latest = base;
    for (const [index, changeSetPath] of existingChangeSets.entries()) {
      latest = await invoke(
        ["apply-change-set", baseJobPath, changeSetPath],
        `job_golden_camera_revision_r${index + 2}`,
      );
      assert.equal(latest.exitCode, 0, `${latest.stderr}\n${JSON.stringify(latest.result)}`);
      assert.equal(latest.result.status, "SUCCESS", JSON.stringify(latest.result));
    }
    assert.equal(
      (latest.result.report as Record<string, unknown> | null)?.revisionId,
      "rev_golden_0011",
    );
    const rev11Path = latest.result.verifiedOutputPath;
    if (typeof rev11Path !== "string") throw new Error("rev11 returned no verified artifact");
    const rev11Hash = fileHash(rev11Path);

    const rev12 = await invoke(
      ["apply-change-set", baseJobPath, r12ChangeSetPath],
      "job_golden_camera_revision_r12",
    );
    assert.equal(rev12.exitCode, 0, `${rev12.stderr}\n${JSON.stringify(rev12.result)}`);
    assert.equal(rev12.result.replayed, false);
    assertRenderStateUnchanged(rev12.result);
    assertMaterialState(rev12.result, expectedMaterialState);
    assertCameraState(rev12.result, expectedCameraState);
    const rev12Path = rev12.result.verifiedOutputPath;
    if (typeof rev12Path !== "string") throw new Error("rev12 returned no verified artifact");
    const rev12Hash = fileHash(rev12Path);
    assert.equal(fileHash(rev11Path), rev11Hash);

    const semanticDiff = rev12.result.semanticDiff as {
      changed?: Array<{ logicalId: string; changes: Record<string, unknown> }>;
      unchanged?: unknown[];
      added?: unknown[];
      removed?: unknown[];
    };
    assert.equal(semanticDiff.changed?.length, 1);
    assert.equal(semanticDiff.changed?.[0]?.logicalId, "camera_living_a");
    assert.deepEqual(Object.keys(semanticDiff.changed?.[0]?.changes ?? {}).sort(), [
      "focalLengthMm",
      "transform.rotationEuler",
    ]);
    assert.equal(semanticDiff.unchanged?.length, 13);
    assert.equal(semanticDiff.added?.length, 0);
    assert.equal(semanticDiff.removed?.length, 0);

    const rev12Replay = await invoke(
      ["apply-change-set", baseJobPath, r12ChangeSetPath],
      "job_golden_camera_revision_r12_replay",
    );
    assert.equal(rev12Replay.exitCode, 0, rev12Replay.stderr);
    assert.equal(rev12Replay.result.replayed, true);
    assert.equal(rev12Replay.result.mutationProcess, null);
    assert.equal(rev12Replay.result.verificationProcess, null);
    assert.equal(rev12Replay.result.renderStateVerificationProcess, null);
    assert.equal(rev12Replay.result.materialStateVerificationProcess, null);
    assert.equal(rev12Replay.result.cameraStateVerificationProcess, null);
    assertRenderStateUnchanged(rev12Replay.result);
    assertMaterialState(rev12Replay.result, expectedMaterialState);
    assertCameraState(rev12Replay.result, expectedCameraState);
    assert.equal(fileHash(rev12Path), rev12Hash);

    // Forced-failure DCC sub-tests: idempotency is keyed by changeSetId
    // content and rev12 has already succeeded above, so each attempt uses
    // its own distinct changeSetId (same operation/target/parameters) to
    // avoid a cached-success replay masking the forced failure.
    const forcedFailureChangeSetPath = (hook: string): string => {
      const variant = readJson(r12ChangeSetPath) as {
        changeSetId: string;
        operations: Array<{ operationId: string }>;
      };
      variant.changeSetId = `chg_set_camera_r12_ff_${hook}`;
      const operation = variant.operations[0];
      if (!operation) throw new Error("SetCamera operation missing");
      operation.operationId = `op_set_camera_r12_ff_${hook}`;
      // Must live alongside the tracked changesets: applySceneChangeSet
      // resolves sibling fixture directories (revisions/, etc.) relative to
      // the changeset file's own path.
      const path = resolve(fixtureRoot, "changesets", `set-camera-r12-ff-${hook}.json`);
      writeJson(path, variant);
      forcedFailureChangeSetsCreated.push(path);
      return path;
    };
    const expectForcedFailure = async (hook: string, expectedErrorCode: string): Promise<void> => {
      const attempt = await invoke(
        ["apply-change-set", baseJobPath, forcedFailureChangeSetPath(hook)],
        `job_golden_camera_revision_r12_ff_${hook}`,
        hook,
      );
      assert.equal(attempt.result.status, "FAILED", JSON.stringify(attempt.result));
      assert.equal(
        (attempt.result.error as { code?: string } | null)?.code,
        expectedErrorCode,
        JSON.stringify(attempt.result),
      );
      assert.equal(attempt.result.verifiedOutputPath, null, JSON.stringify(attempt.result));
      assert.equal(fileHash(rev11Path), rev11Hash);
    };
    await expectForcedFailure("camera_missing", "CAMERA_NOT_FOUND");
    await expectForcedFailure("camera_wrong_class", "CAMERA_NOT_FOUND");
    await expectForcedFailure("position_write_failure", "CAMERA_REALIZATION_FAILED");
    await expectForcedFailure("rotation_write_failure", "CAMERA_REALIZATION_FAILED");
    await expectForcedFailure("target_distance_write_failure", "CAMERA_REALIZATION_FAILED");
    await expectForcedFailure("fov_write_failure", "CAMERA_REALIZATION_FAILED");
    await expectForcedFailure("safe_scene", "SAFE_SCENE_REQUIRED");
    await expectForcedFailure("fov_regression", "CAMERA_FOV_MISMATCH");
    await expectForcedFailure("orientation_mismatch", "CAMERA_ORIENTATION_MISMATCH");
    await expectForcedFailure("target_mismatch", "CAMERA_TARGET_MISMATCH");
    await expectForcedFailure("invalid_evidence", "CAMERA_STATE_EVIDENCE_INVALID");

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 8I Canonical Camera Revision",
          status: "PASS",
          targetDccVersion: "2025.3",
          testedDccVersion: rev12.result.dccVersion,
          compatibilityMode: rev12.result.compatibilityMode,
          rev11ArtifactHash: rev11Hash,
          rev12ArtifactHash: rev12Hash,
          results: {
            rev12:
              "SetCamera (24mm -> 28mm) + fresh semantic/render-state/material-state/camera-state verification PASS",
            camera: "camera_living_a resolved and mutated in place; identity, B, and C preserved",
            fov: "Camera.fov written in degrees; observed FOV ~65.47deg / ~1.1427rad within tolerance",
            preservation: "rev11 artifact unchanged after the r12 revision; no rev13 created",
            replay: "r12 replay returned recorded evidence without mutation or verifier DCC",
            forcedFailures:
              "camera missing/wrong-class/position/rotation/targetDistance/FOV write, Safe Scene, FOV regression, orientation mismatch, target mismatch, and invalid evidence all fail closed",
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
    for (const path of forcedFailureChangeSetsCreated) {
      rmSync(path, { force: true });
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
