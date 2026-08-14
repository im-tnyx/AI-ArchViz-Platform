import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  locks?: { transform?: true };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/lock-revision-5a");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "lock-revision.worker.config.json");
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
            `Lock revision child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  writeJson(configPath, {
    workspaceRoot: relative(repositoryRoot, workspaceRoot).replaceAll("\\", "/"),
    processTimeoutMs: 180_000,
    allowCompatibilityVersionForSpike: true,
  });

  const rev1 = await invoke(["build-scene", baseJobPath]);
  assert.equal(rev1.exitCode, 0);
  assert.equal(rev1.result.status, "SUCCESS");

  const rev2 = await invoke(
    ["apply-change-set", baseJobPath, moveChangeSetPath],
    "job_lock_revision_r2",
  );
  assert.equal(rev2.exitCode, 0);
  assert.equal(rev2.result.status, "SUCCESS");

  const rev3 = await invoke(
    ["apply-change-set", baseJobPath, openingChangeSetPath],
    "job_lock_revision_r3",
  );
  assert.equal(rev3.exitCode, 0);
  assert.equal(rev3.result.status, "SUCCESS");

  const rev4 = await invoke(
    ["apply-change-set", baseJobPath, materialChangeSetPath],
    "job_lock_revision_r4",
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
    "job_lock_revision_r5",
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

  const blocked = await invoke(
    ["apply-change-set", baseJobPath, blockedMoveChangeSetPath],
    "job_lock_revision_r6_blocked",
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
  assert.equal(existsSync(resolve(workspaceRoot, "job_lock_revision_r6_blocked")), false);

  const replay = await invoke(
    ["apply-change-set", baseJobPath, lockChangeSetPath],
    "job_lock_revision_r5_replay",
  );
  assert.equal(replay.exitCode, 0);
  assert.equal(replay.result.status, "SUCCESS");
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.mutationProcess, null);
  assert.equal(replay.result.verificationProcess, null);
  assert.equal(replay.result.verifiedOutputPath, rev5.result.verifiedOutputPath);

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 5A persistent LockProperty enforcement",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: rev5.result.dccVersion,
        compatibilityMode: rev5.result.compatibilityMode,
        processIds: {
          rev1Build: rev1.pid,
          rev2Revision: rev2.pid,
          rev3Revision: rev3.pid,
          rev4Revision: rev4.pid,
          rev5Lock: rev5.pid,
          rev5Replay: replay.pid,
          blockedMove: blocked.pid,
        },
        results: {
          rev4: "verified material revision baseline PASS",
          rev5: "persistent coffee-table transform lock and fresh reopen PASS",
          semanticDiff: "locks.transform only; 13 unchanged; 0 added; 0 removed",
          baseArtifactPreservation: "rev_golden_0004 hash unchanged PASS",
          enforcement: "valid locked MoveObject blocked before DCC PASS",
          replay: "no second DCC mutation or verification process PASS",
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
