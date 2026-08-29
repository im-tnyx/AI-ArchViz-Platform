import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  validateCoronaExecutionPlanV02,
  validateCoronaMaterialAppearanceEvidence,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  CoronaAdapterCompileError,
  CoronaRendererAdapter,
} from "../../apps/worker/src/corona-renderer-adapter.js";

const fixtureRoot = resolve("tests/fixtures/corona-material-appearance");
const goldenFixtureRoot = resolve("tests/fixtures/living-room-golden");

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function goldenFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(goldenFixtureRoot, path), "utf8")) as Record<
    string,
    unknown
  >;
}

function mutateFirstMaterial(
  mutator: (material: Record<string, unknown>) => void,
): Record<string, unknown> {
  const scene = structuredClone(fixture("scene-spec-v0.3.json")) as {
    materials: Array<Record<string, unknown>>;
  };
  mutator(scene.materials[0] as Record<string, unknown>);
  return scene as unknown as Record<string, unknown>;
}

describe("SceneSpec v0.3 material appearance validation", () => {
  it("accepts the dedicated v0.3 material appearance fixture", () => {
    expect(validateSceneSpec(fixture("scene-spec-v0.3.json"))).toMatchObject({ ok: true });
  });

  it("historical v0.2 Golden rev10 remains valid without roughness/metalness", () => {
    expect(
      validateSceneSpec(goldenFixture("revisions/rev_golden_0010/scene-spec.json")),
    ).toMatchObject({ ok: true });
  });

  it("historical rev10 remains v0.2 and was not touched by this spike", () => {
    const rev10 = goldenFixture("revisions/rev_golden_0010/scene-spec.json");
    expect(rev10.sceneSpecVersion).toBe("0.2.0");
  });

  it("rejects a v0.3 material missing roughness", () => {
    const scene = mutateFirstMaterial((material) => {
      delete material.roughness;
    });
    expect(validateSceneSpec(scene)).toMatchObject({ ok: false });
  });

  it("rejects a v0.3 material missing metalness", () => {
    const scene = mutateFirstMaterial((material) => {
      delete material.metalness;
    });
    expect(validateSceneSpec(scene)).toMatchObject({ ok: false });
  });

  it.each([-0.01, 1.01])("rejects roughness out of range (%d)", (value) => {
    const scene = mutateFirstMaterial((material) => {
      material.roughness = value;
    });
    expect(validateSceneSpec(scene)).toMatchObject({ ok: false });
  });

  it.each([-0.01, 1.01])("rejects metalness out of range (%d)", (value) => {
    const scene = mutateFirstMaterial((material) => {
      material.metalness = value;
    });
    expect(validateSceneSpec(scene)).toMatchObject({ ok: false });
  });

  it("rejects an unknown material appearance field", () => {
    const scene = mutateFirstMaterial((material) => {
      material.specular = 0.5;
    });
    expect(validateSceneSpec(scene)).toMatchObject({ ok: false });
  });

  it("rejects a v0.2 material carrying v0.3-only appearance fields", () => {
    const scene = structuredClone(goldenFixture("revisions/rev_golden_0010/scene-spec.json")) as {
      materials: Array<Record<string, unknown>>;
    };
    (scene.materials[0] as Record<string, unknown>).roughness = 0.5;
    (scene.materials[0] as Record<string, unknown>).metalness = 0;
    expect(validateSceneSpec(scene)).toMatchObject({ ok: false });
  });

  it("does not silently backfill v0.2 defaults into a document claiming v0.3", () => {
    const scene = structuredClone(goldenFixture("revisions/rev_golden_0010/scene-spec.json"));
    scene.sceneSpecVersion = "0.3.0";
    expect(validateSceneSpec(scene)).toMatchObject({ ok: false });
  });
});

describe("Corona plan v0.1/v0.2 adapter compatibility", () => {
  const rev10Scene = () => goldenFixture("revisions/rev_golden_0010/scene-spec.json");
  const rev10RenderJob = () => goldenFixture("render-job-v0.2-camera-living-a.json");

  it("compile() still produces plan v0.1 with legacy compatibility defaults for a v0.2 SceneSpec", () => {
    const plan = new CoronaRendererAdapter().compile(rev10Scene(), rev10RenderJob());
    expect(plan.planVersion).toBe("0.1.0");
    expect(plan.adapterDefaults.material).toEqual({ roughness: 0.45, nonMetalMode: true });
  });

  it("compileCanonicalMaterialAppearance() rejects a v0.2 SceneSpec", () => {
    expect(() =>
      new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
        rev10Scene(),
        rev10RenderJob(),
      ),
    ).toThrow(CoronaAdapterCompileError);
  });

  it("compileCanonicalMaterialAppearance() produces plan v0.2 with canonical appearance and no legacy default", () => {
    const scene = fixture("scene-spec-v0.3.json");
    const renderJob = fixture("render-job-v0.2.json");
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(scene, renderJob);
    expect(plan.planVersion).toBe("0.2.0");
    expect(plan.adapterDefaults).toEqual({ areaLight: { widthMm: 800, intensityScale: 120 } });
    expect(Object.hasOwn(plan.adapterDefaults, "material")).toBe(false);
    expect(validateCoronaExecutionPlanV02(plan).ok).toBe(true);
    expect(plan).toEqual(fixture("expected-corona-plan-v0.2.json"));
  });

  it("v0.3 has no hidden appearance fallback: schema rejects missing roughness before compile", () => {
    const scene = mutateFirstMaterial((material) => {
      delete material.roughness;
    });
    const renderJob = fixture("render-job-v0.2.json");
    expect(() =>
      new CoronaRendererAdapter().compileCanonicalMaterialAppearance(scene, renderJob),
    ).toThrow(CoronaAdapterCompileError);
  });

  it("produces deterministic material and assignment ordering", () => {
    const scene = fixture("scene-spec-v0.3.json");
    const renderJob = fixture("render-job-v0.2.json");
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(scene, renderJob);
    const materialIds = plan.materials.map((material) => material.materialId);
    expect(materialIds).toEqual([...materialIds].sort());
    const targetIds = plan.materialAssignments.map((assignment) => assignment.targetId);
    expect(targetIds).toEqual([...targetIds].sort());
  });

  it("never value-deduplicates distinct material IDs with identical appearance", () => {
    const scene = fixture("scene-spec-v0.3.json");
    const renderJob = fixture("render-job-v0.2.json");
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(scene, renderJob);
    expect(plan.materials).toHaveLength(4);
    const a = plan.materials.find(
      (material) => material.materialId === "material_appearance_a_rough",
    );
    const d = plan.materials.find(
      (material) => material.materialId === "material_appearance_d_dup",
    );
    expect(a).toBeDefined();
    expect(d).toBeDefined();
    expect(a?.materialId).not.toBe(d?.materialId);
    expect(a?.baseColorRgb).toEqual(d?.baseColorRgb);
    expect(a?.roughness).toBe(d?.roughness);
    expect(a?.metalness).toBe(d?.metalness);
  });
});

describe("Corona material appearance evidence contract", () => {
  const validEvidence = {
    evidenceVersion: "0.1.0",
    renderer: { engine: "corona", className: "Corona", version: null },
    dcc: { product: "3ds_max", version: "2025.3", compatibilityMode: true },
    safeScene: {
      safeSceneScriptExecutionEnabled: true,
      settingsLocked: true,
      lockCause: "cmdline",
      scriptAssetsProtected: true,
    },
    materials: [
      {
        materialId: "material_appearance_a_rough",
        actualClass: "_CoronaPhysicalMtl",
        canonicalBaseColorRgb: [0.55, 0.35, 0.2],
        canonicalRoughness: 0.75,
        canonicalMetalness: 0,
        observedBaseColorRgb: [0.55, 0.35, 0.2],
        observedRoughness: 0.75,
        observedMetalness: 0,
        materialInstanceName: "AVZ_CORONA_material_appearance_a_rough",
      },
    ],
    materialAssignments: [
      {
        targetId: "wall_appearance_south",
        materialId: "material_appearance_a_rough",
        materialInstanceName: "AVZ_CORONA_material_appearance_a_rough",
        className: "_CoronaPhysicalMtl",
        sharedMaterialInstance: true,
      },
    ],
    deduplication: { sameIdSharedInstance: true, differentIdDistinctInstances: true },
    status: "PASS",
  };

  it("accepts a well-formed material appearance evidence document", () => {
    expect(validateCoronaMaterialAppearanceEvidence(validEvidence).ok).toBe(true);
  });

  it("rejects evidence claiming a failed deduplication proof", () => {
    const tampered = {
      ...validEvidence,
      deduplication: { sameIdSharedInstance: false, differentIdDistinctInstances: true },
    };
    expect(validateCoronaMaterialAppearanceEvidence(tampered).ok).toBe(false);
  });

  it("rejects evidence with an out-of-range observed roughness", () => {
    const tampered = {
      ...validEvidence,
      materials: [{ ...validEvidence.materials[0], observedRoughness: 1.5 }],
    };
    expect(validateCoronaMaterialAppearanceEvidence(tampered).ok).toBe(false);
  });
});
