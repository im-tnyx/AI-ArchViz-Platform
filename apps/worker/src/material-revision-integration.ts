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
  materialBaseColorRgb?: number[];
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/material-revision-4b");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "material-revision.worker.config.json");
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

function assertColor(actual: number[] | undefined, expected: number[]): void {
  assert.ok(actual);
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    assert.ok(Math.abs((actual[index] as number) - (expected[index] as number)) <= 0.01);
  }
}

function assertMaterial(
  nodes: ManifestNode[],
  logicalId: string,
  materialId: string,
  color: number[],
): void {
  const node = nodes.find((entry) => entry.logicalId === logicalId);
  assert.ok(node, `Missing material node ${logicalId}`);
  assert.equal(node.materialId, materialId);
  assertColor(node.materialBaseColorRgb, color);
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
            `Material revision child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
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
    "job_material_revision_r2",
  );
  assert.equal(rev2.exitCode, 0);
  assert.equal(rev2.result.status, "SUCCESS");

  const rev3 = await invoke(
    ["apply-change-set", baseJobPath, openingChangeSetPath],
    "job_material_revision_r3",
  );
  assert.equal(rev3.exitCode, 0);
  assert.equal(rev3.result.status, "SUCCESS");
  if (typeof rev3.result.workspace !== "string") throw new Error("rev0003 workspace missing");
  if (typeof rev3.result.verifiedOutputPath !== "string")
    throw new Error("rev0003 output artifact missing");
  const rev3Manifest = readManifest(rev3.result.workspace);
  assertMaterial(
    rev3Manifest,
    "wall_south",
    "material_wall_neutral",
    [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
  );
  const rev3HashBefore = rawHash(rev3.result.verifiedOutputPath);

  const rev4 = await invoke(
    ["apply-change-set", baseJobPath, materialChangeSetPath],
    "job_material_revision_r4",
  );
  assert.equal(rev4.exitCode, 0);
  assert.equal(rev4.result.status, "SUCCESS");
  assert.equal(rev4.result.replayed, false);
  if (typeof rev4.result.workspace !== "string") throw new Error("rev0004 workspace missing");
  const mutation = readJson(resolve(rev4.result.workspace, "logs/mutation-result.json"));
  assert.equal(mutation.assignedMaterialId, "material_floor_neutral");
  assert.equal(mutation.deletedWallSegmentCount, 0);
  assert.equal(mutation.createdWallSegmentCount, 0);
  assert.ok(Number(mutation.assignedWallSegmentCount) > 0);
  const rev4Manifest = readManifest(rev4.result.workspace);
  assertMaterial(
    rev4Manifest,
    "wall_south",
    "material_floor_neutral",
    [0.6588235294117647, 0.6392156862745098, 0.6],
  );
  for (const wallId of ["wall_east", "wall_north", "wall_west"]) {
    assertMaterial(
      rev4Manifest,
      wallId,
      "material_wall_neutral",
      [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
    );
  }
  assertMaterial(
    rev4Manifest,
    "surface_floor_main",
    "material_floor_neutral",
    [0.6588235294117647, 0.6392156862745098, 0.6],
  );
  const semanticDiff = rev4.result.semanticDiff as {
    changed?: Array<{ logicalId?: string; changes?: Record<string, unknown> }>;
    added?: unknown[];
    removed?: unknown[];
  };
  assert.equal(semanticDiff.changed?.length, 1);
  assert.equal(semanticDiff.changed?.[0]?.logicalId, "wall_south");
  assert.deepEqual(Object.keys(semanticDiff.changed?.[0]?.changes ?? {}).sort(), [
    "materialBaseColorRgb",
    "materialId",
  ]);
  assert.deepEqual(semanticDiff.added, []);
  assert.deepEqual(semanticDiff.removed, []);
  assert.equal(rawHash(rev3.result.verifiedOutputPath), rev3HashBefore);

  const replay = await invoke(
    ["apply-change-set", baseJobPath, materialChangeSetPath],
    "job_material_revision_r4_replay",
  );
  assert.equal(replay.exitCode, 0);
  assert.equal(replay.result.status, "SUCCESS");
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.mutationProcess, null);
  assert.equal(replay.result.verificationProcess, null);
  assert.equal(replay.result.verifiedOutputPath, rev4.result.verifiedOutputPath);

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 4B deterministic AssignMaterial revision",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: rev4.result.dccVersion,
        compatibilityMode: rev4.result.compatibilityMode,
        processIds: {
          rev1Build: rev1.pid,
          rev2Revision: rev2.pid,
          rev3Revision: rev3.pid,
          rev4Revision: rev4.pid,
          rev4Replay: replay.pid,
        },
        results: {
          rev3: "verified native material baseline PASS",
          rev4: "wall_south targeted material assignment and fresh reopen PASS",
          sharedMaterialSafety: "east, north, and west walls remained wall-neutral PASS",
          baseArtifactPreservation: "rev_golden_0003 hash unchanged PASS",
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
