import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  semanticJsonHash,
  validateCanonicalCameraStateEvidenceV02,
  validateCanonicalMaterialStateEvidenceV02,
  validateCanonicalRenderStateEvidence,
  validateCirculationRequirementEvidence,
} from "@ai-archviz/worker-contracts";
import { circulationAnalysisEvidence } from "./circulation-analysis.js";
import { circulationRequirementEvidence } from "./circulation-requirement-evidence.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import {
  canonicalCameraStateExpectation,
  canonicalMaterialStateExpectation,
  canonicalRenderStateExpectation,
  planSceneRevision,
} from "./revision.js";

interface Invocation {
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolve(repositoryRoot, ".workspace/canonical-circulation-requirement-9d");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "worker.config.json");
const denyConfigPath = resolve(runRoot, "worker.deny.config.json");
const shortTimeoutConfigPath = resolve(runRoot, "worker.short-timeout.config.json");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/living-room-golden");
const baseJobPath = resolve(fixtureRoot, "job-envelope.json");
const chainChangeSets = [
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
  "set-camera-r12.json",
].map((name) => resolve(fixtureRoot, "changesets", name));
const r13ChangeSetPath = resolve(
  fixtureRoot,
  "changesets/migrate-circulation-requirement-contract-r13.json",
);

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

function batchProcessIds(): number[] {
  // Only 3dsmaxbatch.exe instances are test-owned; interactive 3dsmax.exe sessions are never touched.
  const output = execFileSync(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq 3dsmaxbatch.exe", "/FO", "CSV", "/NH"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return output
    .split(/\r?\n/u)
    .map((line) => line.split('","')[1])
    .filter((value): value is string => typeof value === "string" && /^\d+$/u.test(value))
    .map(Number);
}

async function invoke(
  command: string[],
  options: { jobId?: string; config?: string; env?: Record<string, string> } = {},
): Promise<Invocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(process.execPath, [cliPath, ...command], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        AI_ARCHVIZ_WORKER_CONFIG: options.config ?? configPath,
        ...(options.jobId ? { AI_ARCHVIZ_REVISION_JOB_ID: options.jobId } : {}),
        ...(options.env ?? {}),
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
          exitCode,
          result: JSON.parse(stdout) as Record<string, unknown>,
          stderr,
        });
      } catch (error) {
        reject(
          new Error(`Worker child returned invalid JSON: ${String(error)}\n${stdout}\n${stderr}`),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  const configBase = {
    workspaceRoot: relative(repositoryRoot, workspaceRoot).replaceAll("\\", "/"),
    allowCompatibilityVersionForSpike: true,
  };
  writeJson(configPath, { ...configBase, processTimeoutMs: 180_000, allowDccExecution: true });
  writeJson(denyConfigPath, { ...configBase, processTimeoutMs: 180_000, allowDccExecution: false });
  writeJson(shortTimeoutConfigPath, {
    ...configBase,
    processTimeoutMs: 60_000,
    allowDccExecution: true,
  });
  const batchProcessesBefore = new Set(batchProcessIds());

  const forcedChangeSets: string[] = [];
  try {
    // Pure pre-DCC proofs.
    const rev12Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0012/scene-spec.json"));
    const rev13Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0013/scene-spec.json"));
    const r13ChangeSet = readJson(r13ChangeSetPath);
    assert.equal(validateSceneChangeSet(r13ChangeSet).ok, true);
    const planned = planSceneRevision(rev12Scene, r13ChangeSet);
    assert.deepEqual(planned.targetSceneSpec, rev13Scene);
    assert.equal(planned.plan.revisionPlanVersion, "0.4.0");
    assert.equal(validateSceneSpec(rev13Scene).ok, true);
    assert.equal(rev13Scene.sceneSpecVersion, "0.4.0");
    const expectedCirculation = circulationRequirementEvidence(rev13Scene);
    assert.equal(validateCirculationRequirementEvidence(expectedCirculation).ok, true);
    assert.equal(expectedCirculation.status, "PASS");
    const rev12Graph = circulationAnalysisEvidence(rev12Scene).graphSemanticHash;
    assert.equal(expectedCirculation.graphSemanticHash, rev12Graph);
    const expectedRenderState = canonicalRenderStateExpectation(rev13Scene);
    const expectedMaterialState = canonicalMaterialStateExpectation(rev13Scene);
    const expectedCameraState = canonicalCameraStateExpectation(rev13Scene);
    if (!expectedRenderState || !expectedMaterialState || !expectedCameraState) {
      throw new Error("rev13 render/material/camera oracles are required");
    }
    assert.equal(expectedMaterialState.materialStateVersion, "0.2.0");
    assert.equal(expectedCameraState.cameraStateVersion, "0.2.0");

    // Default-deny: without trusted configuration, nothing launches.
    const denied = await invoke(["apply-change-set", baseJobPath, r13ChangeSetPath], {
      config: denyConfigPath,
      jobId: "job_circulation_revision_r13_denied",
    });
    assert.equal(denied.result.status, "BLOCKED", JSON.stringify(denied.result));
    assert.equal((denied.result.error as { code?: string }).code, "DCC_EXECUTION_DISABLED");
    assert.equal(denied.result.dcc, null);
    assert.equal(denied.result.mutationProcess, null);

    // Real verified chain r1 -> r12.
    const base = await invoke(["build-scene", baseJobPath]);
    assert.equal(base.exitCode, 0, `${base.stderr}\n${JSON.stringify(base.result)}`);
    let latest = base;
    for (const [index, changeSetPath] of chainChangeSets.entries()) {
      latest = await invoke(["apply-change-set", baseJobPath, changeSetPath], {
        jobId: `job_circulation_revision_r${index + 2}`,
      });
      assert.equal(latest.exitCode, 0, `${latest.stderr}\n${JSON.stringify(latest.result)}`);
    }
    assert.equal((latest.result.report as Record<string, unknown>).revisionId, "rev_golden_0012");
    const rev12Path = latest.result.verifiedOutputPath;
    if (typeof rev12Path !== "string") throw new Error("rev12 returned no verified artifact");
    const rev12Hash = fileHash(rev12Path);

    // rev12 -> rev13 migration.
    const rev13 = await invoke(["apply-change-set", baseJobPath, r13ChangeSetPath], {
      jobId: "job_circulation_revision_r13",
    });
    assert.equal(rev13.exitCode, 0, `${rev13.stderr}\n${JSON.stringify(rev13.result)}`);
    assert.equal(rev13.result.status, "SUCCESS");
    assert.equal(rev13.result.replayed, false);
    for (const key of [
      "mutationProcess",
      "verificationProcess",
      "renderStateVerificationProcess",
      "materialStateVerificationProcess",
      "cameraStateVerificationProcess",
    ]) {
      assert.ok(rev13.result[key], `${key} must have run for rev13`);
    }
    const renderEvidence = rev13.result.renderStateEvidence as Record<string, unknown>;
    assert.equal(validateCanonicalRenderStateEvidence(renderEvidence).ok, true);
    assert.deepEqual(renderEvidence, expectedRenderState);
    const materialEvidence = rev13.result.materialStateEvidence as Record<string, unknown>;
    assert.equal(validateCanonicalMaterialStateEvidenceV02(materialEvidence).ok, true);
    assert.deepEqual(materialEvidence, expectedMaterialState);
    const cameraEvidence = rev13.result.cameraStateEvidence as Record<string, unknown>;
    assert.equal(validateCanonicalCameraStateEvidenceV02(cameraEvidence).ok, true);
    assert.deepEqual(cameraEvidence, expectedCameraState);
    const circulationEvidence = rev13.result.circulationRequirementEvidence as Record<
      string,
      unknown
    >;
    assert.deepEqual(circulationEvidence, expectedCirculation);
    assert.equal(circulationEvidence.revisionId, "rev_golden_0013");
    assert.equal(circulationEvidence.sceneSpecHash, semanticJsonHash(rev13Scene));

    const semanticDiff = rev13.result.semanticDiff as {
      changed: unknown[];
      unchanged: unknown[];
      added: unknown[];
      removed: unknown[];
    };
    assert.equal(semanticDiff.changed.length, 0);
    assert.equal(semanticDiff.unchanged.length, 14);
    assert.equal(semanticDiff.added.length, 0);
    assert.equal(semanticDiff.removed.length, 0);

    const workspace = String(rev13.result.workspace);
    const mutationResult = readJson(resolve(workspace, "logs/mutation-result.json"));
    assert.equal(mutationResult.revisionRunnerVersion, "0.4.0");
    assert.equal(mutationResult.circulationRequirementContractMigrated, true);
    assert.equal(mutationResult.circulationRequirementCount, 1);
    assert.equal(
      mutationResult.circulationRequirementSetHash,
      expectedCirculation.requirementSetHash,
    );
    assert.equal(mutationResult.managedNodeCount, 14);
    assert.deepEqual(
      readJson(resolve(workspace, "verification/circulation-requirement-evidence.json")),
      expectedCirculation,
    );
    const rev13Path = rev13.result.verifiedOutputPath;
    if (typeof rev13Path !== "string") throw new Error("rev13 returned no verified artifact");
    const rev13Hash = fileHash(rev13Path);
    assert.equal(fileHash(rev12Path), rev12Hash);

    // Replay: recorded evidence, zero new DCC or verifier processes.
    const replay = await invoke(["apply-change-set", baseJobPath, r13ChangeSetPath], {
      jobId: "job_circulation_revision_r13_replay",
    });
    assert.equal(replay.exitCode, 0, replay.stderr);
    assert.equal(replay.result.replayed, true);
    for (const key of [
      "mutationProcess",
      "verificationProcess",
      "renderStateVerificationProcess",
      "materialStateVerificationProcess",
      "cameraStateVerificationProcess",
    ]) {
      assert.equal(replay.result[key], null, `${key} must not run on replay`);
    }
    assert.deepEqual(replay.result.materialStateEvidence, expectedMaterialState);
    assert.deepEqual(replay.result.cameraStateEvidence, expectedCameraState);
    assert.deepEqual(replay.result.circulationRequirementEvidence, expectedCirculation);
    assert.equal(replay.result.verifiedOutputPath, rev13Path);
    assert.equal(fileHash(rev13Path), rev13Hash);
    assert.equal(fileHash(rev12Path), rev12Hash);

    // Forced failures: each uses a distinct changeSetId so no cached success can mask it.
    const forcedChangeSet = (hook: string): string => {
      const variant = readJson(r13ChangeSetPath) as {
        changeSetId: string;
        operations: Array<{ operationId: string }>;
      };
      variant.changeSetId = `chg_migrate_circulation_r13_ff_${hook}`;
      const operation = variant.operations[0];
      if (!operation) throw new Error("migration operation missing");
      operation.operationId = `op_migrate_circulation_r13_ff_${hook}`;
      const path = resolve(fixtureRoot, "changesets", `migrate-circulation-r13-ff-${hook}.json`);
      writeJson(path, variant);
      forcedChangeSets.push(path);
      return path;
    };
    const failures: Array<{
      hook: string;
      env: Record<string, string>;
      code: string;
      config?: string;
    }> = [
      {
        hook: "unsupported_plan",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_MIGRATION_FAILURE: "unsupported_plan_version" },
        code: "REVISION_PLAN_UNSUPPORTED",
      },
      {
        hook: "wrong_scene_target",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_MIGRATION_FAILURE: "wrong_scene_target" },
        code: "TARGET_NOT_FOUND",
      },
      {
        hook: "managed_id_mismatch",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_MIGRATION_FAILURE: "managed_id_mismatch" },
        code: "MANAGED_ID_SET_MISMATCH",
      },
      {
        hook: "safe_scene",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_MIGRATION_FAILURE: "safe_scene" },
        code: "SAFE_SCENE_REQUIRED",
      },
      {
        hook: "candidate_save",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_MIGRATION_FAILURE: "candidate_save_failure" },
        code: "CANDIDATE_SAVE_FAILED",
      },
      {
        hook: "mutation_timeout",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_MIGRATION_FAILURE: "timeout" },
        code: "PROCESS_TIMEOUT",
        config: shortTimeoutConfigPath,
      },
      {
        hook: "manifest_mismatch",
        env: { AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH: "1" },
        code: "MANIFEST_MISMATCH",
      },
      {
        hook: "render_state",
        env: { AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE: "render_state_mismatch" },
        code: "RENDER_STATE_VERIFICATION_FAILED",
      },
      {
        hook: "material_state_v02",
        env: { AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "material_state_mismatch" },
        code: "MATERIAL_STATE_MISMATCH",
      },
      {
        hook: "camera_state_v02",
        env: { AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: "invalid_evidence" },
        code: "CAMERA_STATE_EVIDENCE_INVALID",
      },
      {
        hook: "circulation_invalid",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_EVIDENCE_FAILURE: "invalid_evidence" },
        code: "CIRCULATION_REQUIREMENT_EVIDENCE_INVALID",
      },
      {
        hook: "circulation_failed",
        env: { AI_ARCHVIZ_TEST_FORCE_CIRCULATION_EVIDENCE_FAILURE: "status_failed" },
        code: "CIRCULATION_REQUIREMENT_EVIDENCE_FAILED",
      },
    ];
    for (const failure of failures) {
      const attempt = await invoke(
        ["apply-change-set", baseJobPath, forcedChangeSet(failure.hook)],
        {
          jobId: `job_circulation_revision_r13_ff_${failure.hook}`,
          env: failure.env,
          ...(failure.config ? { config: failure.config } : {}),
        },
      );
      assert.equal(
        attempt.result.status,
        "FAILED",
        `${failure.hook}: ${JSON.stringify(attempt.result)}`,
      );
      assert.equal(
        (attempt.result.error as { code?: string } | null)?.code,
        failure.code,
        `${failure.hook}: ${JSON.stringify(attempt.result.error)}`,
      );
      assert.equal(attempt.result.verifiedOutputPath, null, failure.hook);
      assert.equal(fileHash(rev12Path), rev12Hash);
      assert.equal(fileHash(rev13Path), rev13Hash);
    }

    const leftover = batchProcessIds().filter((pid) => !batchProcessesBefore.has(pid));
    assert.deepEqual(leftover, [], "no test-owned 3dsmaxbatch process may remain");

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 9D Canonical Circulation Requirement Revision",
          status: "PASS",
          targetDccVersion: "2026",
          testedDccVersion: rev13.result.dccVersion,
          compatibilityMode: rev13.result.compatibilityMode,
          rev12ArtifactHash: rev12Hash,
          rev13ArtifactHash: rev13Hash,
          requirementSetHash: expectedCirculation.requirementSetHash,
          graphSemanticHash: expectedCirculation.graphSemanticHash,
          results: {
            migration:
              "MigrateCirculationRequirementContract (plan 0.4.0) advanced revision metadata only; 14 semantic entries unchanged",
            verification:
              "fresh semantic + render-state v0.1 + material-state v0.2 + camera-state v0.2 PASS; circulation requirement evidence PASS",
            graph: "rev13 graphSemanticHash equals rev12 (requirements add intent, not geometry)",
            preservation: "rev12 artifact unchanged; rev13 unchanged on replay; no rev14",
            replay:
              "r13 replay returned recorded evidence with zero mutation or verifier processes",
            forcedFailures: failures.map((failure) => failure.hook).join(", "),
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
    for (const path of forcedChangeSets) rmSync(path, { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
