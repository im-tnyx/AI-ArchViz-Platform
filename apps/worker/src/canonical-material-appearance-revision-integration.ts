import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  validateCanonicalMaterialStateEvidence,
  validateCanonicalRenderStateEvidence,
} from "@ai-archviz/worker-contracts";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { canonicalMaterialStateExpectation, planSceneRevision } from "./revision.js";

interface Invocation {
  pid: number;
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolve(repositoryRoot, ".workspace/canonical-material-appearance-revision-8g");
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
const r11ChangeSetPath = resolve(fixtureRoot, "changesets/migrate-material-appearance-r11.json");

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
  materialFailureHook?: string,
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
        ...(materialFailureHook
          ? { AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: materialFailureHook }
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
            `Canonical material-state child returned invalid JSON: ${String(error)}\n${stdout}\n${stderr}`,
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
  assert.equal(evidence.revisionId, "rev_golden_0011");
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
  assert.equal(result.status, "SUCCESS", JSON.stringify(result));
  assert.ok(result.materialStateEvidence, "material-state evidence is required");
  const evidence = result.materialStateEvidence as Record<string, unknown>;
  assert.equal(validateCanonicalMaterialStateEvidence(evidence).ok, true);
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
    const rev10Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0010/scene-spec.json"));
    const r11ChangeSet = readJson(r11ChangeSetPath);
    const rev11Scene = readJson(resolve(fixtureRoot, "revisions/rev_golden_0011/scene-spec.json"));
    assert.equal(validateSceneChangeSet(r11ChangeSet).ok, true);
    assert.equal(validateSceneSpec(rev10Scene).ok, true);
    assert.equal(validateSceneSpec(rev11Scene).ok, true);
    assert.equal(rev11Scene.sceneSpecVersion, "0.3.0");
    assert.deepEqual(planSceneRevision(rev10Scene, r11ChangeSet).targetSceneSpec, rev11Scene);
    const expectedMaterialState = canonicalMaterialStateExpectation(rev11Scene);
    if (!expectedMaterialState) throw new Error("Expected rev11 material-state oracle is required");

    const base = await invoke(["build-scene", baseJobPath]);
    assert.equal(base.exitCode, 0, `${base.stderr}\n${JSON.stringify(base.result)}`);
    assert.equal(base.result.status, "SUCCESS");
    const rev8Path = base.result.verifiedOutputPath;
    if (typeof rev8Path !== "string") throw new Error("rev8 build returned no verified artifact");

    let latest = base;
    for (const [index, changeSetPath] of existingChangeSets.entries()) {
      latest = await invoke(
        ["apply-change-set", baseJobPath, changeSetPath],
        `job_golden_material_appearance_r${index + 2}`,
      );
      assert.equal(latest.exitCode, 0, `${latest.stderr}\n${JSON.stringify(latest.result)}`);
      assert.equal(latest.result.status, "SUCCESS", JSON.stringify(latest.result));
    }
    const rev8Hash = fileHash(rev8Path);

    const rev9 = await invoke(
      ["apply-change-set", baseJobPath, r9ChangeSetPath],
      "job_golden_material_appearance_r9",
    );
    assert.equal(rev9.exitCode, 0, `${rev9.stderr}\n${JSON.stringify(rev9.result)}`);
    assert.equal(rev9.result.status, "SUCCESS", JSON.stringify(rev9.result));
    const rev9Path = rev9.result.verifiedOutputPath;
    if (typeof rev9Path !== "string") throw new Error("rev9 returned no verified artifact");
    const rev9Hash = fileHash(rev9Path);

    const rev10 = await invoke(
      ["apply-change-set", baseJobPath, r10ChangeSetPath],
      "job_golden_material_appearance_r10",
    );
    assert.equal(rev10.exitCode, 0, `${rev10.stderr}\n${JSON.stringify(rev10.result)}`);
    assert.equal(rev10.result.status, "SUCCESS", JSON.stringify(rev10.result));
    const rev10Path = rev10.result.verifiedOutputPath;
    if (typeof rev10Path !== "string") throw new Error("rev10 returned no verified artifact");
    const rev10Hash = fileHash(rev10Path);

    // 8E must remain untouched: its own rev10/v0.2 canonical preview suite is
    // out of scope here, but rev10's own artifact must not shift underneath it.
    assert.equal(fileHash(rev8Path), rev8Hash);
    assert.equal(fileHash(rev9Path), rev9Hash);

    const rev11 = await invoke(
      ["apply-change-set", baseJobPath, r11ChangeSetPath],
      "job_golden_material_appearance_r11",
    );
    assert.equal(rev11.exitCode, 0, `${rev11.stderr}\n${JSON.stringify(rev11.result)}`);
    assert.equal(rev11.result.replayed, false);
    assertRenderStateUnchanged(rev11.result);
    assertMaterialState(rev11.result, expectedMaterialState);
    const rev11Path = rev11.result.verifiedOutputPath;
    if (typeof rev11Path !== "string") throw new Error("rev11 returned no verified artifact");
    const rev11Hash = fileHash(rev11Path);
    assert.equal(fileHash(rev8Path), rev8Hash);
    assert.equal(fileHash(rev9Path), rev9Hash);
    assert.equal(fileHash(rev10Path), rev10Hash);
    assert.equal(
      (rev11.result.semanticDiff as { changed?: unknown[]; unchanged?: unknown[] }).changed?.length,
      0,
    );
    assert.equal(
      (rev11.result.semanticDiff as { changed?: unknown[]; unchanged?: unknown[] }).unchanged
        ?.length,
      14,
    );

    const rev11Replay = await invoke(
      ["apply-change-set", baseJobPath, r11ChangeSetPath],
      "job_golden_material_appearance_r11_replay",
    );
    assert.equal(rev11Replay.exitCode, 0, rev11Replay.stderr);
    assert.equal(rev11Replay.result.replayed, true);
    assert.equal(rev11Replay.result.mutationProcess, null);
    assert.equal(rev11Replay.result.verificationProcess, null);
    assert.equal(rev11Replay.result.renderStateVerificationProcess, null);
    assert.equal(rev11Replay.result.materialStateVerificationProcess, null);
    assertRenderStateUnchanged(rev11Replay.result);
    assertMaterialState(rev11Replay.result, expectedMaterialState);
    assert.equal(fileHash(rev11Path), rev11Hash);

    // Forced-failure DCC sub-tests: the fresh material-state verifier and the
    // mutation-side realization must fail closed with an explicit code, and
    // must never promote a candidate. Idempotency is keyed by changeSetId
    // content, and rev11 has already succeeded above, so each attempt uses
    // its own distinct changeSetId (same operation/target/materials) to
    // avoid a cached-success replay masking the forced failure.
    const forcedFailureChangeSetPath = (hook: string): string => {
      const variant = readJson(r11ChangeSetPath) as {
        changeSetId: string;
        operations: Array<{ operationId: string }>;
      };
      variant.changeSetId = `chg_migrate_material_appearance_r11_ff_${hook}`;
      const operation = variant.operations[0];
      if (!operation) throw new Error("Migration operation missing");
      operation.operationId = `op_migrate_material_appearance_r11_ff_${hook}`;
      // Must live alongside the tracked changesets: applySceneChangeSet
      // resolves sibling fixture directories (revisions/, etc.) relative to
      // the changeset file's own path.
      const path = resolve(
        fixtureRoot,
        "changesets",
        `migrate-material-appearance-r11-ff-${hook}.json`,
      );
      writeJson(path, variant);
      forcedFailureChangeSetsCreated.push(path);
      return path;
    };
    const expectForcedFailure = async (hook: string, expectedErrorCode: string): Promise<void> => {
      const attempt = await invoke(
        ["apply-change-set", baseJobPath, forcedFailureChangeSetPath(hook)],
        `job_golden_material_appearance_r11_ff_${hook}`,
        hook,
      );
      assert.equal(attempt.result.status, "FAILED", JSON.stringify(attempt.result));
      assert.equal(
        (attempt.result.error as { code?: string } | null)?.code,
        expectedErrorCode,
        JSON.stringify(attempt.result),
      );
      assert.equal(attempt.result.verifiedOutputPath, null, JSON.stringify(attempt.result));
      assert.equal(fileHash(rev10Path), rev10Hash);
    };
    await expectForcedFailure("safe_scene", "SAFE_SCENE_REQUIRED");
    await expectForcedFailure("renderer_missing", "CORONA_NOT_FOUND");
    await expectForcedFailure("material_missing", "CORONA_MATERIAL_CLASS_NOT_FOUND");
    await expectForcedFailure(
      "roughness_property_missing",
      "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED",
    );
    await expectForcedFailure(
      "metalness_property_missing",
      "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED",
    );
    await expectForcedFailure("dedup_failure", "CORONA_MATERIAL_ASSIGNMENT_FAILED");
    await expectForcedFailure("invalid_evidence", "MATERIAL_STATE_EVIDENCE_INVALID");
    await expectForcedFailure("material_state_mismatch", "MATERIAL_STATE_MISMATCH");

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 8G Canonical Material Appearance Revision",
          status: "PASS",
          targetDccVersion: "2025.3",
          testedDccVersion: rev11.result.dccVersion,
          compatibilityMode: rev11.result.compatibilityMode,
          rev8ArtifactHash: rev8Hash,
          rev9ArtifactHash: rev9Hash,
          rev10ArtifactHash: rev10Hash,
          rev11ArtifactHash: rev11Hash,
          results: {
            rev11:
              "MigrateMaterialAppearanceContract + fresh semantic/render-state/material-state verification PASS",
            preservation: "rev8, rev9, and rev10 artifacts unchanged after the r11 migration",
            replay: "r11 replay returned recorded evidence without mutation or verifier DCC",
            deduplication: "materialId-based dedup re-proven in an independent fresh process",
            forcedFailures:
              "safe_scene/renderer_missing/material_missing/roughness/metalness/dedup/invalid_evidence/mismatch all fail closed",
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
