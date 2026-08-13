import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
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
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/materials-4a");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "materials.worker.config.json");
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

const expectedMaterials: Record<string, { id: string; color: number[] }> = {
  asset_living_sofa_main: {
    id: "material_sofa_proxy",
    color: [0.7215686274509804, 0.6196078431372549, 0.5019607843137255],
  },
  surface_floor_main: {
    id: "material_floor_neutral",
    color: [0.6588235294117647, 0.6392156862745098, 0.6],
  },
  wall_east: {
    id: "material_wall_neutral",
    color: [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
  },
  wall_north: {
    id: "material_wall_neutral",
    color: [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
  },
  wall_south: {
    id: "material_wall_neutral",
    color: [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
  },
  wall_west: {
    id: "material_wall_neutral",
    color: [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
  },
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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

function assertMaterialManifest(workspace: string): void {
  const byId = new Map(readManifest(workspace).map((node) => [node.logicalId, node]));
  for (const [logicalId, expected] of Object.entries(expectedMaterials)) {
    const node = byId.get(logicalId);
    assert.ok(node, `Missing material node ${logicalId}`);
    assert.equal(node.materialId, expected.id);
    assertColor(node.materialBaseColorRgb, expected.color);
  }
  for (const logicalId of [
    "asset_living_coffee_table_main",
    "asset_living_tv_unit_main",
    "surface_ceiling_main",
    "opening_d01",
    "opening_w01",
  ]) {
    const node = byId.get(logicalId);
    assert.ok(node, `Missing unassigned node ${logicalId}`);
    assert.equal("materialId" in node, false);
    assert.equal("materialBaseColorRgb" in node, false);
  }
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
            `Material integration child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
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
  if (typeof rev1.result.workspace !== "string") throw new Error("rev0001 workspace missing");
  assertMaterialManifest(rev1.result.workspace);

  const rev2 = await invoke(
    ["apply-change-set", baseJobPath, moveChangeSetPath],
    "job_materials_revision_r2",
  );
  assert.equal(rev2.exitCode, 0);
  assert.equal(rev2.result.status, "SUCCESS");
  if (typeof rev2.result.workspace !== "string") throw new Error("rev0002 workspace missing");
  assertMaterialManifest(rev2.result.workspace);

  const rev3 = await invoke(
    ["apply-change-set", baseJobPath, openingChangeSetPath],
    "job_materials_revision_r3",
  );
  assert.equal(rev3.exitCode, 0);
  assert.equal(rev3.result.status, "SUCCESS");
  if (typeof rev3.result.workspace !== "string") throw new Error("rev0003 workspace missing");
  assertMaterialManifest(rev3.result.workspace);
  const mutation = readJson(resolve(rev3.result.workspace, "logs/mutation-result.json"));
  assert.equal(mutation.rebuiltHostLogicalId, "wall_north");
  assert.equal(mutation.createdWallSegmentCount, 8);

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 4A material baseline realization",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: rev3.result.dccVersion,
        compatibilityMode: rev3.result.compatibilityMode,
        processIds: { rev1Build: rev1.pid, rev2Revision: rev2.pid, rev3Revision: rev3.pid },
        results: {
          rev1: "native material realization and fresh reopen PASS",
          rev2: "MoveObject material preservation PASS",
          rev3: "UpdateOpening wall_north material preservation PASS",
          manifest: "six assigned nodes recovered; five unassigned nodes omitted",
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
