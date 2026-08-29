import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCoronaExecutionPlanV02 } from "@ai-archviz/worker-contracts";
import {
  type CoronaMaterialAppearanceExecutionConfig,
  executeCoronaMaterialAppearance,
} from "./corona-material-appearance-execution.js";
import { CoronaRendererAdapter } from "./corona-renderer-adapter.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";

interface MaterialAppearanceView {
  materialId: string;
  actualClass: string;
  canonicalBaseColorRgb: number[];
  canonicalRoughness: number;
  canonicalMetalness: number;
  observedBaseColorRgb: number[];
  observedRoughness: number;
  observedMetalness: number;
}

interface EvidenceView {
  renderer: { engine: string; className: string };
  dcc: { version: string; compatibilityMode: boolean };
  safeScene: { safeSceneScriptExecutionEnabled: boolean; settingsLocked: boolean };
  materials: MaterialAppearanceView[];
  materialAssignments: Array<Record<string, unknown>>;
  deduplication: { sameIdSharedInstance: boolean; differentIdDistinctInstances: boolean };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/corona-material-appearance");
const scenePath = resolve(fixtureRoot, "scene-spec-v0.3.json");
const renderJobPath = resolve(fixtureRoot, "render-job-v0.2.json");
const expectedPlanPath = resolve(fixtureRoot, "expected-corona-plan-v0.2.json");

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function executionConfig(timeoutMs = 180_000): CoronaMaterialAppearanceExecutionConfig {
  return {
    repositoryRoot,
    workspaceRoot: resolve(repositoryRoot, ".workspace/corona-material-appearance-8f"),
    processTimeoutMs: timeoutMs,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: true,
  };
}

async function expectFailure(
  code: string,
  input: { sceneSpec: Record<string, unknown>; renderJob: Record<string, unknown> },
  environment: NodeJS.ProcessEnv,
  timeoutMs = 180_000,
): Promise<void> {
  const result = await executeCoronaMaterialAppearance({
    config: executionConfig(timeoutMs),
    ...input,
    authorizeDccExecution: true,
    executionEnvironment: { ...process.env, ...environment },
  });
  assert.equal(result.status, "FAILED", JSON.stringify(result));
  assert.equal(result.error?.code, code, JSON.stringify(result));
  assert.equal(result.evidence, null);
}

async function main(): Promise<void> {
  requireDccTestApproval();
  const sceneSpec = readJson(scenePath);
  const renderJob = readJson(renderJobPath);
  const expectedPlan = readJson(expectedPlanPath);

  // Pure expected-plan oracle: no DCC.
  const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(sceneSpec, renderJob);
  assert.equal(validateCoronaExecutionPlanV02(plan).ok, true, JSON.stringify(plan));
  assert.deepEqual(plan, expectedPlan);
  assert.equal(plan.planVersion, "0.2.0");
  assert.equal(Object.hasOwn(plan.adapterDefaults as object, "material"), false);
  const materialsById = new Map(plan.materials.map((material) => [material.materialId, material]));
  assert.deepEqual(materialsById.get("material_appearance_a_rough"), {
    materialId: "material_appearance_a_rough",
    baseColorRgb: [0.55, 0.35, 0.2],
    roughness: 0.75,
    metalness: 0,
  });
  assert.deepEqual(materialsById.get("material_appearance_c_metal"), {
    materialId: "material_appearance_c_metal",
    baseColorRgb: [0.82, 0.82, 0.85],
    roughness: 0.24,
    metalness: 1,
  });
  // Different IDs with identical appearance values remain distinct plan entries.
  const a = materialsById.get("material_appearance_a_rough");
  const d = materialsById.get("material_appearance_d_dup");
  assert.notEqual(a?.materialId, d?.materialId);
  assert.deepEqual(a?.baseColorRgb, d?.baseColorRgb);
  assert.equal(a?.roughness, d?.roughness);
  assert.equal(a?.metalness, d?.metalness);

  const input = { sceneSpec, renderJob };

  const blocked = await executeCoronaMaterialAppearance({
    config: executionConfig(),
    ...input,
    authorizeDccExecution: false,
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.error?.code, "DCC_EXECUTION_DISABLED");
  assert.equal(blocked.process, null);

  const passResult = await executeCoronaMaterialAppearance({
    config: executionConfig(),
    ...input,
    authorizeDccExecution: true,
  });
  assert.equal(passResult.status, "PASS", JSON.stringify(passResult));
  const evidence = passResult.evidence as unknown as EvidenceView;
  assert.equal(evidence.renderer.engine, "corona");
  assert.equal(evidence.safeScene.safeSceneScriptExecutionEnabled, true);
  assert.equal(evidence.safeScene.settingsLocked, true);
  assert.equal(evidence.materials.length, 4);
  assert.equal(evidence.materialAssignments.length, 5);
  assert.equal(evidence.deduplication.sameIdSharedInstance, true);
  assert.equal(evidence.deduplication.differentIdDistinctInstances, true);
  const byId = new Map(evidence.materials.map((material) => [material.materialId, material]));
  const roughA = byId.get("material_appearance_a_rough");
  assert.ok(roughA, "material A evidence is required");
  assert.equal(roughA?.actualClass.toLowerCase().includes("corona"), true);
  assert.ok(Math.abs((roughA?.observedRoughness ?? -1) - 0.75) <= 0.01);
  assert.ok(Math.abs((roughA?.observedMetalness ?? -1) - 0) <= 0.01);
  const metalC = byId.get("material_appearance_c_metal");
  assert.ok(metalC, "material C evidence is required");
  assert.ok(Math.abs((metalC?.observedRoughness ?? -1) - 0.24) <= 0.01);
  assert.ok(Math.abs((metalC?.observedMetalness ?? -1) - 1) <= 0.01);
  for (const material of evidence.materials) {
    const canonicalColor = material.canonicalBaseColorRgb;
    assert.ok(
      material.observedBaseColorRgb.every(
        (value, index) => Math.abs(value - (canonicalColor[index] ?? Number.NaN)) <= 0.01,
      ),
      `base color mismatch for ${material.materialId}`,
    );
  }

  await expectFailure("SAFE_SCENE_REQUIRED", input, {
    AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "safe_scene",
  });
  await expectFailure("CORONA_NOT_FOUND", input, {
    AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "renderer_missing",
  });
  await expectFailure("CORONA_MATERIAL_CLASS_NOT_FOUND", input, {
    AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "material_missing",
  });
  await expectFailure("CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED", input, {
    AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "roughness_property_missing",
  });
  await expectFailure("CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED", input, {
    AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "metalness_property_missing",
  });
  await expectFailure("MATERIAL_APPEARANCE_EVIDENCE_INVALID", input, {
    AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "invalid_evidence",
  });
  await expectFailure(
    "PROCESS_TIMEOUT",
    input,
    { AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "timeout" },
    1,
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        suite: "Technical Spike 8F Canonical Material Appearance Contract",
        status: "PASS",
        targetDccVersion: "2026",
        testedDccVersion: evidence.dcc.version,
        compatibilityMode: passResult.compatibilityMode,
        results: {
          planOracle: "SceneSpec v0.3 -> Corona execution plan v0.2 deep-equal PASS, no DCC",
          materials:
            "4 canonical materials (rough/smooth dielectric, metallic, value-duplicate) realized",
          deduplication:
            "same materialId shared native instance; different materialId never merged by value",
          appearance:
            "canonical baseColorRgb/roughness/metalness observed on installed Corona Physical Material",
          v02Compatibility: "plan v0.2 adapterDefaults carries no legacy material default",
          failures:
            "Safe Scene, renderer, material/property, evidence, and timeout failures closed",
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
