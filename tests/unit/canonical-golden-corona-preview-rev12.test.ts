import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateCanonicalCoronaPreviewEvidenceV02,
  validateCanonicalCoronaPreviewEvidenceV03,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  calculateCanonicalGoldenCoronaPreviewRev12RequestHash,
  executeCanonicalGoldenCoronaPreviewRev12,
  isWorkerControlledCanonicalPreviewRev12Output,
} from "../../apps/worker/src/canonical-golden-corona-preview-rev12-execution.js";
import { CoronaRendererAdapter } from "../../apps/worker/src/corona-renderer-adapter.js";
import { canonicalCameraStateExpectation } from "../../apps/worker/src/revision.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function testHash(byte: string): string {
  return `sha256:${byte.repeat(32)}`;
}

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function rev12Scene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0012/scene-spec.json");
}

function rev11Scene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0011/scene-spec.json");
}

function rev12Manifest(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0012/expected-scene-manifest.json");
}

function renderJob(): Record<string, unknown> {
  return fixture("render-job-v0.2-camera-living-a.json");
}

function config(overrides: Partial<{ allowDccExecution: boolean }> = {}) {
  return {
    repositoryRoot: resolve("."),
    workspaceRoot: resolve(".workspace/canonical-golden-preview-rev12-unit-test"),
    processTimeoutMs: 60_000,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: overrides.allowDccExecution ?? true,
  };
}

function withPlaceholderArtifact<T>(run: (artifactPath: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "avz-canonical-preview-rev12-unit-"));
  const artifactPath = join(directory, "rev12.max");
  writeFileSync(artifactPath, "not-a-real-max-file");
  try {
    return run(artifactPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Technical Spike 8J canonical Golden Corona preview from rev12 (pure preconditions)", () => {
  it("rejects a source SceneSpec that is not exactly rev12", async () => {
    const scene = rev12Scene();
    (scene.scene as Record<string, unknown>).revisionId = "rev_golden_0011";
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev12({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev12Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CANONICAL_SOURCE_REVISION_MISMATCH");
    expect(result.process).toBeNull();
  });

  it("rejects the actual verified rev11 SceneSpec (still 24mm), before any DCC launch", async () => {
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev12({
        config: config(),
        sceneSpec: rev11Scene(),
        renderJob: renderJob(),
        expectedManifest: rev12Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CANONICAL_SOURCE_REVISION_MISMATCH");
    expect(result.process).toBeNull();
  });

  it("rejects a source SceneSpec whose render intent is not corona preview", async () => {
    const scene = rev12Scene();
    scene.render = { engine: "none", mode: "build_only" };
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev12({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev12Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("RENDER_SOURCE_RENDER_STATE_MISMATCH");
    expect(result.process).toBeNull();
  });

  it("rejects an unknown render camera before any DCC launch", async () => {
    const job = { ...renderJob(), cameraId: "camera_living_nonexistent" };
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev12({
        config: config(),
        sceneSpec: rev12Scene(),
        renderJob: job,
        expectedManifest: rev12Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CAMERA_NOT_FOUND");
    expect(result.process).toBeNull();
  });

  it("stays BLOCKED under default-deny even when the call site authorizes it, with no SceneSpec mutation", async () => {
    const scene = rev12Scene();
    const sourceOrder = structuredClone(scene);
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev12({
        config: config({ allowDccExecution: false }),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev12Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.error?.code).toBe("DCC_EXECUTION_DISABLED");
    expect(result.process).toBeNull();
    expect(scene).toEqual(sourceOrder);
  });

  it("compiles through compileCanonicalMaterialAppearance() only, producing plan v0.2 with the 28mm camera and no legacy 24mm value", () => {
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
      rev12Scene(),
      renderJob(),
    );
    expect(plan.planVersion).toBe("0.2.0");
    expect(plan.adapterDefaults).not.toHaveProperty("material");
    expect(plan.revisionId).toBe("rev_golden_0012");
    expect(plan.camera.logicalId).toBe("camera_living_a");
    expect(plan.camera.focalLengthMm).toBe(28);
    expect(plan.camera.sensorWidthMm).toBe(36);
    expect(plan.camera.fovRadians).toBeCloseTo(1.1426749596672536, 12);
    expect(JSON.stringify(plan.camera)).not.toContain('"focalLengthMm":24');
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
    const byId = new Map(plan.materials.map((material) => [material.materialId, material]));
    expect(byId.get("material_wall_neutral")).toEqual({
      materialId: "material_wall_neutral",
      baseColorRgb: [0.78, 0.74, 0.68],
      roughness: 0.62,
      metalness: 0,
    });
    expect(byId.get("material_floor_neutral")).toEqual({
      materialId: "material_floor_neutral",
      baseColorRgb: [0.66, 0.64, 0.6],
      roughness: 0.34,
      metalness: 0,
    });
    expect(byId.get("material_sofa_proxy")).toEqual({
      materialId: "material_sofa_proxy",
      baseColorRgb: [0.72, 0.62, 0.5],
      roughness: 0.78,
      metalness: 0,
    });
  });

  it("produces a canonical camera-state oracle for rev12 whose camera_living_a is 28mm with the 6-decimal canonical Euler", () => {
    const expected = canonicalCameraStateExpectation(rev12Scene());
    expect(expected).not.toBeNull();
    const value = expected as { cameras: Array<Record<string, unknown>> };
    const cameraA = value.cameras.find((camera) => camera.logicalId === "camera_living_a");
    expect(cameraA).toMatchObject({
      focalLengthMm: 28,
      sensorWidthMm: 36,
      canonicalRotationEuler: [-2.84471, 0, 206.565051],
    });
    expect((cameraA as { expectedFovRadians: number }).expectedFovRadians).toBeCloseTo(
      1.1426749596672536,
      12,
    );
  });
});

describe("canonical Golden Corona preview rev12 request hash", () => {
  it("is deterministic and excludes paths, PID, timestamp, and PNG hash", () => {
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
      rev12Scene(),
      renderJob(),
    );
    const first = calculateCanonicalGoldenCoronaPreviewRev12RequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    const second = calculateCanonicalGoldenCoronaPreviewRev12RequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("changes when the SceneSpec hash or the canonical artifact hash changes", () => {
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
      rev12Scene(),
      renderJob(),
    );
    const base = calculateCanonicalGoldenCoronaPreviewRev12RequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    const differentScene = calculateCanonicalGoldenCoronaPreviewRev12RequestHash(
      plan,
      testHash("cc"),
      testHash("bb"),
    );
    const differentArtifact = calculateCanonicalGoldenCoronaPreviewRev12RequestHash(
      plan,
      testHash("aa"),
      testHash("dd"),
    );
    expect(differentScene).not.toBe(base);
    expect(differentArtifact).not.toBe(base);
  });
});

describe("canonical Golden Corona preview evidence v0.1/v0.2 remain untouched by 8J", () => {
  it("v0.2 (rev11 persisted materials, 24mm) still validates unchanged", () => {
    const rev11Evidence = {
      evidenceVersion: "0.2.0",
      intentSource: "canonical_scene_spec",
      projectId: "project_golden_living_001",
      sceneId: "scene_golden_living_001",
      revisionId: "rev_golden_0011",
      sceneSpecVersion: "0.3.0",
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
          actualClass: "_CoronaPhysicalMtl",
          canonicalBaseColorRgb: [0.78, 0.74, 0.68],
          observedBaseColorRgb: [0.78, 0.74, 0.68],
          canonicalRoughness: 0.62,
          observedRoughness: 0.62,
          canonicalMetalness: 0,
          observedMetalness: 0,
          materialInstanceName: "AVZ_MATERIAL_material_wall_neutral",
        },
      ],
      materialAssignments: [
        {
          targetId: "wall_east",
          materialId: "material_wall_neutral",
          materialInstanceName: "AVZ_MATERIAL_material_wall_neutral",
        },
      ],
      deduplication: { sameIdSharedInstance: true, differentIdDistinctInstances: true },
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
      output: { format: "png", byteLength: 512, sha256: testHash("ee") },
      status: "PASS",
    };
    expect(validateCanonicalCoronaPreviewEvidenceV02(rev11Evidence).ok).toBe(true);
    // v0.3 evidence must never satisfy the v0.2 contract and vice versa.
    expect(
      validateCanonicalCoronaPreviewEvidenceV02({ ...rev11Evidence, revisionId: "rev_golden_0012" })
        .ok,
    ).toBe(false);
  });
});

describe("canonical Golden Corona preview evidence v0.3 (rev12 persisted 28mm camera)", () => {
  const validMaterial = {
    materialId: "material_wall_neutral",
    actualClass: "_CoronaPhysicalMtl",
    canonicalBaseColorRgb: [0.78, 0.74, 0.68],
    observedBaseColorRgb: [0.78, 0.74, 0.68],
    canonicalRoughness: 0.62,
    observedRoughness: 0.62,
    canonicalMetalness: 0,
    observedMetalness: 0,
    materialInstanceName: "AVZ_MATERIAL_material_wall_neutral",
  };
  const validCamera = {
    logicalId: "camera_living_a",
    className: "Freecamera",
    canonicalPosition: [1200, 3800, 1500],
    observedPosition: [1200, 3800, 1500],
    canonicalTarget: [3000, 200, 1300],
    observedTarget: [3000, 200, 1300],
    canonicalRotationEuler: [-2.84471, 0, 206.565051],
    observedRotationEuler: [-2.84471, 0, 206.565051],
    focalLengthMm: 28,
    sensorWidthMm: 36,
    expectedFovRadians: 1.1426749596672536,
    expectedFovDegrees: 65.4704525442152,
    observedFovRadians: 1.1426749596672536,
    observedFovDegrees: 65.4704525442152,
    lookAtTarget: true,
  };
  const validEvidence = {
    evidenceVersion: "0.3.0",
    intentSource: "canonical_scene_spec",
    projectId: "project_golden_living_001",
    sceneId: "scene_golden_living_001",
    revisionId: "rev_golden_0012",
    sceneSpecVersion: "0.3.0",
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
    materials: [validMaterial],
    materialAssignments: [
      {
        targetId: "wall_east",
        materialId: "material_wall_neutral",
        materialInstanceName: "AVZ_MATERIAL_material_wall_neutral",
      },
    ],
    deduplication: { sameIdSharedInstance: true, differentIdDistinctInstances: true },
    camera: validCamera,
    render: {
      mode: "preview",
      resolution: { width: 320, height: 240 },
      termination: { type: "pass_limit", value: 4 },
    },
    output: { format: "png", byteLength: 512, sha256: testHash("ee") },
    status: "PASS",
  };

  it("accepts a well-formed canonical rev12 evidence document", () => {
    expect(validateCanonicalCoronaPreviewEvidenceV03(validEvidence).ok).toBe(true);
  });

  it("rejects evidence for a revision other than rev12", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV03({ ...validEvidence, revisionId: "rev_golden_0011" })
        .ok,
    ).toBe(false);
  });

  it("rejects the obsolete temporary AVZ_CORONA_* material naming", () => {
    const tampered = {
      ...validEvidence,
      materials: [{ ...validMaterial, materialInstanceName: "AVZ_CORONA_material_wall_neutral" }],
    };
    expect(validateCanonicalCoronaPreviewEvidenceV03(tampered).ok).toBe(false);
  });

  it("rejects a camera logical ID other than camera_living_a", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV03({
        ...validEvidence,
        camera: { ...validCamera, logicalId: "camera_living_b" },
      }).ok,
    ).toBe(false);
  });

  it("rejects a camera native class other than Freecamera", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV03({
        ...validEvidence,
        camera: { ...validCamera, className: "Targetcamera" },
      }).ok,
    ).toBe(false);
  });

  it("rejects lookAtTarget false", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV03({
        ...validEvidence,
        camera: { ...validCamera, lookAtTarget: false },
      }).ok,
    ).toBe(false);
  });

  it("rejects a deduplication proof that is not both true", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV03({
        ...validEvidence,
        deduplication: { sameIdSharedInstance: false, differentIdDistinctInstances: true },
      }).ok,
    ).toBe(false);
  });
});

describe("canonical Golden Corona preview rev12 output path containment", () => {
  it("accepts only the exact worker-controlled render output path", () => {
    const workspaceRoot = resolve("/tmp/canonical-preview-rev12-workspace");
    expect(
      isWorkerControlledCanonicalPreviewRev12Output(
        workspaceRoot,
        resolve(workspaceRoot, "render", "canonical-golden-preview-rev12.png"),
      ),
    ).toBe(true);
    expect(
      isWorkerControlledCanonicalPreviewRev12Output(
        workspaceRoot,
        resolve(workspaceRoot, "render", "other.png"),
      ),
    ).toBe(false);
    expect(
      isWorkerControlledCanonicalPreviewRev12Output(
        workspaceRoot,
        resolve(workspaceRoot, "render", "..", "..", "escape.png"),
      ),
    ).toBe(false);
  });
});

describe("Spike 8J runner is observation/reuse-only (no material/camera/light creation path)", () => {
  it("does not import or call material-creation, camera-creation, or camera-mutation primitives", () => {
    const source = readFileSync(
      resolve("tools/3ds-max/python/render_canonical_golden_corona_preview_rev12.py"),
      "utf8",
    );
    const forbidden = [
      "create_corona_physical_material",
      "rt.Freecamera(",
      "rt.Targetcamera(",
      "camera.pos =",
      "camera.rotation =",
      "camera.fov =",
      "camera.targetDistance =",
      "rt.CoronaLight(",
    ];
    for (const token of forbidden) {
      expect(source.includes(token)).toBe(false);
    }
  });
});
