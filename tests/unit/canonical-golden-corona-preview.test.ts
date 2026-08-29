import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateCanonicalCoronaPreviewEvidence } from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  calculateCanonicalGoldenCoronaPreviewRequestHash,
  executeCanonicalGoldenCoronaPreview,
  isWorkerControlledCanonicalPreviewOutput,
} from "../../apps/worker/src/canonical-golden-corona-preview-execution.js";
import { CoronaRendererAdapter } from "../../apps/worker/src/corona-renderer-adapter.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function testHash(byte: string): string {
  return `sha256:${byte.repeat(32)}`;
}

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function rev10Scene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0010/scene-spec.json");
}

function rev10Manifest(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0010/expected-scene-manifest.json");
}

function renderJob(): Record<string, unknown> {
  return fixture("render-job-v0.2-camera-living-a.json");
}

function config(overrides: Partial<{ allowDccExecution: boolean }> = {}) {
  return {
    repositoryRoot: resolve("."),
    workspaceRoot: resolve(".workspace/canonical-golden-preview-unit-test"),
    processTimeoutMs: 60_000,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: overrides.allowDccExecution ?? true,
  };
}

function withPlaceholderArtifact<T>(run: (artifactPath: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "avz-canonical-preview-unit-"));
  const artifactPath = join(directory, "rev10.max");
  writeFileSync(artifactPath, "not-a-real-max-file");
  try {
    return run(artifactPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Technical Spike 8E canonical Golden Corona preview (pure preconditions)", () => {
  it("rejects a source SceneSpec that is not exactly rev10, before any DCC launch", async () => {
    const scene = rev10Scene();
    (scene.scene as Record<string, unknown>).revisionId = "rev_golden_0009";
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreview({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev10Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CANONICAL_SOURCE_REVISION_MISMATCH");
    expect(result.process).toBeNull();
  });

  it("rejects a source SceneSpec whose render intent is not corona preview", async () => {
    const scene = rev10Scene();
    scene.render = { engine: "none", mode: "build_only" };
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreview({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev10Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("RENDER_SOURCE_RENDER_STATE_MISMATCH");
    expect(result.process).toBeNull();
  });

  it("rejects a non-area canonical light before any DCC launch (post-8D invariant preserved)", async () => {
    const scene = rev10Scene();
    (scene.lights as Array<Record<string, unknown>>)[0] = {
      ...(scene.lights as Array<Record<string, unknown>>)[0],
      type: "point",
    };
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreview({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev10Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("RENDERER_LIGHT_TYPE_UNSUPPORTED");
    expect(result.process).toBeNull();
  });

  it("rejects an unknown render camera before any DCC launch", async () => {
    const job = { ...renderJob(), cameraId: "camera_living_nonexistent" };
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreview({
        config: config(),
        sceneSpec: rev10Scene(),
        renderJob: job,
        expectedManifest: rev10Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CAMERA_NOT_FOUND");
    expect(result.process).toBeNull();
  });

  it("stays BLOCKED under default-deny even when the call site authorizes it", async () => {
    const scene = rev10Scene();
    const sourceOrder = structuredClone(scene);
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreview({
        config: config({ allowDccExecution: false }),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev10Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.error?.code).toBe("DCC_EXECUTION_DISABLED");
    expect(result.process).toBeNull();
    // No SceneSpec mutation, even during preflight compilation.
    expect(scene).toEqual(sourceOrder);
  });

  it("compiles through the normal adapter only, with no diagnostic-profile concepts", () => {
    const plan = new CoronaRendererAdapter().compile(rev10Scene(), renderJob());
    expect(plan).not.toHaveProperty("profileId");
    expect(plan).not.toHaveProperty("intentSource");
    expect(plan).not.toHaveProperty("temporaryLight");
    expect(plan.revisionId).toBe("rev_golden_0010");
    expect(plan.camera.logicalId).toBe("camera_living_a");
    expect(plan.lights).toEqual([
      {
        logicalId: "light_living_key_area",
        type: "area",
        position: [3000, 1600, 2800],
        rotationEuler: [-35, 0, 0],
        canonicalIntensity: 1.25,
        mappedIntensity: 150,
        widthMm: 800,
      },
    ]);
  });
});

describe("canonical Golden Corona preview request hash", () => {
  it("is deterministic and excludes paths, PID, timestamp, and PNG hash", () => {
    const plan = new CoronaRendererAdapter().compile(rev10Scene(), renderJob());
    const first = calculateCanonicalGoldenCoronaPreviewRequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    const second = calculateCanonicalGoldenCoronaPreviewRequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("changes when the SceneSpec hash or the canonical artifact hash changes", () => {
    const plan = new CoronaRendererAdapter().compile(rev10Scene(), renderJob());
    const base = calculateCanonicalGoldenCoronaPreviewRequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    const differentScene = calculateCanonicalGoldenCoronaPreviewRequestHash(
      plan,
      testHash("cc"),
      testHash("bb"),
    );
    const differentArtifact = calculateCanonicalGoldenCoronaPreviewRequestHash(
      plan,
      testHash("aa"),
      testHash("dd"),
    );
    expect(differentScene).not.toBe(base);
    expect(differentArtifact).not.toBe(base);
  });
});

describe("canonical Golden Corona preview evidence contract", () => {
  const validEvidence = {
    evidenceVersion: "0.1.0",
    intentSource: "canonical_scene_spec",
    projectId: "project_golden_living_001",
    sceneId: "scene_golden_living_001",
    revisionId: "rev_golden_0010",
    sceneSpecHash: testHash("aa"),
    canonicalArtifactHash: testHash("bb"),
    stagedArtifactHash: testHash("bb"),
    requestHash: testHash("cc"),
    renderer: { engine: "corona", className: "Corona", version: null },
    dcc: { product: "3ds_max", version: "2025.3", compatibilityMode: true },
    canonicalLights: [
      {
        logicalId: "light_living_key_area",
        type: "area",
        actualClass: "CoronaLight",
        position: [3000, 1600, 2800],
        rotationEuler: [-35, 0, 0],
        canonicalIntensity: 1.25,
        mappedIntensity: 150,
        widthMm: 800,
      },
    ],
    materials: [
      {
        materialId: "material_wall_neutral",
        className: "_CoronaPhysicalMtl",
        canonicalBaseColorRgb: [0.78, 0.74, 0.68],
        materialInstanceName: "AVZ_CORONA_material_wall_neutral",
      },
    ],
    materialAssignments: [
      {
        targetId: "wall_east",
        materialId: "material_wall_neutral",
        materialInstanceName: "AVZ_CORONA_material_wall_neutral",
        className: "_CoronaPhysicalMtl",
        sharedMaterialInstance: true,
      },
    ],
    camera: {
      logicalId: "camera_living_a",
      className: "Freecamera",
      position: [1200, 3800, 1500],
      target: [3000, 200, 1300],
      focalLengthMm: 24,
      sensorWidthMm: 36,
      fovRadians: 1.2,
      lookAtTarget: true,
    },
    render: {
      mode: "preview",
      resolution: { width: 320, height: 240 },
      termination: { type: "pass_limit", value: 4 },
    },
    output: {
      format: "png",
      byteLength: 512,
      sha256: testHash("ee"),
    },
    status: "PASS",
  };

  it("accepts a well-formed canonical evidence document", () => {
    expect(validateCanonicalCoronaPreviewEvidence(validEvidence).ok).toBe(true);
  });

  it("rejects a diagnostic-profile intent source (8C concepts must not leak into 8E)", () => {
    const tampered = { ...validEvidence, intentSource: "trusted_diagnostic_profile" };
    expect(validateCanonicalCoronaPreviewEvidence(tampered).ok).toBe(false);
  });

  it("rejects evidence for a revision other than rev10", () => {
    const tampered = { ...validEvidence, revisionId: "rev_golden_0009" };
    expect(validateCanonicalCoronaPreviewEvidence(tampered).ok).toBe(false);
  });

  it("rejects a non-CoronaLight canonical light class", () => {
    const tampered = {
      ...validEvidence,
      canonicalLights: [{ ...validEvidence.canonicalLights[0], actualClass: "Omnilight" }],
    };
    expect(validateCanonicalCoronaPreviewEvidence(tampered).ok).toBe(false);
  });
});

describe("canonical Golden Corona preview output path containment", () => {
  it("accepts only the exact worker-controlled render output path", () => {
    const workspaceRoot = resolve("/tmp/canonical-preview-workspace");
    expect(
      isWorkerControlledCanonicalPreviewOutput(
        workspaceRoot,
        resolve(workspaceRoot, "render", "canonical-golden-preview.png"),
      ),
    ).toBe(true);
    expect(
      isWorkerControlledCanonicalPreviewOutput(
        workspaceRoot,
        resolve(workspaceRoot, "render", "other.png"),
      ),
    ).toBe(false);
    expect(
      isWorkerControlledCanonicalPreviewOutput(
        workspaceRoot,
        resolve(workspaceRoot, "render", "..", "..", "escape.png"),
      ),
    ).toBe(false);
  });
});
