import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWithinRoot } from "./paths.js";

interface Invocation {
  exitCode: number | null;
  result: Record<string, unknown>;
}

interface ManifestNode {
  logicalId: string;
  assetDefinitionId?: string;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/asset-identity-6a");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "asset-identity.worker.config.json");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const baseJobPath = resolve(repositoryRoot, "tests/fixtures/living-room-golden/job-envelope.json");
const changeSetPaths = [
  "move-coffee-table-r2.json",
  "update-window-sill-r3.json",
  "assign-wall-south-material-r4.json",
  "lock-coffee-table-transform-r5.json",
  "unlock-coffee-table-transform-r6.json",
  "move-coffee-table-after-unlock-r7.json",
].map((name) => resolve(repositoryRoot, "tests/fixtures/living-room-golden/changesets", name));

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
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
          exitCode,
          result: JSON.parse(stdout) as Record<string, unknown>,
        });
      } catch (error) {
        reject(
          new Error(
            `Asset-identity child returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function definitionId(nodes: ManifestNode[], logicalId: string): string {
  const node = nodes.find((entry) => entry.logicalId === logicalId);
  if (!node?.assetDefinitionId) throw new Error(`Missing assetDefinitionId for ${logicalId}`);
  return node.assetDefinitionId;
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

  let finalRevision = base;
  for (const [index, changeSetPath] of changeSetPaths.entries()) {
    const revision = await invoke(
      ["apply-change-set", baseJobPath, changeSetPath],
      `job_asset_identity_r${index + 2}`,
    );
    assert.equal(revision.exitCode, 0);
    assert.equal(revision.result.status, "SUCCESS");
    assert.equal(revision.result.replayed, false);
    finalRevision = revision;
  }

  if (typeof finalRevision.result.workspace !== "string") {
    throw new Error("Final revision workspace is missing");
  }
  const manifest = readJson(
    resolve(finalRevision.result.workspace, "verification/scene-manifest.json"),
  ) as { nodes?: ManifestNode[] };
  if (!manifest.nodes) throw new Error("Fresh-reopen manifest has no nodes");
  const expectedDefinitions = {
    asset_living_sofa_main: "assetdef_sofa_proxy_standard_v1",
    asset_living_coffee_table_main: "assetdef_coffee_table_proxy_standard_v1",
    asset_living_tv_unit_main: "assetdef_tv_unit_proxy_standard_v1",
  } as const;
  for (const [logicalId, expectedDefinitionId] of Object.entries(expectedDefinitions)) {
    const actualDefinitionId = definitionId(manifest.nodes, logicalId);
    assert.equal(actualDefinitionId, expectedDefinitionId);
    assert.notEqual(actualDefinitionId, logicalId);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 6A canonical asset identity",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: finalRevision.result.dccVersion,
        compatibilityMode: finalRevision.result.compatibilityMode,
        results: {
          cleanBuild: "rev_golden_0001 fresh reopen PASS",
          revisionChain: "rev_golden_0002 through rev_golden_0007 PASS",
          freshReopenAssetDefinitionIds: expectedDefinitions,
          logicalAndDefinitionIdentity: "distinct PASS",
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
