import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { resolveWithinRoot } from "./paths.js";

interface Invocation {
  pid: number;
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

interface ManifestNode {
  logicalId: string;
  materialId?: string;
  assetDefinitionId?: string;
  dimensions?: number[];
  transform?: Record<string, unknown>;
  locks?: Record<string, true>;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/replace-asset-6b");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "replace-asset.worker.config.json");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const baseJobPath = resolve(repositoryRoot, "tests/fixtures/living-room-golden/job-envelope.json");
const moveChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/move-coffee-table-r2.json",
);
const openingChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/update-window-sill-r3.json",
);
const materialChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/assign-wall-south-material-r4.json",
);
const lockChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/lock-coffee-table-transform-r5.json",
);
const blockedMoveChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/move-locked-coffee-table-r6.json",
);
const unlockChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/unlock-coffee-table-transform-r6.json",
);
const moveAfterUnlockChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/move-coffee-table-after-unlock-r7.json",
);
const replaceAssetChangeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/replace-sofa-r8.json",
);
const expectedRev7ManifestPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/revisions/rev_golden_0007/expected-scene-manifest.json",
);
const expectedRev8ManifestPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/revisions/rev_golden_0008/expected-scene-manifest.json",
);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function rawHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function readManifest(workspace: string): ManifestNode[] {
  const manifest = readJson(resolve(workspace, "verification/scene-manifest.json")) as {
    nodes?: ManifestNode[];
  };
  if (!manifest.nodes) throw new Error("Verified manifest has no nodes");
  return manifest.nodes;
}

function nodeById(nodes: ManifestNode[], logicalId: string): ManifestNode {
  const node = nodes.find((entry) => entry.logicalId === logicalId);
  if (!node) throw new Error(`Missing manifest node ${logicalId}`);
  return node;
}

async function invoke(command: string[], revisionJobId?: string): Promise<Invocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(process.execPath, [cliPath, ...command], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        AI_ARCHVIZ_WORKER_CONFIG: configPath,
        ...(revisionJobId ? { AI_ARCHVIZ_REVISION_JOB_ID: revisionJobId } : {}),
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
            `Unlock revision child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
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

  const rev1 = await invoke(["build-scene", baseJobPath]);
  assert.equal(rev1.exitCode, 0);
  assert.equal(rev1.result.status, "SUCCESS");

  const rev2 = await invoke(
    ["apply-change-set", baseJobPath, moveChangeSetPath],
    "job_unlock_revision_r2",
  );
  assert.equal(rev2.exitCode, 0);
  assert.equal(rev2.result.status, "SUCCESS");

  const rev3 = await invoke(
    ["apply-change-set", baseJobPath, openingChangeSetPath],
    "job_unlock_revision_r3",
  );
  assert.equal(rev3.exitCode, 0);
  assert.equal(rev3.result.status, "SUCCESS");

  const rev4 = await invoke(
    ["apply-change-set", baseJobPath, materialChangeSetPath],
    "job_unlock_revision_r4",
  );
  assert.equal(rev4.exitCode, 0);
  assert.equal(rev4.result.status, "SUCCESS");
  if (typeof rev4.result.workspace !== "string") throw new Error("rev0004 workspace missing");
  if (typeof rev4.result.verifiedOutputPath !== "string")
    throw new Error("rev0004 output artifact missing");
  assert.equal(
    nodeById(readManifest(rev4.result.workspace), "wall_south").materialId,
    "material_floor_neutral",
  );
  const rev4HashBefore = rawHash(rev4.result.verifiedOutputPath);

  const rev5 = await invoke(
    ["apply-change-set", baseJobPath, lockChangeSetPath],
    "job_unlock_revision_r5",
  );
  assert.equal(rev5.exitCode, 0);
  assert.equal(rev5.result.status, "SUCCESS");
  assert.equal(rev5.result.replayed, false);
  if (typeof rev5.result.workspace !== "string") throw new Error("rev0005 workspace missing");
  const mutation = readJson(resolve(rev5.result.workspace, "logs/mutation-result.json"));
  assert.equal(mutation.lockedPropertyPath, "transform");
  assert.equal(mutation.deletedWallSegmentCount, 0);
  assert.equal(mutation.createdWallSegmentCount, 0);
  const coffeeTable = nodeById(
    readManifest(rev5.result.workspace),
    "asset_living_coffee_table_main",
  );
  assert.deepEqual(coffeeTable.locks, { transform: true });
  const semanticDiff = rev5.result.semanticDiff as {
    changed?: Array<{ logicalId?: string; changes?: Record<string, unknown> }>;
    added?: unknown[];
    removed?: unknown[];
  };
  assert.equal(semanticDiff.changed?.length, 1);
  assert.equal(semanticDiff.changed?.[0]?.logicalId, "asset_living_coffee_table_main");
  assert.deepEqual(Object.keys(semanticDiff.changed?.[0]?.changes ?? {}), ["locks.transform"]);
  assert.deepEqual(semanticDiff.added, []);
  assert.deepEqual(semanticDiff.removed, []);
  assert.equal(rawHash(rev4.result.verifiedOutputPath), rev4HashBefore);
  if (typeof rev5.result.verifiedOutputPath !== "string")
    throw new Error("rev0005 output artifact missing");
  const rev5HashBefore = rawHash(rev5.result.verifiedOutputPath);

  const blocked = await invoke(
    ["apply-change-set", baseJobPath, blockedMoveChangeSetPath],
    "job_unlock_revision_r6_blocked",
  );
  assert.equal(blocked.exitCode, 1);
  assert.equal(blocked.result.status, "BLOCKED");
  assert.deepEqual(blocked.result.error, {
    code: "TRANSFORM_LOCKED",
    message: "Target asset_living_coffee_table_main transform is locked",
    retryable: false,
  });
  assert.equal(blocked.result.workspace, null);
  assert.equal(blocked.result.dcc, null);
  assert.equal(blocked.result.mutationProcess, null);
  assert.equal(blocked.result.verificationProcess, null);
  assert.equal(blocked.result.verifiedOutputPath, null);
  assert.equal(existsSync(resolve(workspaceRoot, "job_unlock_revision_r6_blocked")), false);

  const rev6 = await invoke(
    ["apply-change-set", baseJobPath, unlockChangeSetPath],
    "job_unlock_revision_r6",
  );
  assert.equal(rev6.exitCode, 0);
  assert.equal(rev6.result.status, "SUCCESS");
  assert.equal(rev6.result.replayed, false);
  if (typeof rev6.result.workspace !== "string") throw new Error("rev0006 workspace missing");
  if (typeof rev6.result.verifiedOutputPath !== "string")
    throw new Error("rev0006 output artifact missing");
  const unlockMutation = readJson(resolve(rev6.result.workspace, "logs/mutation-result.json"));
  assert.equal(unlockMutation.unlockedPropertyPath, "transform");
  assert.equal(unlockMutation.lockedPropertyPath, null);
  assert.deepEqual(
    nodeById(readManifest(rev6.result.workspace), "asset_living_coffee_table_main").locks,
    undefined,
  );
  const unlockDiff = rev6.result.semanticDiff as {
    changed?: Array<{ logicalId?: string; changes?: Record<string, unknown> }>;
    unchanged?: unknown[];
    added?: unknown[];
    removed?: unknown[];
  };
  assert.deepEqual(unlockDiff.changed, [
    {
      logicalId: "asset_living_coffee_table_main",
      changes: { "locks.transform": { before: true, after: false } },
    },
  ]);
  assert.equal(unlockDiff.unchanged?.length, 13);
  assert.deepEqual(unlockDiff.added, []);
  assert.deepEqual(unlockDiff.removed, []);
  assert.equal(rawHash(rev5.result.verifiedOutputPath), rev5HashBefore);
  const rev6HashBefore = rawHash(rev6.result.verifiedOutputPath);

  const rev7 = await invoke(
    ["apply-change-set", baseJobPath, moveAfterUnlockChangeSetPath],
    "job_unlock_revision_r7",
  );
  assert.equal(rev7.exitCode, 0);
  assert.equal(rev7.result.status, "SUCCESS");
  assert.equal(rev7.result.replayed, false);
  if (typeof rev7.result.workspace !== "string") throw new Error("rev0007 workspace missing");
  const movedCoffeeTable = nodeById(
    readManifest(rev7.result.workspace),
    "asset_living_coffee_table_main",
  ) as ManifestNode & { transform?: { position?: number[] } };
  assert.deepEqual(movedCoffeeTable.transform?.position, [3300, 2200, 0]);
  assert.deepEqual(movedCoffeeTable.locks, undefined);
  const moveDiff = rev7.result.semanticDiff as {
    changed?: Array<{ logicalId?: string; changes?: Record<string, unknown> }>;
    unchanged?: unknown[];
    added?: unknown[];
    removed?: unknown[];
  };
  assert.deepEqual(moveDiff.changed, [
    {
      logicalId: "asset_living_coffee_table_main",
      changes: { "transform.position": { before: [3250, 2200, 0], after: [3300, 2200, 0] } },
    },
  ]);
  assert.equal(moveDiff.unchanged?.length, 13);
  assert.deepEqual(moveDiff.added, []);
  assert.deepEqual(moveDiff.removed, []);
  assert.equal(rawHash(rev6.result.verifiedOutputPath), rev6HashBefore);
  if (typeof rev7.result.verifiedOutputPath !== "string")
    throw new Error("rev0007 output artifact missing");
  const rev7Manifest = readJson(resolve(rev7.result.workspace, "verification/scene-manifest.json"));
  assert.deepEqual(rev7Manifest, readJson(expectedRev7ManifestPath));
  const rev7HashBeforeReplacement = rawHash(rev7.result.verifiedOutputPath);

  const rev8 = await invoke(
    ["apply-change-set", baseJobPath, replaceAssetChangeSetPath],
    "job_replace_asset_r8",
  );
  assert.equal(rev8.exitCode, 0);
  assert.equal(rev8.result.status, "SUCCESS");
  assert.equal(rev8.result.replayed, false);
  if (typeof rev8.result.workspace !== "string") throw new Error("rev0008 workspace missing");
  if (typeof rev8.result.verifiedOutputPath !== "string")
    throw new Error("rev0008 output artifact missing");
  const replacementMutation = readJson(resolve(rev8.result.workspace, "logs/mutation-result.json"));
  assert.equal(replacementMutation.replacedAssetDefinitionId, "assetdef_sofa_proxy_alternate_v1");
  assert.equal(replacementMutation.rebuiltHostLogicalId, null);
  assert.equal(replacementMutation.assignedMaterialId, null);
  const rev8Manifest = readJson(resolve(rev8.result.workspace, "verification/scene-manifest.json"));
  assert.deepEqual(rev8Manifest, readJson(expectedRev8ManifestPath));
  const rev7Nodes = readManifest(rev7.result.workspace);
  const rev8Nodes = readManifest(rev8.result.workspace);
  const sofaBefore = nodeById(rev7Nodes, "asset_living_sofa_main");
  const sofaAfter = nodeById(rev8Nodes, "asset_living_sofa_main");
  assert.equal(sofaAfter.logicalId, "asset_living_sofa_main");
  assert.equal(sofaAfter.assetDefinitionId, "assetdef_sofa_proxy_alternate_v1");
  assert.deepEqual(sofaAfter.dimensions, [2200, 900, 760]);
  assert.deepEqual(sofaAfter.transform, sofaBefore.transform);
  assert.equal(sofaAfter.materialId, sofaBefore.materialId);
  assert.deepEqual(sofaAfter.locks, sofaBefore.locks);
  for (const logicalId of ["asset_living_coffee_table_main", "asset_living_tv_unit_main"]) {
    const before = nodeById(rev7Nodes, logicalId);
    const after = nodeById(rev8Nodes, logicalId);
    assert.equal(after.assetDefinitionId, before.assetDefinitionId);
    assert.deepEqual(after.dimensions, before.dimensions);
    assert.deepEqual(after.transform, before.transform);
    assert.equal(after.materialId, before.materialId);
    assert.deepEqual(after.locks, before.locks);
  }
  const replaceDiff = rev8.result.semanticDiff as {
    changed?: Array<{ logicalId?: string; changes?: Record<string, unknown> }>;
    unchanged?: unknown[];
    added?: unknown[];
    removed?: unknown[];
  };
  assert.deepEqual(replaceDiff.changed, [
    {
      logicalId: "asset_living_sofa_main",
      changes: {
        assetDefinitionId: {
          before: "assetdef_sofa_proxy_standard_v1",
          after: "assetdef_sofa_proxy_alternate_v1",
        },
        dimensions: { before: [2400, 950, 780], after: [2200, 900, 760] },
      },
    },
  ]);
  assert.equal(replaceDiff.unchanged?.length, 13);
  assert.deepEqual(replaceDiff.added, []);
  assert.deepEqual(replaceDiff.removed, []);
  assert.equal(rawHash(rev7.result.verifiedOutputPath), rev7HashBeforeReplacement);
  const rev8Hash = rawHash(rev8.result.verifiedOutputPath);

  const unlockReplay = await invoke(
    ["apply-change-set", baseJobPath, unlockChangeSetPath],
    "job_unlock_revision_r6_replay",
  );
  assert.equal(unlockReplay.exitCode, 0);
  assert.equal(unlockReplay.result.status, "SUCCESS");
  assert.equal(unlockReplay.result.replayed, true);
  assert.equal(unlockReplay.result.mutationProcess, null);
  assert.equal(unlockReplay.result.verificationProcess, null);
  assert.equal(unlockReplay.result.verifiedOutputPath, rev6.result.verifiedOutputPath);

  const moveReplay = await invoke(
    ["apply-change-set", baseJobPath, moveAfterUnlockChangeSetPath],
    "job_unlock_revision_r7_replay",
  );
  assert.equal(moveReplay.exitCode, 0);
  assert.equal(moveReplay.result.status, "SUCCESS");
  assert.equal(moveReplay.result.replayed, true);
  assert.equal(moveReplay.result.mutationProcess, null);
  assert.equal(moveReplay.result.verificationProcess, null);
  assert.equal(moveReplay.result.verifiedOutputPath, rev7.result.verifiedOutputPath);

  const replaceReplay = await invoke(
    ["apply-change-set", baseJobPath, replaceAssetChangeSetPath],
    "job_replace_asset_r8_replay",
  );
  assert.equal(replaceReplay.exitCode, 0);
  assert.equal(replaceReplay.result.status, "SUCCESS");
  assert.equal(replaceReplay.result.replayed, true);
  assert.equal(replaceReplay.result.mutationProcess, null);
  assert.equal(replaceReplay.result.verificationProcess, null);
  assert.equal(replaceReplay.result.verifiedOutputPath, rev8.result.verifiedOutputPath);
  assert.equal(rawHash(rev8.result.verifiedOutputPath), rev8Hash);
  assert.equal(rawHash(rev7.result.verifiedOutputPath), rev7HashBeforeReplacement);

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 6B deterministic ReplaceAsset revision",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: rev8.result.dccVersion,
        compatibilityMode: rev8.result.compatibilityMode,
        processIds: {
          rev1Build: rev1.pid,
          rev2Revision: rev2.pid,
          rev3Revision: rev3.pid,
          rev4Revision: rev4.pid,
          rev5Lock: rev5.pid,
          blockedMove: blocked.pid,
          rev6Unlock: rev6.pid,
          rev7Move: rev7.pid,
          rev8ReplaceAsset: rev8.pid,
          rev6UnlockReplay: unlockReplay.pid,
          rev7MoveReplay: moveReplay.pid,
          rev8ReplaceAssetReplay: replaceReplay.pid,
        },
        results: {
          rev4: "verified material revision baseline PASS",
          rev5: "persistent coffee-table transform lock and fresh reopen PASS",
          rev6: "explicit unlock and fresh reopen lock removal PASS",
          rev7: "post-unlock absolute coffee-table move and fresh reopen PASS",
          rev8: "sofa procedural proxy replacement and full fresh reopen PASS",
          unlockDiff: "locks.transform only; 13 unchanged; 0 added; 0 removed",
          moveDiff: "transform.position only; 13 unchanged; 0 added; 0 removed",
          replaceDiff: "assetDefinitionId and dimensions only; 13 unchanged; 0 added; 0 removed",
          baseArtifactPreservation: "rev_golden_0007 hash unchanged after replacement PASS",
          enforcement: "valid locked MoveObject blocked before DCC PASS",
          replay:
            "unlock, move, and replacement replays launched no DCC mutation or verification process PASS",
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
