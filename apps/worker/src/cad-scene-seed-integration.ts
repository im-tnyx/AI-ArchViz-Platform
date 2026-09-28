import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DxfSourceAdapter } from "@ai-archviz/cad-parser";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import { semanticJsonHash, validateSceneManifest } from "@ai-archviz/worker-contracts";
import { cadInterpretationEvidence } from "./cad-interpretation.js";
import { assertSeedBuildRealizable, createCadSceneSeed } from "./cad-scene-seed.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { resolveWithinRoot } from "./paths.js";

/*
 * Technical Spike 10C DCC integration: the first real DXF -> editable .max
 * path. The CAD-derived SceneSpec seed enters the SAME build-scene pipeline
 * (compileGoldenBuildPlan -> build_scene.py -> fresh verify_scene.py ->
 * manifest comparison -> promotion) as every other initial build. No render.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const interpretationFixture = resolve(
  repositoryRoot,
  "tests/fixtures/cad/interpretation/simple-living-room",
);
const seedFixture = resolve(repositoryRoot, "tests/fixtures/cad/scene-seed/simple-living-room");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/cad-scene-seed-10c");
const inputDirectory = join(runRoot, "input");
const workspaceRoot = join(runRoot, "workspaces");
const allowConfigPath = join(runRoot, "allow.worker.config.json");
const denyConfigPath = join(runRoot, "deny.worker.config.json");

const FROZEN = {
  sourceHash: "sha256:dad0ab0a7863d811d0968dcfad3572337eb33a61cddf06df51df16ce754b096d",
  cadDocumentHash: "sha256:0c89f758b39c0b6312912a34aed7ec4bc46f24be86c56244a029cef5628f7f26",
  profileHash: "sha256:8a4429606d348add059c358cb21853f246fa90a85af78b94eca62e351439a40f",
  architecturalExtractionHash:
    "sha256:b249055f4a6204c474d72cd82f613410c0f63b7145ed87f83d431f5812a33f8a",
  approvalHash: "sha256:4fd953313856ef014ed3506d2f73ac640df1c946c6c0f8ccd21fafb9094970e5",
  sceneSpecHash: "sha256:7286dca5257374cd964ae1d2715fb1f3c4c7e901bfa8a7d2883b0fbc1bfdcc67",
};

interface Invocation {
  exitCode: number | null;
  result: Record<string, unknown>;
}

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function batchProcessIds(): number[] {
  // Only 3dsmaxbatch.exe instances are test-owned; interactive 3dsmax.exe sessions are never touched.
  const output = execFileSync(
    "tasklist.exe",
    ["/FI", "IMAGENAME eq 3dsmaxbatch.exe", "/FO", "CSV", "/NH"],
    { encoding: "utf8", windowsHide: true },
  );
  return output
    .split(/\r?\n/u)
    .map((line) => line.split('","')[1])
    .filter((value): value is string => typeof value === "string" && /^\d+$/u.test(value))
    .map(Number);
}

async function buildScene(configPath: string, jobPath: string): Promise<Invocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(process.execPath, [cliPath, "build-scene", jobPath], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      env: { ...process.env, AI_ARCHVIZ_WORKER_CONFIG: configPath },
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
        resolveInvocation({ exitCode, result: JSON.parse(stdout) as Record<string, unknown> });
      } catch (error) {
        reject(
          new Error(
            `build-scene returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

async function main(): Promise<void> {
  requireDccTestApproval();
  const processesBefore = new Set(batchProcessIds());
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(inputDirectory, { recursive: true });

  // 1-4. 10A extraction of the exact fixture DXF.
  const bytes = new Uint8Array(readFileSync(join(interpretationFixture, "source.dxf")));
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, FROZEN.sourceHash);
  const cadDocument = new DxfSourceAdapter().parse({ bytes });
  assert.equal(cadDocument.sourceHash, FROZEN.sourceHash);
  assert.equal(semanticJsonHash(cadDocument), FROZEN.cadDocumentHash);
  assert.deepEqual(cadDocument, readJson(join(interpretationFixture, "cad-document-v0.1.json")));

  // 5-6. 10B interpretation under the explicit profile.
  const profile = readJson(join(interpretationFixture, "profile-v0.1.json"));
  const interpretation = cadInterpretationEvidence(cadDocument, profile);
  assert.equal(interpretation.evidence.profileHash, FROZEN.profileHash);
  assert.equal(interpretation.architecturalExtractionHash, FROZEN.architecturalExtractionHash);
  assert.equal(interpretation.extraction.status, "READY_FOR_REVIEW");

  // 7-13. Explicit human approval -> canonical seed -> pre-DCC validation.
  const approval = readJson(join(seedFixture, "approval-v0.1.json"));
  const seed = createCadSceneSeed(interpretation.extraction, approval);
  assert.equal(seed.approvalHash, FROZEN.approvalHash);
  assert.equal(seed.sceneSpecHash, FROZEN.sceneSpecHash);
  assert.deepEqual(seed.sceneSpec, readJson(join(seedFixture, "expected-scene-spec-v0.4.json")));
  assert.deepEqual(seed.evidence, readJson(join(seedFixture, "expected-seed-evidence-v0.1.json")));
  assert.equal(validateSceneSpec(seed.sceneSpec).ok, true);
  assert.equal(seed.evidence.spatialValidationStatus, "PASS");
  assert.equal(seed.evidence.circulationRequirementStatus, "PASS");
  assertSeedBuildRealizable(seed.sceneSpec);

  // 14. Materialize the existing build job with the GENERATED seed.
  const jobPath = join(inputDirectory, "job-envelope.json");
  copyFileSync(join(seedFixture, "job-envelope.json"), jobPath);
  writeJson(join(inputDirectory, "scene-spec.json"), seed.sceneSpec);
  copyFileSync(
    join(seedFixture, "expected-scene-manifest.json"),
    join(inputDirectory, "expected-scene-manifest.json"),
  );
  copyFileSync(
    join(seedFixture, "fixture-manifest.json"),
    join(inputDirectory, "fixture-manifest.json"),
  );
  const expectedManifest = readJson(join(inputDirectory, "expected-scene-manifest.json"));
  assert.equal(validateSceneManifest(expectedManifest).ok, true);
  const relativeJobPath = relative(repositoryRoot, jobPath).replaceAll("\\", "/");
  const relativeWorkspace = relative(repositoryRoot, workspaceRoot).replaceAll("\\", "/");

  // 15. Default-deny: without allowDccExecution nothing launches.
  writeJson(denyConfigPath, {
    workspaceRoot: `${relativeWorkspace}/deny`,
    processTimeoutMs: 600_000,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: false,
  });
  const denied = await buildScene(denyConfigPath, relativeJobPath);
  assert.notEqual(denied.exitCode, 0);
  assert.equal((denied.result.error as { code?: string } | null)?.code, "DCC_EXECUTION_DISABLED");
  assert.equal(denied.result.buildProcess, null);
  assert.deepEqual(
    filesUnder(join(workspaceRoot, "deny")).filter((path) => path.endsWith(".max")),
    [],
  );

  // 16-22. The existing build pipeline (centralized batch policy, sanitized env).
  writeJson(allowConfigPath, {
    workspaceRoot: relativeWorkspace,
    processTimeoutMs: 600_000,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: true,
  });
  const built = await buildScene(allowConfigPath, relativeJobPath);
  assert.equal(built.exitCode, 0, JSON.stringify(built.result.error));
  assert.equal(built.result.status, "SUCCESS");
  assert.equal(built.result.replayed, false);
  const comparison = built.result.comparison as { ok?: boolean } | null;
  assert.equal(comparison?.ok, true);
  const jobWorkspace = String(built.result.workspace);
  const actualManifest = readJson(join(jobWorkspace, "verification/scene-manifest.json"));
  assert.equal(validateSceneManifest(actualManifest).ok, true);
  assert.equal(actualManifest.projectId, "project_cad_seed_living_001");
  assert.equal(actualManifest.sceneId, "scene_cad_seed_living_001");
  assert.equal(actualManifest.revisionId, "rev_cad_seed_0001");
  const nodes = actualManifest.nodes as {
    logicalId: string;
    type: string;
    start?: number[];
    end?: number[];
    offset?: number;
    hostGeometryId?: string;
    dimensions: number[];
  }[];
  const byId = new Map(nodes.map((node) => [node.logicalId, node]));
  assert.deepEqual(nodes.map((node) => node.logicalId).sort(), [
    "asset_cad_seed_table_main",
    "opening_d01",
    "opening_w01",
    "surface_ceiling_main",
    "surface_floor_main",
    "wall_east",
    "wall_north",
    "wall_south",
    "wall_west",
  ]);
  const close = (actual: number[] | undefined, expected: number[]) =>
    assert.ok(
      actual?.length === expected.length &&
        actual.every((value, index) => Math.abs(value - (expected[index] as number)) <= 0.01),
      `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
  close(byId.get("wall_west")?.start, [0, 4500, 0]);
  close(byId.get("wall_west")?.end, [0, 0, 0]);
  close(byId.get("wall_south")?.dimensions, [6000, 150, 3000]);
  assert.equal(byId.get("opening_d01")?.hostGeometryId, "wall_west");
  assert.equal(byId.get("opening_d01")?.offset, 2400);
  close(byId.get("opening_d01")?.dimensions, [900, 150, 2100]);
  assert.equal(byId.get("opening_w01")?.hostGeometryId, "wall_north");
  close(byId.get("opening_w01")?.dimensions, [2400, 150, 1500]);
  assert.equal(nodes.filter((node) => node.type === "proxy_asset").length, 1);
  const cameras = actualManifest.cameras as { logicalId: string; focalLengthMm: number }[];
  assert.deepEqual(
    cameras.map((camera) => camera.logicalId),
    ["camera_cad_seed_a"],
  );
  assert.ok(Math.abs((cameras[0]?.focalLengthMm ?? 0) - 28) <= 0.01);

  // 26. Editable .max output: exists, regular, non-empty.
  const outputPath = String(built.result.verifiedOutputPath);
  const outputStats = lstatSync(outputPath);
  assert.ok(outputStats.isFile() && outputStats.size > 0);
  const outputHash = `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`;

  // 27. No render: no image output anywhere in the run.
  assert.deepEqual(
    filesUnder(runRoot).filter((path) => /\.(png|jpe?g|exr|tiff?)$/iu.test(path)),
    [],
  );

  // Idempotent replay: same job returns the recorded result, no new DCC work.
  const replay = await buildScene(allowConfigPath, relativeJobPath);
  assert.equal(replay.result.status, "SUCCESS");
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.buildProcess, null);
  assert.equal(
    `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`,
    outputHash,
  );

  // 29. No test-owned 3dsmaxbatch process remains.
  const leftover = batchProcessIds().filter((pid) => !processesBefore.has(pid));
  assert.deepEqual(leftover, [], "no test-owned 3dsmaxbatch process may remain");

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 10C CAD Scene Seed (DXF -> editable .max)",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: built.result.dccVersion,
        compatibilityMode: built.result.compatibilityMode,
        hashChain: { ...FROZEN, expectedManifestHash: semanticJsonHash(expectedManifest) },
        outputMaxBytes: outputStats.size,
        results: {
          upstream: "DXF -> 10A -> 10B -> approved_as_is -> 10C seed; all six frozen hashes PASS",
          validation: "SceneSpec v0.4, spatial-policy-v0.1, circulation requirements PASS",
          defaultDeny: "allowDccExecution=false -> DCC_EXECUTION_DISABLED, no process, no .max",
          build: "existing build-scene pipeline SUCCESS (centralized batch policy, sanitized env)",
          verification: "fresh-process semantic manifest matches the frozen expected manifest",
          identity: "project_cad_seed_living_001 / scene_cad_seed_living_001 / rev_cad_seed_0001",
          geometry: "4 walls, floor, ceiling, door on wall_west @2400, window on wall_north",
          nonCad: "1 proxy asset, 1 camera (28mm); render none/build_only; no image output",
          replay: "same job replays with no new DCC process; .max unchanged",
          processes: "no test-owned 3dsmaxbatch left",
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
