import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { safeKeyHash } from "./ledger.js";
import { resolveWithinRoot } from "./paths.js";

interface Invocation {
  pid: number;
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/opening-revision-3");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "opening-revision.worker.config.json");
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function fileHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
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
            `Opening revision child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
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
    "job_opening_chain_revision_r2",
  );
  assert.equal(rev2.exitCode, 0);
  assert.equal(rev2.result.status, "SUCCESS");
  const rev2Path = rev2.result.verifiedOutputPath;
  if (typeof rev2Path !== "string") throw new Error("rev0002 returned no verified output");
  const rev2HashBefore = fileHash(rev2Path);

  const rev3 = await invoke(
    ["apply-change-set", baseJobPath, openingChangeSetPath],
    "job_golden_opening_revision_r3_0001",
  );
  assert.equal(rev3.exitCode, 0);
  assert.equal(rev3.result.status, "SUCCESS");
  assert.equal(rev3.result.replayed, false);
  assert.ok(rev3.result.mutationProcess);
  assert.ok(rev3.result.verificationProcess);
  assert.equal(rev3.result.baseArtifactHash, rev2HashBefore);
  assert.equal(fileHash(rev2Path), rev2HashBefore);
  const rev3Workspace = rev3.result.workspace;
  if (typeof rev3Workspace !== "string") throw new Error("rev0003 returned no workspace");
  const mutation = readJson(resolve(rev3Workspace, "logs/mutation-result.json"));
  assert.equal(mutation.status, "SUCCESS");
  assert.equal(mutation.targetLogicalId, "opening_w01");
  assert.equal(mutation.rebuiltHostLogicalId, "wall_north");
  assert.equal(mutation.deletedWallSegmentCount, 8);
  assert.equal(mutation.createdWallSegmentCount, 8);
  assert.ok(Number(mutation.preservedUnrelatedWallSegmentCount) > 0);

  const semanticDiff = rev3.result.semanticDiff as {
    revision?: { before?: unknown; after?: unknown };
    changed?: Array<{ logicalId?: unknown; changes?: Record<string, unknown> }>;
    unchanged?: unknown[];
    added?: unknown[];
    removed?: unknown[];
  };
  assert.deepEqual(semanticDiff.revision, {
    before: "rev_golden_0002",
    after: "rev_golden_0003",
  });
  assert.equal(semanticDiff.changed?.length, 1);
  assert.equal(semanticDiff.changed?.[0]?.logicalId, "opening_w01");
  assert.deepEqual(Object.keys(semanticDiff.changed?.[0]?.changes ?? {}).sort(), [
    "sill",
    "transform.position",
  ]);
  assert.equal(semanticDiff.unchanged?.length, 13);
  assert.deepEqual(semanticDiff.added, []);
  assert.deepEqual(semanticDiff.removed, []);
  const rev3Path = rev3.result.verifiedOutputPath;
  if (typeof rev3Path !== "string") throw new Error("rev0003 returned no verified output");
  const rev3Hash = fileHash(rev3Path);

  const replay = await invoke(
    ["apply-change-set", baseJobPath, openingChangeSetPath],
    "job_golden_opening_revision_r3_replay_0002",
  );
  assert.equal(replay.exitCode, 0);
  assert.equal(replay.result.status, "SUCCESS");
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.mutationProcess, null);
  assert.equal(replay.result.verificationProcess, null);
  assert.equal(replay.result.originalJobId, "job_golden_opening_revision_r3_0001");
  assert.equal(fileHash(rev3Path), rev3Hash);
  assert.equal(fileHash(rev2Path), rev2HashBefore);

  const ledgerPath = resolve(
    workspaceRoot,
    "idempotency",
    `${safeKeyHash("revision.chg_golden_update_window_sill_r3")}.json`,
  );
  const ledger = readJson(ledgerPath) as {
    status?: unknown;
    attemptCount?: unknown;
    replayJobIds?: unknown[];
  };
  assert.equal(ledger.status, "SUCCESS");
  assert.equal(ledger.attemptCount, 1);
  assert.deepEqual(ledger.replayJobIds, ["job_golden_opening_revision_r3_replay_0002"]);

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 3 deterministic opening revision",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: rev3.result.dccVersion,
        compatibilityMode: rev3.result.compatibilityMode,
        rev2ArtifactHash: rev2HashBefore,
        rev3ArtifactHash: rev3Hash,
        mutation,
        processIds: {
          rev1Build: rev1.pid,
          rev2Revision: rev2.pid,
          rev3Revision: rev3.pid,
          replay: replay.pid,
        },
        results: {
          baseRevision: "verified rev_golden_0002 PASS",
          mutation: "UpdateOpening absolute sill 900 mm PASS",
          northWallRebuild: "8 deleted, 8 created; unrelated segments preserved",
          freshReopen: "full rev_golden_0003 manifest PASS",
          semanticDiff: "opening_w01 only; 13 unchanged; 0 added; 0 removed",
          basePreservation: "rev_golden_0002 hash unchanged",
          replay: "fresh process, no DCC mutation, sill remains 900 mm",
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
