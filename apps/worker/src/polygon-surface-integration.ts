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
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import { compileBuildPlanV02 } from "./build-plan.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { resolveWithinRoot } from "./paths.js";

/*
 * Post-10C polygon-surface realization DCC proof. A dedicated SceneSpec with
 * a concave L room, a translated rectangle (pivot at the origin AND at the
 * min corner), and a non-axis-aligned trapezoid (floor + ceiling each) goes
 * through the SHARED build-scene pipeline: build plan v0.2 -> editable meshes
 * -> fresh-process physical surface verification -> promotion. No render.
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const fixture = resolve(repositoryRoot, "tests/fixtures/polygon-surface-build");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/polygon-surface-closure");
const inputDirectory = join(runRoot, "input");
const workspaceRoot = join(runRoot, "workspaces");

type Point = [number, number];
const NOTCH_PROBE: Point = [4750, 3250];
const INSIDE_L_PROBE: Point = [1750, 3250];
const L_TRIANGLES = [
  [5, 0, 1],
  [1, 2, 3],
  [5, 1, 3],
  [3, 4, 5],
];

interface Invocation {
  exitCode: number | null;
  result: Record<string, unknown>;
}

interface SurfaceReport {
  logicalId: string;
  type: string;
  expectedBoundary: Point[];
  observedBoundary: Point[];
  expectedElevation: number;
  observedElevation: number;
  expectedAreaMm2: number;
  observedAreaMm2: number;
  observedVertexCount: number;
  observedFaceCount: number;
  observedTrianglesXY: Point[][];
  status: string;
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

async function buildScene(
  configPath: string,
  jobPath: string,
  extraEnv: Record<string, string> = {},
): Promise<Invocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(process.execPath, [cliPath, "build-scene", jobPath], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      env: { ...process.env, AI_ARCHVIZ_WORKER_CONFIG: configPath, ...extraEnv },
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

function writeConfig(name: string, workspace: string, allowDccExecution: boolean): string {
  const path = join(runRoot, `${name}.worker.config.json`);
  writeJson(path, {
    workspaceRoot: relative(repositoryRoot, workspace).replaceAll("\\", "/"),
    processTimeoutMs: 600_000,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution,
  });
  return path;
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

function covers(triangle: Point[], point: Point): boolean {
  const [a, b, c] = triangle as [Point, Point, Point];
  const cross = (o: Point, p: Point, q: Point) =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const signs = [cross(a, b, point), cross(b, c, point), cross(c, a, point)];
  return signs.every((value) => value >= 0) || signs.every((value) => value <= 0);
}

function surfaceReports(workspace: string): { status: string; surfaces: SurfaceReport[] } {
  const result = readJson(join(workspace, "logs/verification-result.json"));
  return result.surfaceVerification as { status: string; surfaces: SurfaceReport[] };
}

async function main(): Promise<void> {
  requireDccTestApproval();
  const processesBefore = new Set(batchProcessIds());
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(inputDirectory, { recursive: true });

  // 1-4. Canonical SceneSpec, build plan v0.2, deterministic triangulation.
  const sceneSpec = readJson(join(fixture, "scene-spec.json"));
  assert.equal(validateSceneSpec(sceneSpec).ok, true);
  const plan = compileBuildPlanV02(sceneSpec);
  assert.equal(plan.buildPlanVersion, "0.2.0");
  assert.deepEqual(compileBuildPlanV02(structuredClone(sceneSpec)), plan);
  const meshes = new Map(plan.surfaceMeshes.map((mesh) => [mesh.logicalId, mesh]));
  for (const id of ["surface_l_floor", "surface_l_ceiling"]) {
    assert.deepEqual(meshes.get(id)?.triangles, L_TRIANGLES);
    assert.equal(meshes.get(id)?.areaMm2, 20_750_000);
  }

  for (const name of [
    "job-envelope.json",
    "scene-spec.json",
    "expected-scene-manifest.json",
    "fixture-manifest.json",
  ]) {
    copyFileSync(join(fixture, name), join(inputDirectory, name));
  }
  const jobPath = relative(repositoryRoot, join(inputDirectory, "job-envelope.json")).replaceAll(
    "\\",
    "/",
  );

  // 5. Default-deny: no DCC discovery/process without allowDccExecution.
  const denied = await buildScene(writeConfig("deny", join(workspaceRoot, "deny"), false), jobPath);
  assert.equal((denied.result.error as { code?: string } | null)?.code, "DCC_EXECUTION_DISABLED");
  assert.equal(denied.result.buildProcess, null);

  // Forced physical mismatch (first surface built as its bounding box): the
  // fresh verifier must fail and NOTHING may be promoted.
  const forcedWorkspace = join(workspaceRoot, "forced");
  const forced = await buildScene(writeConfig("forced", forcedWorkspace, true), jobPath, {
    AI_ARCHVIZ_TEST_FORCE_SURFACE_MISMATCH: "1",
  });
  assert.equal(forced.result.status, "FAILED");
  assert.equal((forced.result.error as { code?: string } | null)?.code, "VERIFICATION_FAILED");
  assert.equal(forced.result.verifiedOutputPath, null);
  const forcedJobWorkspace = String(forced.result.workspace);
  assert.equal(existsSync(join(forcedJobWorkspace, "output/project.max")), false);
  const forcedReports = surfaceReports(forcedJobWorkspace);
  assert.equal(forcedReports.status, "FAILED");
  const filled = forcedReports.surfaces.find(
    (surface) => surface.logicalId === "surface_l_ceiling",
  );
  assert.equal(filled?.status, "FAILED");
  assert.equal(filled?.observedAreaMm2, 27_000_000);

  // 6-17. Real build through the shared pipeline.
  const allowConfig = writeConfig("allow", join(workspaceRoot, "allow"), true);
  const built = await buildScene(allowConfig, jobPath);
  assert.equal(built.exitCode, 0, JSON.stringify(built.result.error));
  assert.equal(built.result.status, "SUCCESS");
  assert.equal(built.result.replayed, false);
  assert.equal((built.result.comparison as { ok?: boolean } | null)?.ok, true);
  const jobWorkspace = String(built.result.workspace);
  const reports = surfaceReports(jobWorkspace);
  assert.equal(reports.status, "PASS");
  assert.deepEqual(
    reports.surfaces.map((surface) => surface.logicalId),
    [...meshes.keys()].sort(),
  );
  const expectedSurfaces = new Map(
    (sceneSpec.geometry as Record<string, unknown>[])
      .filter((entry) => entry.type === "floor" || entry.type === "ceiling")
      .map((entry) => [String(entry.id), entry]),
  );
  const close = (left: number, right: number) => Math.abs(left - right) <= 0.01;
  for (const report of reports.surfaces) {
    const expected = expectedSurfaces.get(report.logicalId) as {
      boundary: number[][];
      elevation: number;
    };
    assert.equal(report.status, "PASS", report.logicalId);
    assert.equal(report.observedVertexCount, expected.boundary.length);
    assert.equal(report.observedFaceCount, expected.boundary.length - 2);
    assert.ok(close(report.observedElevation, expected.elevation), report.logicalId);
    assert.ok(close(report.observedAreaMm2, report.expectedAreaMm2), report.logicalId);
    assert.equal(report.observedBoundary.length, expected.boundary.length);
    report.observedBoundary.forEach((point, index) => {
      const target = expected.boundary[index] as number[];
      assert.ok(
        close(point[0], target[0] as number) && close(point[1], target[1] as number),
        report.logicalId,
      );
    });
  }
  // 14. Concave notch absence, proved on the PHYSICALLY observed triangles.
  for (const id of ["surface_l_floor", "surface_l_ceiling"]) {
    const report = reports.surfaces.find((surface) => surface.logicalId === id) as SurfaceReport;
    assert.equal(
      report.observedTrianglesXY.some((triangle) => covers(triangle, NOTCH_PROBE)),
      false,
    );
    assert.equal(
      report.observedTrianglesXY.some((triangle) => covers(triangle, INSIDE_L_PROBE)),
      true,
    );
    assert.ok(close(report.observedAreaMm2, 20_750_000));
  }
  // Material identity survives on the polygon mesh.
  const manifest = readJson(join(jobWorkspace, "verification/scene-manifest.json"));
  const floorEntry = (manifest.nodes as Record<string, unknown>[]).find(
    (node) => node.logicalId === "surface_l_floor",
  );
  assert.equal(floorEntry?.materialId, "material_floor_oak");

  const outputPath = String(built.result.verifiedOutputPath);
  const outputStats = lstatSync(outputPath);
  assert.ok(outputStats.isFile() && outputStats.size > 0);
  const outputHash = `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`;

  // 18-19. Replay: no new DCC process, promoted .max unchanged.
  const replay = await buildScene(allowConfig, jobPath);
  assert.equal(replay.result.status, "SUCCESS");
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.result.buildProcess, null);
  assert.equal(
    `sha256:${createHash("sha256").update(readFileSync(outputPath)).digest("hex")}`,
    outputHash,
  );

  // 20-21. No render, no leftover test-owned process.
  assert.deepEqual(
    filesUnder(runRoot).filter((path) => /\.(png|jpe?g|exr|tiff?)$/iu.test(path)),
    [],
  );
  assert.deepEqual(
    batchProcessIds().filter((pid) => !processesBefore.has(pid)),
    [],
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Post-10C Polygon Surface Realization",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: built.result.dccVersion,
        compatibilityMode: built.result.compatibilityMode,
        outputMaxBytes: outputStats.size,
        surfaces: reports.surfaces.map((surface) => ({
          logicalId: surface.logicalId,
          observedVertexCount: surface.observedVertexCount,
          observedFaceCount: surface.observedFaceCount,
          observedElevation: surface.observedElevation,
          observedAreaMm2: surface.observedAreaMm2,
          status: surface.status,
        })),
        results: {
          plan: "build plan v0.2; deterministic L triangles [[5,0,1],[1,2,3],[5,1,3],[3,4,5]]",
          defaultDeny: "DCC_EXECUTION_DISABLED, no process",
          forcedMismatch:
            "bounding-box L ceiling (27,000,000 mm2) -> fresh verifier FAILED, no promotion",
          build: "shared build-scene SUCCESS: one editable mesh per floor/ceiling",
          verification:
            "semantic manifest PASS + physical boundary/elevation/area PASS for 6 surfaces",
          notch:
            "L notch probe [4750,3250] not covered; interior probe covered (floor and ceiling)",
          translated:
            "offset floor/ceiling (pivot at origin and at min corner) observed at the canonical world boundary",
          material: "material_floor_oak preserved on the L floor mesh",
          replay: "replayed with no new DCC process; .max unchanged",
          processes: "no test-owned 3dsmaxbatch left; no render output",
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
