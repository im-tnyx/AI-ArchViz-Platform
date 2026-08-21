import { readFileSync } from "node:fs";
import { validateCoronaExecutionPlan, validateRenderJobV02 } from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  CoronaAdapterCompileError,
  CoronaRendererAdapter,
  deriveCameraFovRadians,
} from "../../apps/worker/src/corona-renderer-adapter.js";

const fixturePath = "tests/fixtures/corona-adapter";
const scene = JSON.parse(readFileSync(`${fixturePath}/scene-spec.json`, "utf8"));
const job = JSON.parse(readFileSync(`${fixturePath}/render-job.json`, "utf8"));
const expectedPlan = JSON.parse(readFileSync(`${fixturePath}/expected-plan.json`, "utf8"));

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compile(input = scene, renderJob = job) {
  return new CoronaRendererAdapter().compile(input, renderJob);
}

function expectCompileCode(callback: () => unknown, code: string): void {
  try {
    callback();
    throw new Error("Expected Corona adapter compilation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CoronaAdapterCompileError);
    expect((error as CoronaAdapterCompileError).code).toBe(code);
  }
}

describe("CoronaRendererAdapter", () => {
  it("compiles the dedicated SceneSpec fixture into the deterministic expected plan", () => {
    const plan = compile();
    expect(plan).toEqual(expectedPlan);
    expect(validateCoronaExecutionPlan(plan).ok).toBe(true);
    expect(plan.materials.map((material) => material.materialId)).toEqual([
      "material_adapter_floor",
      "material_adapter_subject",
      "material_adapter_wall",
    ]);
    expect(plan.materialAssignments.map((assignment) => assignment.targetId)).toEqual([
      "asset_adapter_subject",
      "surface_adapter_floor",
      "wall_adapter_north",
      "wall_adapter_south",
    ]);
  });

  it("keeps Corona defaults separate from canonical SceneSpec material and light values", () => {
    const plan = compile();
    expect(
      plan.materials.find((entry) => entry.materialId === "material_adapter_subject"),
    ).toMatchObject({ baseColorRgb: [0.72, 0.62, 0.5] });
    expect(plan.adapterDefaults).toEqual({
      material: { roughness: 0.45, nonMetalMode: true },
      areaLight: { widthMm: 800, intensityScale: 120 },
    });
    expect(plan.lights).toEqual([
      expect.objectContaining({ canonicalIntensity: 1.25, mappedIntensity: 150 }),
    ]);
  });

  it("derives native camera FOV from the canonical focal length and sensor width", () => {
    expect(deriveCameraFovRadians(35, 36)).toBeCloseTo(0.9500215125301936, 14);
    expect(compile().camera).toMatchObject({
      logicalId: "camera_adapter_main",
      position: [3000, -5000, 2300],
      target: [3000, 1900, 1200],
      focalLengthMm: 35,
      sensorWidthMm: 36,
    });
  });

  it("fails closed for engine, mode, and camera selection mistakes", () => {
    const noneScene = clone(scene);
    noneScene.render.engine = "none";
    expectCompileCode(() => compile(noneScene), "RENDERER_NOT_REQUIRED");

    const vrayScene = clone(scene);
    vrayScene.render.engine = "vray";
    expectCompileCode(() => compile(vrayScene), "WRONG_RENDERER_ADAPTER");

    const finalScene = clone(scene);
    finalScene.render.mode = "final";
    expectCompileCode(() => compile(finalScene), "RENDER_MODE_UNSUPPORTED");

    const missingCameraJob = { ...job, cameraId: "camera_missing" };
    expectCompileCode(() => compile(scene, missingCameraJob), "CAMERA_NOT_FOUND");

    const duplicateCameraScene = clone(scene);
    duplicateCameraScene.cameras.push(clone(duplicateCameraScene.cameras[0]));
    expectCompileCode(() => compile(duplicateCameraScene), "CAMERA_ID_AMBIGUOUS");
  });

  it("rejects missing, duplicate, and ambiguous material assignments before DCC", () => {
    const missingMaterialScene = clone(scene);
    missingMaterialScene.materialAssignments[0].materialId = "material_missing";
    expectCompileCode(() => compile(missingMaterialScene), "MATERIAL_ASSIGNMENT_MATERIAL_MISSING");

    const duplicateMaterialScene = clone(scene);
    duplicateMaterialScene.materials.push({
      ...clone(duplicateMaterialScene.materials[0]),
      name: "Duplicate canonical material id",
    });
    expectCompileCode(() => compile(duplicateMaterialScene), "MATERIAL_ID_DUPLICATE");

    const missingTargetScene = clone(scene);
    missingTargetScene.materialAssignments[0].targetId = "target_missing";
    expectCompileCode(() => compile(missingTargetScene), "MATERIAL_ASSIGNMENT_TARGET_MISSING");

    const duplicateAssignmentScene = clone(scene);
    duplicateAssignmentScene.materialAssignments.push({
      id: "assign_adapter_duplicate",
      targetId: "wall_adapter_south",
      materialId: "material_adapter_floor",
    });
    expectCompileCode(
      () => compile(duplicateAssignmentScene),
      "MATERIAL_ASSIGNMENT_DUPLICATE_TARGET",
    );
  });

  it("supports only canonical area lights", () => {
    const pointScene = clone(scene);
    pointScene.lights[0].type = "point";
    expectCompileCode(() => compile(pointScene), "RENDERER_LIGHT_TYPE_UNSUPPORTED");

    const directionalScene = clone(scene);
    directionalScene.lights[0].type = "directional";
    expectCompileCode(() => compile(directionalScene), "RENDERER_LIGHT_TYPE_UNSUPPORTED");
  });

  it("orders plans independently from input array ordering and rejects executable job fields", () => {
    const reordered = clone(scene);
    reordered.materials.reverse();
    reordered.materialAssignments.reverse();
    expect(compile(reordered)).toEqual(expectedPlan);
    expect(validateRenderJobV02({ ...job, script: "unsafe" }).ok).toBe(false);
    expect(validateCoronaExecutionPlan({ ...expectedPlan, python: "unsafe" }).ok).toBe(false);
  });
});
