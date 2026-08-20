import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  calculateRequestHash,
  type JobEnvelope,
  semanticJsonHash,
} from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGoldenScene,
  compareSceneManifests,
  compileGoldenBuildPlan,
  createJobWorkspace,
  openingWorldBounds,
  promoteCandidate,
  wallFrame,
} from "../../apps/worker/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");
const temporaryDirectories: string[] = [];

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as Record<string, unknown>;
}

function isolatedFixture(mutate: (scene: Record<string, unknown>, job: JobEnvelope) => void): {
  root: string;
  jobPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ai-archviz-preflight-"));
  temporaryDirectories.push(root);
  const fixtureDirectory = join(root, "fixture");
  mkdirSync(fixtureDirectory, { recursive: true });
  const scene = fixture("scene-spec.json");
  const expected = fixture("expected-scene-manifest.json");
  const fixtureManifest = fixture("fixture-manifest.json");
  const job = fixture("job-envelope.json") as unknown as JobEnvelope;
  mutate(scene, job);
  writeFileSync(join(fixtureDirectory, "scene-spec.json"), JSON.stringify(scene), "utf8");
  writeFileSync(
    join(fixtureDirectory, "expected-scene-manifest.json"),
    JSON.stringify(expected),
    "utf8",
  );
  writeFileSync(
    join(fixtureDirectory, "fixture-manifest.json"),
    JSON.stringify(fixtureManifest),
    "utf8",
  );
  const jobPath = join(fixtureDirectory, "job-envelope.json");
  writeFileSync(jobPath, JSON.stringify(job), "utf8");
  return { root, jobPath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Golden SceneSpec compiler", () => {
  it("compiles exactly the expected semantic manifest", () => {
    const plan = compileGoldenBuildPlan(fixture("scene-spec.json"));
    const expected = fixture("expected-scene-manifest.json");
    expect({
      manifestVersion: "0.1.0",
      projectId: plan.projectId,
      sceneId: plan.sceneId,
      revisionId: plan.revisionId,
      coordinateSystem: plan.coordinateSystem,
      nodes: plan.nodes,
      cameras: plan.cameras,
    }).toEqual(expected);
  });

  it("uses the frozen exterior-right wall normals", () => {
    expect(wallFrame({ start: [0, 0, 0], end: [6000, 0, 0] }).exteriorNormal).toEqual([0, -1, 0]);
    expect(wallFrame({ start: [6000, 0, 0], end: [6000, 4500, 0] }).exteriorNormal).toEqual([
      1, 0, 0,
    ]);
    expect(wallFrame({ start: [6000, 4500, 0], end: [0, 4500, 0] }).exteriorNormal).toEqual([
      0, 1, 0,
    ]);
    expect(wallFrame({ start: [0, 4500, 0], end: [0, 0, 0] }).exteriorNormal).toEqual([-1, 0, 0]);
  });

  it("resolves door and window host-local bounds without transform double-application", () => {
    const scene = fixture("scene-spec.json") as {
      geometry: Array<Record<string, unknown>>;
      openings: Array<Record<string, unknown>>;
    };
    const wallWest = scene.geometry.find((entry) => entry.id === "wall_west");
    const wallNorth = scene.geometry.find((entry) => entry.id === "wall_north");
    const door = scene.openings.find((entry) => entry.id === "opening_d01");
    const window = scene.openings.find((entry) => entry.id === "opening_w01");
    expect(openingWorldBounds(wallWest as never, door as never)).toEqual({
      start: [0, 2100, 0],
      end: [0, 1200, 0],
      bottom: 0,
      top: 2100,
    });
    expect(openingWorldBounds(wallNorth as never, window as never)).toEqual({
      start: [4200, 4500, 0],
      end: [1800, 4500, 0],
      bottom: 750,
      top: 2250,
    });
  });

  it("creates physical wall segments around both Golden openings", () => {
    const plan = compileGoldenBuildPlan(fixture("scene-spec.json"));
    expect(
      plan.wallSegments.filter((segment) => segment.hostLogicalId === "wall_west"),
    ).toHaveLength(5);
    expect(
      plan.wallSegments.filter((segment) => segment.hostLogicalId === "wall_north"),
    ).toHaveLength(8);
    expect(plan.nodes.filter((node) => node.type === "proxy_asset")).toHaveLength(3);
    expect(plan.cameras.map((camera) => camera.logicalId)).toEqual([
      "camera_living_a",
      "camera_living_b",
      "camera_living_c",
    ]);
    expect(plan.openingMarkers).toEqual([
      { logicalId: "opening_d01", position: [-75, 2100, 0] },
      { logicalId: "opening_w01", position: [4200, 4575, 750] },
    ]);
  });
});

describe("semantic manifest comparator", () => {
  const tolerances = {
    geometryToleranceMm: 0.01,
    transformToleranceMm: 0.01,
    rotationToleranceDeg: 0.001,
  };

  it("passes exact and within-tolerance manifests", () => {
    const expected = fixture("expected-scene-manifest.json");
    const actual = structuredClone(expected) as {
      coordinateSystem: Record<string, unknown>;
      nodes: Array<{ dimensions: number[]; embeddedMetadata: Record<string, unknown> }>;
    };
    const firstNode = actual.nodes[0];
    if (!firstNode) throw new Error("Golden node missing");
    const firstDimension = firstNode.dimensions[0];
    if (firstDimension === undefined) throw new Error("Golden dimensions missing");
    firstNode.dimensions.splice(0, 1, firstDimension + 0.009);
    actual.coordinateSystem = Object.fromEntries(Object.entries(actual.coordinateSystem).reverse());
    const firstMetadata = firstNode.embeddedMetadata;
    if (!firstMetadata) throw new Error("Golden metadata missing");
    firstNode.embeddedMetadata = Object.fromEntries(Object.entries(firstMetadata).reverse());
    expect(compareSceneManifests(expected, actual as never, tolerances)).toEqual({
      ok: true,
      differences: [],
    });
  });

  it("reports deterministic typed differences outside tolerance", () => {
    const expected = fixture("expected-scene-manifest.json");
    const actual = structuredClone(expected) as {
      nodes: Array<{ logicalId: string; dimensions: number[] }>;
    };
    const wall = actual.nodes.find((node) => node.logicalId === "wall_south");
    if (!wall) throw new Error("Golden wall missing");
    wall.dimensions[0] = 5999;
    actual.nodes.splice(
      actual.nodes.findIndex((node) => node.logicalId === "opening_d01"),
      1,
    );
    const result = compareSceneManifests(expected, actual as never, tolerances);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.differences.map((entry) => entry.code)).toEqual([
      "MISSING_NODE",
      "DIMENSION_MISMATCH",
    ]);
  });
});

describe("workspace lifecycle and promotion guard", () => {
  it("preserves previous output while resetting transient directories", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-workspace-"));
    temporaryDirectories.push(root);
    const first = createJobWorkspace(root, "job_golden_build_0001");
    writeFileSync(first.outputPath, "previous-output", "utf8");
    writeFileSync(first.candidatePath, "stale-candidate", "utf8");
    const second = createJobWorkspace(root, "job_golden_build_0001");
    expect(readFileSync(second.outputPath, "utf8")).toBe("previous-output");
    expect(() => readFileSync(second.candidatePath, "utf8")).toThrow();
  });

  it("promotes only an existing candidate and leaves output untouched on failure", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-promotion-"));
    temporaryDirectories.push(root);
    const workspace = createJobWorkspace(root, "job_golden_build_0001");
    writeFileSync(workspace.outputPath, "verified-old", "utf8");
    expect(() => promoteCandidate(workspace.candidatePath, workspace.outputPath)).toThrow(
      /missing/u,
    );
    expect(readFileSync(workspace.outputPath, "utf8")).toBe("verified-old");
    writeFileSync(workspace.candidatePath, "candidate-new", "utf8");
    promoteCandidate(workspace.candidatePath, workspace.outputPath);
    expect(readFileSync(workspace.outputPath, "utf8")).toBe("candidate-new");
  });
});

describe("pre-DCC failure gates", () => {
  it("rejects an invalid SceneSpec before discovery or launch", async () => {
    const { root, jobPath } = isolatedFixture((scene, job) => {
      scene.sceneSpecVersion = "9.9.9";
      job.inputs.sceneSpecHash = semanticJsonHash(scene);
      job.requestHash = calculateRequestHash(job);
    });
    const result = await buildGoldenScene(
      {
        repositoryRoot: root,
        workspaceRoot: join(root, ".workspace"),
        processTimeoutMs: 5_000,
        threeDsMaxInstallationPath: null,
        allowCompatibilityVersionForSpike: false,
        trustedAssetRoot: null,
      },
      jobPath,
    );
    expect(result).toMatchObject({
      status: "FAILED",
      dcc: null,
      buildProcess: null,
      verificationProcess: null,
      report: { error: { code: "SCHEMA_INVALID" } },
    });
  });

  it("rejects a semantic hash mismatch before discovery or launch", async () => {
    const { root, jobPath } = isolatedFixture((scene) => {
      const project = scene.project as { name: string };
      project.name = "Hash mismatch mutation";
    });
    const result = await buildGoldenScene(
      {
        repositoryRoot: root,
        workspaceRoot: join(root, ".workspace"),
        processTimeoutMs: 5_000,
        threeDsMaxInstallationPath: null,
        allowCompatibilityVersionForSpike: false,
        trustedAssetRoot: null,
      },
      jobPath,
    );
    expect(result).toMatchObject({
      status: "FAILED",
      dcc: null,
      buildProcess: null,
      verificationProcess: null,
      report: { error: { code: "HASH_MISMATCH" } },
    });
  });
});
