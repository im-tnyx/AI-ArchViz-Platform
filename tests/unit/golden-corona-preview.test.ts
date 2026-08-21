import { readFileSync } from "node:fs";
import {
  semanticJsonHash,
  validateGoldenCoronaPreviewEvidence,
  validateGoldenCoronaPreviewPlan,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  CoronaAdapterCompileError,
  CoronaRendererAdapter,
  deriveCameraFovRadians,
  goldenLivingCoronaPreviewProfile,
} from "../../apps/worker/src/corona-renderer-adapter.js";
import {
  calculateGoldenCoronaPreviewRequestHash,
  isWorkerControlledGoldenPreviewOutput,
} from "../../apps/worker/src/golden-corona-preview-execution.js";

const scene = JSON.parse(
  readFileSync(
    "tests/fixtures/living-room-golden/revisions/rev_golden_0008/scene-spec.json",
    "utf8",
  ),
);
const artifactHash = `sha256:${"a".repeat(64)}`;

function compile() {
  return new CoronaRendererAdapter().compileDiagnosticPreview(scene, {
    artifactHash,
    sceneSpecHash: semanticJsonHash(scene),
  });
}

function expectCode(callback: () => unknown, code: string): void {
  try {
    callback();
    throw new Error("Expected diagnostic preview compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CoronaAdapterCompileError);
    expect((error as CoronaAdapterCompileError).code).toBe(code);
  }
}

describe("Golden Corona diagnostic preview", () => {
  it("uses an immutable repository-owned profile and leaves normal 8B compilation strict", () => {
    expect(Object.isFrozen(goldenLivingCoronaPreviewProfile)).toBe(true);
    expect(Object.isFrozen(goldenLivingCoronaPreviewProfile.lightRig)).toBe(true);
    const previewLight = goldenLivingCoronaPreviewProfile.lightRig[0];
    expect(previewLight).toBeDefined();
    expect(Object.isFrozen(previewLight)).toBe(true);
    expect(Object.isFrozen(previewLight?.position)).toBe(true);
    expectCode(
      () =>
        new CoronaRendererAdapter().compile(scene, {
          renderJobVersion: "0.2.0",
          engine: "corona",
          cameraId: "camera_living_a",
          mode: "preview",
          resolution: { width: 320, height: 240 },
        }),
      "RENDERER_NOT_REQUIRED",
    );
  });

  it("compiles Golden rev8 provenance, canonical materials, assignments, and camera deterministically", () => {
    const before = structuredClone(scene);
    const plan = compile();
    expect(validateGoldenCoronaPreviewPlan(plan).ok).toBe(true);
    expect(scene).toEqual(before);
    expect(plan.source).toEqual({
      projectId: "project_golden_living_001",
      sceneId: "scene_golden_living_001",
      revisionId: "rev_golden_0008",
      sceneSpecHash: semanticJsonHash(scene),
      artifactHash,
    });
    expect(plan.materials.map((entry) => entry.materialId)).toEqual([
      "material_floor_neutral",
      "material_sofa_proxy",
      "material_wall_neutral",
    ]);
    expect(plan.materialAssignments.map((entry) => entry.targetId)).toEqual([
      "asset_living_sofa_main",
      "surface_floor_main",
      "wall_east",
      "wall_north",
      "wall_south",
      "wall_west",
    ]);
    expect(plan.camera).toMatchObject({
      logicalId: "camera_living_a",
      position: [1200, 3800, 1500],
      target: [3000, 200, 1300],
      focalLengthMm: 24,
      sensorWidthMm: 36,
    });
    expect(plan.camera.fovRadians).toBeCloseTo(deriveCameraFovRadians(24, 36), 14);
  });

  it("records the non-canonical preview light separately and hashes only semantic execution inputs", () => {
    const plan = compile();
    expect(plan.temporaryLight).toEqual({
      logicalId: "preview_key_area",
      type: "area",
      position: [3000, 1600, 2800],
      rotationEuler: [-35, 0, 0],
      canonicalIntensity: 1.25,
      mappedIntensity: 150,
      widthMm: 800,
      executionOnlyName: "AVZ_PREVIEW_CORONA_KEY",
    });
    expect(calculateGoldenCoronaPreviewRequestHash(plan)).toBe(
      calculateGoldenCoronaPreviewRequestHash(structuredClone(plan)),
    );
    expect(
      isWorkerControlledGoldenPreviewOutput(
        "C:/worker/run",
        "C:/worker/run/render/golden-living-preview.png",
      ),
    ).toBe(true);
    expect(
      isWorkerControlledGoldenPreviewOutput("C:/worker/run", "C:/worker/run/render/user.png"),
    ).toBe(false);
  });

  it("fails closed for a wrong source revision or non-hash provenance", () => {
    const wrongRevision = structuredClone(scene);
    wrongRevision.scene.revisionId = "rev_golden_0007";
    wrongRevision.scene.headRevisionId = "rev_golden_0007";
    expectCode(
      () =>
        new CoronaRendererAdapter().compileDiagnosticPreview(wrongRevision, {
          artifactHash,
          sceneSpecHash: semanticJsonHash(wrongRevision),
        }),
      "RENDERER_NOT_REQUIRED",
    );
    expectCode(
      () =>
        new CoronaRendererAdapter().compileDiagnosticPreview(scene, {
          artifactHash: "unsafe-path",
          sceneSpecHash: semanticJsonHash(scene),
        }),
      "SCENE_SPEC_INVALID",
    );
  });

  it("rejects path-like or executable evidence fields", () => {
    const plan = compile();
    expect(validateGoldenCoronaPreviewPlan({ ...plan, script: "unsafe" }).ok).toBe(false);
    const evidence = {
      evidenceVersion: "0.1.0",
      source: { ...plan.source, stagedArtifactHash: artifactHash },
      intentSource: "trusted_diagnostic_profile",
      profileId: "golden_living_corona_preview_v1",
      renderer: { engine: "corona", className: "Corona", version: null },
      dcc: { product: "3ds_max", version: "2025.3", compatibilityMode: true },
      canonical: {
        managedNodeCount: 14,
        camera: { ...plan.camera, className: "Freecamera", lookAtTarget: true },
        materials: plan.materials.map((entry) => ({
          materialId: entry.materialId,
          className: "_CoronaPhysicalMtl",
          materialInstanceName: `AVZ_PREVIEW_CORONA_${entry.materialId}`,
          canonicalBaseColorRgb: entry.baseColorRgb,
        })),
        materialAssignments: plan.materialAssignments.map((entry) => ({
          targetId: entry.targetId,
          materialId: entry.materialId,
          className: "_CoronaPhysicalMtl",
          materialInstanceName: `AVZ_PREVIEW_CORONA_${entry.materialId}`,
          sharedMaterialInstance: true,
        })),
      },
      temporaryExecution: {
        light: {
          id: "preview_key_area",
          name: "AVZ_PREVIEW_CORONA_KEY",
          className: "CoronaLight",
          nonCanonical: true,
          position: [3000, 1600, 2800],
          rotationEuler: [-35, 0, 0],
          canonicalIntensity: 1.25,
          mappedIntensity: 150,
          widthMm: 800,
        },
        adapterDefaults: {
          roughness: 0.45,
          nonMetalMode: true,
          areaLightWidthMm: 800,
          areaLightIntensityScale: 120,
        },
        stagedArtifactUnchanged: true,
      },
      render: plan.render,
      output: { format: "png", byteLength: 1, sha256: artifactHash },
      status: "PASS",
    };
    expect(validateGoldenCoronaPreviewEvidence(evidence).ok).toBe(true);
    expect(
      validateGoldenCoronaPreviewEvidence({ ...evidence, outputPath: "C:/unsafe.png" }).ok,
    ).toBe(false);
  });
});
