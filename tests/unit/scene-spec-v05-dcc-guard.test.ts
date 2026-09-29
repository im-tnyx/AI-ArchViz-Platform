import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { semanticJsonHash } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

// Count every DCC discovery and controlled-process launch the build attempts.
const calls = vi.hoisted(() => ({ discovery: 0, process: 0 }));
vi.mock("../../apps/worker/src/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/worker/src/discovery.js")>();
  return {
    ...actual,
    discoverThreeDsMax: (...args: Parameters<typeof actual.discoverThreeDsMax>) => {
      calls.discovery += 1;
      return actual.discoverThreeDsMax(...args);
    },
  };
});
vi.mock("../../apps/worker/src/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/worker/src/process.js")>();
  return {
    ...actual,
    runControlledProcess: (...args: Parameters<typeof actual.runControlledProcess>) => {
      calls.process += 1;
      return actual.runControlledProcess(...args);
    },
  };
});

const { buildGoldenScene } = await import("../../apps/worker/src/golden-build.js");

const repositoryRoot = resolve(import.meta.dirname, "../..");
const seedScenePath = join(
  repositoryRoot,
  "tests/fixtures/cad/multispace-seed/two-room/expected-scene-spec-v0.5.json",
);
const cadSeedFixture = join(repositoryRoot, "tests/fixtures/cad/scene-seed/simple-living-room");

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

describe("SceneSpec v0.5 is refused before any DCC (physical realization deferred to 10G)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("fails DCC_SCENE_SPEC_VERSION_UNSUPPORTED with zero discovery, zero processes, and no .max", async () => {
    const root = join(repositoryRoot, ".workspace", `test-v05-dcc-guard-${process.pid}`);
    roots.push(root);
    const jobDirectory = join(root, "job");
    const workspaceRoot = join(root, "workspaces");
    mkdirSync(jobDirectory, { recursive: true });
    copyFileSync(seedScenePath, join(jobDirectory, "scene-spec.json"));
    // Any parseable manifest/tolerances: the guard fires before they matter.
    copyFileSync(
      join(cadSeedFixture, "expected-scene-manifest.json"),
      join(jobDirectory, "expected-scene-manifest.json"),
    );
    copyFileSync(
      join(cadSeedFixture, "fixture-manifest.json"),
      join(jobDirectory, "fixture-manifest.json"),
    );
    const sceneSpec = JSON.parse(
      (await import("node:fs")).readFileSync(seedScenePath, "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      join(jobDirectory, "job-envelope.json"),
      JSON.stringify({
        jobEnvelopeVersion: "0.1.0",
        jobId: "job_cad_multispace_build_0001",
        idempotencyKey: "cad-multispace.build.rev_cad_multispace_0001",
        requestHash: `sha256:${"a".repeat(64)}`,
        projectId: "project_cad_multispace_001",
        sceneId: "scene_cad_multispace_001",
        jobType: "buildScene",
        baseRevisionId: null,
        requestedRevisionId: "rev_cad_multispace_0001",
        inputs: {
          sceneSpecPath: "input/scene-spec.json",
          sceneSpecHash: semanticJsonHash(sceneSpec),
          expectedManifestPath: "input/expected-scene-manifest.json",
          expectedManifestHash: `sha256:${"b".repeat(64)}`,
        },
        workerRequirements: { os: "windows", dcc: "3ds_max", renderer: "none" },
        policy: { mode: "batch", timeoutSeconds: 900, retryPolicy: "safe" },
      }),
    );

    // DCC execution fully authorized: only the version guard can stop it.
    const result = await buildGoldenScene(
      {
        repositoryRoot,
        workspaceRoot,
        processTimeoutMs: 5_000,
        threeDsMaxInstallationPath: null,
        allowCompatibilityVersionForSpike: true,
        allowDccExecution: true,
        trustedAssetRoot: null,
      },
      join(jobDirectory, "job-envelope.json"),
      { authorizeDccExecution: true },
    );

    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("DCC_SCENE_SPEC_VERSION_UNSUPPORTED");
    expect(result.dcc).toBe(null);
    expect(result.buildProcess).toBe(null);
    expect(result.verificationProcess).toBe(null);
    expect(calls).toEqual({ discovery: 0, process: 0 });
    expect(listFiles(root).filter((file) => file.toLowerCase().endsWith(".max"))).toEqual([]);
  });
});
