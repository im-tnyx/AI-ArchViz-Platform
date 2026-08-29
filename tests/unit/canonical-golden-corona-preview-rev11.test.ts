import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateCanonicalCoronaPreviewEvidence,
  validateCanonicalCoronaPreviewEvidenceV02,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  calculateCanonicalGoldenCoronaPreviewRev11RequestHash,
  executeCanonicalGoldenCoronaPreviewRev11,
  isWorkerControlledCanonicalPreviewRev11Output,
} from "../../apps/worker/src/canonical-golden-corona-preview-rev11-execution.js";
import { CoronaRendererAdapter } from "../../apps/worker/src/corona-renderer-adapter.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function testHash(byte: string): string {
  return `sha256:${byte.repeat(32)}`;
}

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function rev11Scene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0011/scene-spec.json");
}

function rev10Scene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0010/scene-spec.json");
}

function rev11Manifest(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0011/expected-scene-manifest.json");
}

function renderJob(): Record<string, unknown> {
  return fixture("render-job-v0.2-camera-living-a.json");
}

function config(overrides: Partial<{ allowDccExecution: boolean }> = {}) {
  return {
    repositoryRoot: resolve("."),
    workspaceRoot: resolve(".workspace/canonical-golden-preview-rev11-unit-test"),
    processTimeoutMs: 60_000,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: overrides.allowDccExecution ?? true,
  };
}

function withPlaceholderArtifact<T>(run: (artifactPath: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "avz-canonical-preview-rev11-unit-"));
  const artifactPath = join(directory, "rev11.max");
  writeFileSync(artifactPath, "not-a-real-max-file");
  try {
    return run(artifactPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Technical Spike 8H canonical Golden Corona preview from rev11 (pure preconditions)", () => {
  it("rejects a source SceneSpec that is not exactly rev11", async () => {
    const scene = rev11Scene();
    (scene.scene as Record<string, unknown>).revisionId = "rev_golden_0010";
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev11({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev11Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CANONICAL_SOURCE_REVISION_MISMATCH");
    expect(result.process).toBeNull();
  });

  it("rejects the actual verified rev10 SceneSpec (still v0.2), before any DCC launch", async () => {
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev11({
        config: config(),
        sceneSpec: rev10Scene(),
        renderJob: renderJob(),
        expectedManifest: rev11Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CANONICAL_SOURCE_REVISION_MISMATCH");
    expect(result.process).toBeNull();
  });

  it("rejects a rev11-identified scene claiming a version whose schema its own v0.3 material shape violates", async () => {
    // A rev11 document's materials already carry roughness/metalness, so
    // relabeling it v0.2 makes it fail v0.2's schema outright (v0.2 forbids
    // those fields) rather than reach the revision/version identity check.
    const scene = rev11Scene();
    scene.sceneSpecVersion = "0.2.0";
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev11({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev11Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("SCENE_SPEC_INVALID");
    expect(result.process).toBeNull();
  });

  it("rejects a source SceneSpec whose render intent is not corona preview", async () => {
    const scene = rev11Scene();
    scene.render = { engine: "none", mode: "build_only" };
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev11({
        config: config(),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev11Manifest(),
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
      executeCanonicalGoldenCoronaPreviewRev11({
        config: config(),
        sceneSpec: rev11Scene(),
        renderJob: job,
        expectedManifest: rev11Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CAMERA_NOT_FOUND");
    expect(result.process).toBeNull();
  });

  it("stays BLOCKED under default-deny even when the call site authorizes it, with no SceneSpec mutation", async () => {
    const scene = rev11Scene();
    const sourceOrder = structuredClone(scene);
    const result = await withPlaceholderArtifact((verifiedArtifactPath) =>
      executeCanonicalGoldenCoronaPreviewRev11({
        config: config({ allowDccExecution: false }),
        sceneSpec: scene,
        renderJob: renderJob(),
        expectedManifest: rev11Manifest(),
        verifiedArtifactPath,
        authorizeDccExecution: true,
      }),
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.error?.code).toBe("DCC_EXECUTION_DISABLED");
    expect(result.process).toBeNull();
    expect(scene).toEqual(sourceOrder);
  });

  it("compiles through compileCanonicalMaterialAppearance() only, producing plan v0.2 with no adapter material default", () => {
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
      rev11Scene(),
      renderJob(),
    );
    expect(plan.planVersion).toBe("0.2.0");
    expect(plan.adapterDefaults).not.toHaveProperty("material");
    expect(plan.revisionId).toBe("rev_golden_0011");
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
});

describe("canonical Golden Corona preview rev11 request hash", () => {
  it("is deterministic and excludes paths, PID, timestamp, and PNG hash", () => {
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
      rev11Scene(),
      renderJob(),
    );
    const first = calculateCanonicalGoldenCoronaPreviewRev11RequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    const second = calculateCanonicalGoldenCoronaPreviewRev11RequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("changes when the SceneSpec hash or the canonical artifact hash changes", () => {
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
      rev11Scene(),
      renderJob(),
    );
    const base = calculateCanonicalGoldenCoronaPreviewRev11RequestHash(
      plan,
      testHash("aa"),
      testHash("bb"),
    );
    const differentScene = calculateCanonicalGoldenCoronaPreviewRev11RequestHash(
      plan,
      testHash("cc"),
      testHash("bb"),
    );
    const differentArtifact = calculateCanonicalGoldenCoronaPreviewRev11RequestHash(
      plan,
      testHash("aa"),
      testHash("dd"),
    );
    expect(differentScene).not.toBe(base);
    expect(differentArtifact).not.toBe(base);
  });
});

describe("canonical Golden Corona preview evidence v0.1 remains untouched by 8H", () => {
  it("still validates the exact rev10 temporary-material evidence shape", () => {
    const rev10Evidence = {
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
      output: { format: "png", byteLength: 512, sha256: testHash("ee") },
      status: "PASS",
    };
    expect(validateCanonicalCoronaPreviewEvidence(rev10Evidence).ok).toBe(true);
    // v0.2 evidence must never satisfy the v0.1 contract and vice versa.
    expect(
      validateCanonicalCoronaPreviewEvidence({ ...rev10Evidence, evidenceVersion: "0.2.0" }).ok,
    ).toBe(false);
  });
});

describe("canonical Golden Corona preview evidence v0.2 (rev11 persisted materials)", () => {
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
  const validEvidence = {
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
    materials: [validMaterial],
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

  it("accepts a well-formed canonical rev11 evidence document", () => {
    expect(validateCanonicalCoronaPreviewEvidenceV02(validEvidence).ok).toBe(true);
  });

  it("rejects evidence for a revision other than rev11", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV02({ ...validEvidence, revisionId: "rev_golden_0010" })
        .ok,
    ).toBe(false);
  });

  it("rejects a SceneSpec version other than 0.3.0", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV02({ ...validEvidence, sceneSpecVersion: "0.2.0" }).ok,
    ).toBe(false);
  });

  it("rejects the obsolete temporary AVZ_CORONA_* material naming (8E realization, not 8G persistence)", () => {
    const tampered = {
      ...validEvidence,
      materials: [{ ...validMaterial, materialInstanceName: "AVZ_CORONA_material_wall_neutral" }],
    };
    expect(validateCanonicalCoronaPreviewEvidenceV02(tampered).ok).toBe(false);
  });

  it("rejects a native class other than the persisted Corona Physical Material", () => {
    const tampered = {
      ...validEvidence,
      materials: [{ ...validMaterial, actualClass: "Standard" }],
    };
    expect(validateCanonicalCoronaPreviewEvidenceV02(tampered).ok).toBe(false);
  });

  it("rejects an out-of-range observed roughness or metalness", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV02({
        ...validEvidence,
        materials: [{ ...validMaterial, observedRoughness: 1.5 }],
      }).ok,
    ).toBe(false);
    expect(
      validateCanonicalCoronaPreviewEvidenceV02({
        ...validEvidence,
        materials: [{ ...validMaterial, observedMetalness: -0.1 }],
      }).ok,
    ).toBe(false);
  });

  it("rejects a deduplication proof that is not both true", () => {
    expect(
      validateCanonicalCoronaPreviewEvidenceV02({
        ...validEvidence,
        deduplication: { sameIdSharedInstance: false, differentIdDistinctInstances: true },
      }).ok,
    ).toBe(false);
  });

  it("rejects a non-CoronaLight canonical light class", () => {
    const tampered = {
      ...validEvidence,
      canonicalLights: [{ ...validEvidence.canonicalLights[0], actualClass: "Omnilight" }],
    };
    expect(validateCanonicalCoronaPreviewEvidenceV02(tampered).ok).toBe(false);
  });
});

describe("canonical Golden Corona preview rev11 output path containment", () => {
  it("accepts only the exact worker-controlled render output path", () => {
    const workspaceRoot = resolve("/tmp/canonical-preview-rev11-workspace");
    expect(
      isWorkerControlledCanonicalPreviewRev11Output(
        workspaceRoot,
        resolve(workspaceRoot, "render", "canonical-golden-preview-rev11.png"),
      ),
    ).toBe(true);
    expect(
      isWorkerControlledCanonicalPreviewRev11Output(
        workspaceRoot,
        resolve(workspaceRoot, "render", "other.png"),
      ),
    ).toBe(false);
    expect(
      isWorkerControlledCanonicalPreviewRev11Output(
        workspaceRoot,
        resolve(workspaceRoot, "render", "..", "..", "escape.png"),
      ),
    ).toBe(false);
  });
});
