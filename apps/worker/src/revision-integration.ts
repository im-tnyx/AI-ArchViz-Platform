import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeKeyHash } from "./ledger.js";
import { resolveWithinRoot } from "./paths.js";

interface Invocation {
  pid: number;
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/revision-2");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "revision.worker.config.json");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const baseJobPath = resolve(repositoryRoot, "tests/fixtures/living-room-golden/job-envelope.json");
const changeSetPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/changesets/move-coffee-table-r2.json",
);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
            `Revision child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
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

  const base = await invoke(["build-scene", baseJobPath]);
  assert.equal(base.exitCode, 0);
  assert.equal(base.result.status, "SUCCESS");
  assert.equal(base.result.replayed, false);
  const basePath = base.result.verifiedOutputPath;
  if (typeof basePath !== "string") throw new Error("Base build returned no verified output");
  const baseHashBefore = fileHash(basePath);

  const revision = await invoke(
    ["apply-change-set", baseJobPath, changeSetPath],
    "job_golden_revision_r2_0001",
  );
  assert.equal(revision.exitCode, 0);
  assert.equal(revision.result.status, "SUCCESS");
  assert.equal(revision.result.replayed, false);
  assert.ok(revision.result.mutationProcess);
  assert.ok(revision.result.verificationProcess);
  assert.equal(revision.result.baseArtifactHash, baseHashBefore);
  assert.equal(fileHash(basePath), baseHashBefore);
  const semanticDiff = revision.result.semanticDiff as {
    revision?: { before?: unknown; after?: unknown };
    changed?: Array<{ logicalId?: unknown; changes?: Record<string, unknown> }>;
    unchanged?: unknown[];
    added?: unknown[];
    removed?: unknown[];
  };
  assert.deepEqual(semanticDiff.revision, {
    before: "rev_golden_0001",
    after: "rev_golden_0002",
  });
  assert.equal(semanticDiff.changed?.length, 1);
  assert.equal(semanticDiff.changed?.[0]?.logicalId, "asset_living_coffee_table_main");
  assert.deepEqual(Object.keys(semanticDiff.changed?.[0]?.changes ?? {}), ["transform.position"]);
  assert.equal(semanticDiff.unchanged?.length, 13);
  assert.deepEqual(semanticDiff.added, []);
  assert.deepEqual(semanticDiff.removed, []);
  const revisionOutputPath = revision.result.verifiedOutputPath;
  if (typeof revisionOutputPath !== "string") throw new Error("Revision returned no output");
  const revisionHash = fileHash(revisionOutputPath);

  const replay = await invoke(
    ["apply-change-set", baseJobPath, changeSetPath],
    "job_golden_revision_r2_replay_0002",
  );
  assert.equal(replay.exitCode, 0);
  assert.equal(replay.result.status, "SUCCESS");
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.mutationProcess, null);
  assert.equal(replay.result.verificationProcess, null);
  assert.equal(replay.result.originalJobId, "job_golden_revision_r2_0001");
  assert.equal(replay.result.currentJobId, "job_golden_revision_r2_replay_0002");
  assert.equal(fileHash(revisionOutputPath), revisionHash);
  assert.equal(fileHash(basePath), baseHashBefore);
  assert.notEqual(revision.pid, replay.pid);

  const revisionLedgerPath = resolve(
    workspaceRoot,
    "idempotency",
    `${safeKeyHash("revision.chg_golden_move_coffee_table_r2")}.json`,
  );
  const ledger = JSON.parse(readFileSync(revisionLedgerPath, "utf8")) as {
    status?: unknown;
    attemptCount?: unknown;
    replayJobIds?: unknown[];
  };
  assert.equal(ledger.status, "SUCCESS");
  assert.equal(ledger.attemptCount, 1);
  assert.deepEqual(ledger.replayJobIds, ["job_golden_revision_r2_replay_0002"]);

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 2 deterministic revision",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: revision.result.dccVersion,
        compatibilityMode: revision.result.compatibilityMode,
        baseArtifactHash: baseHashBefore,
        revisionArtifactHash: revisionHash,
        managedSemanticCount: 14,
        processIds: {
          baseBuild: base.pid,
          revision: revision.pid,
          replay: replay.pid,
        },
        results: {
          baseRevision: "rev_golden_0001 verified",
          mutation: "MoveObject absolute transform PASS",
          freshReopen: "full rev_golden_0002 manifest PASS",
          semanticDiff: "1 changed, 13 unchanged, 0 added, 0 removed",
          basePreservation: "rev_golden_0001 hash unchanged",
          replay: "fresh process, no DCC mutation, artifact unchanged",
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
