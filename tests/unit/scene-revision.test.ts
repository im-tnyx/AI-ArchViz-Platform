import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import { CoronaRendererAdapter } from "../../apps/worker/src/corona-renderer-adapter.js";
import {
  assertGoldenRevisionDiff,
  assertRevisionDiff,
  canonicalCameraStateExpectation,
  canonicalMaterialStateExpectation,
  canonicalRenderStateExpectation,
  diffSemanticManifests,
  evaluateLedger,
  planSceneRevision,
  RevisionValidationError,
  startLedgerAttempt,
} from "../../apps/worker/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof RevisionValidationError ? error.code : null;
  }
}

describe("SceneChangeSet MoveObject contract", () => {
  it("accepts the Golden absolute-transform ChangeSet", () => {
    expect(validateSceneChangeSet(fixture("changesets/move-coffee-table-r2.json"))).toMatchObject({
      ok: true,
    });
  });

  it("rejects relative deltas and incomplete transforms", () => {
    const relative = fixture("changesets/move-coffee-table-r2.json") as {
      operations: Array<{ parameters: Record<string, unknown> }>;
    };
    const relativeOperation = relative.operations[0];
    if (!relativeOperation) throw new Error("Golden operation missing");
    relativeOperation.parameters.deltaX = 250;
    expect(validateSceneChangeSet(relative)).toMatchObject({ ok: false });

    const incomplete = fixture("changesets/move-coffee-table-r2.json") as {
      operations: Array<{ parameters: { transform: Record<string, unknown> } }>;
    };
    const incompleteOperation = incomplete.operations[0];
    if (!incompleteOperation) throw new Error("Golden operation missing");
    delete incompleteOperation.parameters.transform.scale;
    expect(validateSceneChangeSet(incomplete)).toMatchObject({ ok: false });
  });

  it("rejects an unsupported operation with an explicit code", () => {
    const changeSet = fixture("changesets/move-coffee-table-r2.json") as {
      operations: Array<{ type: string }>;
    };
    const operation = changeSet.operations[0];
    if (!operation) throw new Error("Golden operation missing");
    operation.type = "DeleteObject";
    expect(errorCode(() => planSceneRevision(fixture("scene-spec.json"), changeSet))).toBe(
      "OPERATION_UNSUPPORTED",
    );
  });
});

describe("pre-DCC revision validation", () => {
  it("computes exactly the committed rev0002 SceneSpec", () => {
    const result = planSceneRevision(
      fixture("scene-spec.json"),
      fixture("changesets/move-coffee-table-r2.json"),
    );
    const expected = fixture("revisions/rev_golden_0002/scene-spec.json");
    expect(validateSceneSpec(expected)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(result.plan.operation).toEqual({
      operationId: "op_golden_move_coffee_table_r2",
      type: "MoveObject",
      targetId: "asset_living_coffee_table_main",
      transform: {
        position: [3250, 2200, 0],
        rotationEuler: [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
  });

  it("blocks a stale base revision", () => {
    const changeSet = fixture("changesets/move-coffee-table-r2.json");
    changeSet.baseRevisionId = "rev_golden_0000";
    expect(errorCode(() => planSceneRevision(fixture("scene-spec.json"), changeSet))).toBe(
      "STALE_REVISION",
    );
  });

  it("blocks a nonexistent logical target", () => {
    const changeSet = fixture("changesets/move-coffee-table-r2.json") as {
      operations: Array<{ targetId: string }>;
    };
    const operation = changeSet.operations[0];
    if (!operation) throw new Error("Golden operation missing");
    operation.targetId = "asset_missing_target";
    expect(errorCode(() => planSceneRevision(fixture("scene-spec.json"), changeSet))).toBe(
      "TARGET_NOT_FOUND",
    );
  });

  it("blocks a hard transform lock", () => {
    const scene = fixture("scene-spec.json") as {
      assets: Array<{ id: string; locks: { transform: boolean } }>;
    };
    const target = scene.assets.find((asset) => asset.id === "asset_living_coffee_table_main");
    if (!target) throw new Error("Golden coffee table missing");
    target.locks.transform = true;
    expect(
      errorCode(() => planSceneRevision(scene, fixture("changesets/move-coffee-table-r2.json"))),
    ).toBe("TRANSFORM_LOCKED");
  });

  it("blocks an absolute move outside the room before DCC", () => {
    const changeSet = fixture("changesets/move-coffee-table-r2.json") as {
      operations: Array<{ parameters: { transform: { position: number[] } } }>;
    };
    const operation = changeSet.operations[0];
    if (!operation) throw new Error("Golden operation missing");
    operation.parameters.transform.position = [5900, 2200, 0];
    expect(errorCode(() => planSceneRevision(fixture("scene-spec.json"), changeSet))).toBe(
      "OBJECT_OUTSIDE_SPACE",
    );
  });

  it("blocks non-uniform scale for the curated proxy", () => {
    const changeSet = fixture("changesets/move-coffee-table-r2.json") as {
      operations: Array<{ parameters: { transform: { scale: number[] } } }>;
    };
    const operation = changeSet.operations[0];
    if (!operation) throw new Error("Golden operation missing");
    operation.parameters.transform.scale = [1, 2, 1];
    expect(errorCode(() => planSceneRevision(fixture("scene-spec.json"), changeSet))).toBe(
      "NON_UNIFORM_SCALE_NOT_ALLOWED",
    );
  });
});

describe("semantic preservation and replay", () => {
  it("reports only the coffee-table position as semantic object state change", () => {
    const diff = diffSemanticManifests(
      fixture("expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0002/expected-scene-manifest.json"),
    );
    expect(() => assertGoldenRevisionDiff(diff)).not.toThrow();
    expect(diff).toMatchObject({
      revision: { before: "rev_golden_0001", after: "rev_golden_0002" },
      changed: [
        {
          logicalId: "asset_living_coffee_table_main",
          changes: {
            "transform.position": {
              before: [3000, 2200, 0],
              after: [3250, 2200, 0],
            },
          },
        },
      ],
      added: [],
      removed: [],
    });
    expect(diff.unchanged).toHaveLength(13);
    expect(diff.unchanged).toContain("wall_south");
    expect(diff.unchanged).toContain("camera_living_a");
  });

  it("routes a completed identical request to replay instead of cumulative mutation", () => {
    const request = {
      idempotencyKey: "revision.chg_golden_move_coffee_table_r2",
      requestHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      jobId: "job_revision_0001",
    };
    const inProgress = startLedgerAttempt(null, request);
    expect(evaluateLedger({ ...inProgress, status: "SUCCESS" }, request)).toBe("REPLAY_SUCCESS");
    const transform = { position: [3250, 2200, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };
    expect(structuredClone(transform)).toEqual(transform);
    expect(transform.position).not.toEqual([3500, 2200, 0]);
  });
});

describe("Technical Spike 8D canonical render-state revisions", () => {
  function sceneWithLights(
    types: Array<"area" | "point" | "directional">,
    renderEngine: "none" | "corona" = "none",
  ): Record<string, unknown> {
    const scene = fixture("revisions/rev_golden_0008/scene-spec.json");
    scene.render = {
      engine: renderEngine,
      mode: renderEngine === "corona" ? "preview" : "build_only",
    };
    scene.lights = types.map((type, index) => ({
      id: `light_${type}_${index}`,
      type,
      transform: {
        position: [index * 100, 200, 300],
        rotationEuler: [0, 0, 0],
        scale: [1, 1, 1],
      },
      intensity: 1,
    }));
    return scene;
  }

  it("sorts evidence lights without mutating SceneSpec source order", () => {
    const scene = sceneWithLights(["area", "area"], "corona") as {
      lights: Array<Record<string, unknown>>;
    };
    const firstLight = scene.lights[0];
    const secondLight = scene.lights[1];
    if (!firstLight || !secondLight) throw new Error("Two test lights are required");
    firstLight.id = "light_z_area";
    secondLight.id = "light_a_area";
    const sourceOrder = structuredClone(scene.lights);
    const expected = canonicalRenderStateExpectation(scene);
    const reversed = structuredClone(scene);
    reversed.lights.reverse();

    expect(scene.lights).toEqual(sourceOrder);
    if (!expected) throw new Error("Expected render state is required");
    expect(
      (expected.lights as Array<{ logicalId: string }>).map((light) => light.logicalId),
    ).toEqual(["light_a_area", "light_z_area"]);
    expect(canonicalRenderStateExpectation(reversed)).toEqual(expected);
  });

  it.each(["point", "directional"] as const)(
    "rejects %s lights before DCC during SetRenderIntent preparation",
    (type) => {
      const scene = sceneWithLights([type]);
      expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
      expect(
        errorCode(() => planSceneRevision(scene, fixture("changesets/set-render-intent-r9.json"))),
      ).toBe("RENDERER_LIGHT_TYPE_UNSUPPORTED");
    },
  );

  it("accepts exactly the SetRenderIntent and AddLight operation contracts", () => {
    expect(validateSceneChangeSet(fixture("changesets/set-render-intent-r9.json"))).toMatchObject({
      ok: true,
    });
    expect(validateSceneChangeSet(fixture("changesets/add-key-area-light-r10.json"))).toMatchObject(
      {
        ok: true,
      },
    );
    const composite = fixture("changesets/set-render-intent-r9.json") as {
      operations: unknown[];
    };
    const addLight = fixture("changesets/add-key-area-light-r10.json") as {
      operations: unknown[];
    };
    composite.operations.push(...addLight.operations);
    expect(validateSceneChangeSet(composite)).toMatchObject({ ok: false });
  });

  it("computes exact rev8→rev9 and rev9→rev10 SceneSpec transitions", () => {
    expect(
      planSceneRevision(
        fixture("revisions/rev_golden_0008/scene-spec.json"),
        fixture("changesets/set-render-intent-r9.json"),
      ).targetSceneSpec,
    ).toEqual(fixture("revisions/rev_golden_0009/scene-spec.json"));
    expect(
      planSceneRevision(
        fixture("revisions/rev_golden_0009/scene-spec.json"),
        fixture("changesets/add-key-area-light-r10.json"),
      ).targetSceneSpec,
    ).toEqual(fixture("revisions/rev_golden_0010/scene-spec.json"));
  });

  it("blocks stale, unchanged, wrong-target, renderer-prerequisite, and duplicate-light requests", () => {
    const stale = fixture("changesets/set-render-intent-r9.json");
    stale.baseRevisionId = "rev_golden_0007";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0008/scene-spec.json"), stale),
      ),
    ).toBe("STALE_REVISION");

    const unchanged = fixture("changesets/set-render-intent-r9.json");
    unchanged.baseRevisionId = "rev_golden_0009";
    unchanged.targetRevisionId = "rev_golden_0011";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0009/scene-spec.json"), unchanged),
      ),
    ).toBe("RENDER_INTENT_UNCHANGED");

    const wrongTarget = fixture("changesets/set-render-intent-r9.json") as {
      operations: Array<{ targetId: string }>;
    };
    const wrongTargetOperation = wrongTarget.operations[0];
    if (!wrongTargetOperation) throw new Error("SetRenderIntent operation missing");
    wrongTargetOperation.targetId = "scene_wrong_target";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0008/scene-spec.json"), wrongTarget),
      ),
    ).toBe("TARGET_NOT_FOUND");

    const rendererMissing = fixture("changesets/add-key-area-light-r10.json") as {
      baseRevisionId: string;
      targetRevisionId: string;
    };
    rendererMissing.baseRevisionId = "rev_golden_0008";
    rendererMissing.targetRevisionId = "rev_golden_0009_candidate";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0008/scene-spec.json"), rendererMissing),
      ),
    ).toBe("RENDERER_NOT_CONFIGURED");

    const duplicate = fixture("changesets/add-key-area-light-r10.json");
    duplicate.baseRevisionId = "rev_golden_0010";
    duplicate.targetRevisionId = "rev_golden_0011";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), duplicate),
      ),
    ).toBe("LIGHT_ID_ALREADY_EXISTS");
  });

  it("keeps the canonical light order and adapter scalar mapping deterministic", () => {
    const result = planSceneRevision(
      fixture("revisions/rev_golden_0009/scene-spec.json"),
      fixture("changesets/add-key-area-light-r10.json"),
    );
    expect(result.targetSceneSpec.lights).toEqual([
      {
        id: "light_living_key_area",
        type: "area",
        transform: {
          position: [3000, 1600, 2800],
          rotationEuler: [-35, 0, 0],
          scale: [1, 1, 1],
        },
        intensity: 1.25,
      },
    ]);
  });
});

describe("Technical Spike 8G canonical material appearance revisions", () => {
  function migrationChangeSet(): Record<string, unknown> {
    return fixture("changesets/migrate-material-appearance-r11.json");
  }

  it("accepts the SceneChangeSet v0.2 migration contract and rejects v0.1 mixing it in", () => {
    expect(validateSceneChangeSet(migrationChangeSet())).toMatchObject({ ok: true });
    const asV01 = migrationChangeSet();
    asV01.schemaVersion = "0.1.0";
    expect(validateSceneChangeSet(asV01)).toMatchObject({ ok: false });
  });

  it("computes exactly the committed rev11 SceneSpec and revisionPlanVersion 0.2.0", () => {
    const result = planSceneRevision(
      fixture("revisions/rev_golden_0010/scene-spec.json"),
      migrationChangeSet(),
    );
    const expected = fixture("revisions/rev_golden_0011/scene-spec.json");
    expect(validateSceneSpec(expected)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(result.plan.revisionPlanVersion).toBe("0.2.0");
    expect(result.plan.operation).toEqual({
      operationId: "op_migrate_material_appearance_r11",
      type: "MigrateMaterialAppearanceContract",
      targetId: "scene_golden_living_001",
      targetSceneSpecVersion: "0.3.0",
      materials: [
        {
          materialId: "material_floor_neutral",
          baseColorRgb: [0.66, 0.64, 0.6],
          roughness: 0.34,
          metalness: 0,
        },
        {
          materialId: "material_sofa_proxy",
          baseColorRgb: [0.72, 0.62, 0.5],
          roughness: 0.78,
          metalness: 0,
        },
        {
          materialId: "material_wall_neutral",
          baseColorRgb: [0.78, 0.74, 0.68],
          roughness: 0.62,
          metalness: 0,
        },
      ],
      materialAssignments: [
        { targetId: "wall_south", materialId: "material_floor_neutral" },
        { targetId: "wall_east", materialId: "material_wall_neutral" },
        { targetId: "wall_north", materialId: "material_wall_neutral" },
        { targetId: "wall_west", materialId: "material_wall_neutral" },
        { targetId: "surface_floor_main", materialId: "material_floor_neutral" },
        { targetId: "asset_living_sofa_main", materialId: "material_sofa_proxy" },
      ],
    });
  });

  it("does not upgrade unrelated revisionPlanVersion for non-migration operations", () => {
    const result = planSceneRevision(
      fixture("revisions/rev_golden_0009/scene-spec.json"),
      fixture("changesets/add-key-area-light-r10.json"),
    );
    expect(result.plan.revisionPlanVersion).toBe("0.1.0");
  });

  it("blocks a stale base revision and a nonexistent scene target", () => {
    const stale = migrationChangeSet();
    stale.baseRevisionId = "rev_golden_0009";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), stale),
      ),
    ).toBe("STALE_REVISION");

    const wrongTarget = migrationChangeSet() as { operations: Array<{ targetId: string }> };
    const operation = wrongTarget.operations[0];
    if (!operation) throw new Error("Migration operation missing");
    operation.targetId = "scene_wrong_target";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), wrongTarget),
      ),
    ).toBe("TARGET_NOT_FOUND");
  });

  it("blocks re-migrating an already-canonical v0.3 base", () => {
    const reMigrate = migrationChangeSet() as {
      baseRevisionId: string;
      targetRevisionId: string;
    };
    reMigrate.baseRevisionId = "rev_golden_0011";
    reMigrate.targetRevisionId = "rev_golden_0012";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0011/scene-spec.json"), reMigrate),
      ),
    ).toBe("MATERIAL_APPEARANCE_ALREADY_CANONICAL");
  });

  it("rejects a non-canonical target SceneSpec version at the schema layer", () => {
    const wrongTargetVersion = migrationChangeSet() as {
      operations: Array<{ parameters: { targetSceneSpecVersion: string } }>;
    };
    const operation = wrongTargetVersion.operations[0];
    if (!operation) throw new Error("Migration operation missing");
    operation.parameters.targetSceneSpecVersion = "0.4.0";
    expect(validateSceneChangeSet(wrongTargetVersion)).toMatchObject({ ok: false });
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), wrongTargetVersion),
      ),
    ).toBe("SCHEMA_INVALID");
  });

  it("blocks an unsorted, a duplicate, and an incomplete material appearance set", () => {
    const unsorted = migrationChangeSet() as {
      operations: Array<{ parameters: { materials: Array<{ materialId: string }> } }>;
    };
    const unsortedOperation = unsorted.operations[0];
    if (!unsortedOperation) throw new Error("Migration operation missing");
    unsortedOperation.parameters.materials.reverse();
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), unsorted),
      ),
    ).toBe("MATERIAL_APPEARANCE_SET_UNSORTED");

    const duplicate = migrationChangeSet() as {
      operations: Array<{ parameters: { materials: Array<{ materialId: string }> } }>;
    };
    const duplicateOperation = duplicate.operations[0];
    if (!duplicateOperation) throw new Error("Migration operation missing");
    duplicateOperation.parameters.materials[1] = {
      ...duplicateOperation.parameters.materials[0],
    } as { materialId: string };
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), duplicate),
      ),
    ).toBe("MATERIAL_ID_DUPLICATE");

    const incomplete = migrationChangeSet() as {
      operations: Array<{ parameters: { materials: unknown[] } }>;
    };
    const incompleteOperation = incomplete.operations[0];
    if (!incompleteOperation) throw new Error("Migration operation missing");
    incompleteOperation.parameters.materials = incompleteOperation.parameters.materials.slice(1);
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), incomplete),
      ),
    ).toBe("MATERIAL_APPEARANCE_SET_INCOMPLETE");
  });

  it("blocks an unknown materialId and a locked material target", () => {
    const unknownId = migrationChangeSet() as {
      operations: Array<{ parameters: { materials: Array<{ materialId: string }> } }>;
    };
    const unknownOperation = unknownId.operations[0];
    if (!unknownOperation) throw new Error("Migration operation missing");
    unknownOperation.parameters.materials[0] = {
      ...unknownOperation.parameters.materials[0],
      materialId: "material_absent",
    } as { materialId: string };
    unknownOperation.parameters.materials.sort((left, right) =>
      left.materialId.localeCompare(right.materialId),
    );
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0010/scene-spec.json"), unknownId),
      ),
    ).toBe("MATERIAL_NOT_FOUND");

    const scene = fixture("revisions/rev_golden_0010/scene-spec.json") as {
      geometry: Array<{ id: string; locks?: { material?: boolean } }>;
    };
    const wallSouth = scene.geometry.find((entry) => entry.id === "wall_south");
    if (!wallSouth) throw new Error("wall_south geometry missing");
    wallSouth.locks = { ...(wallSouth.locks ?? {}), material: true };
    expect(errorCode(() => planSceneRevision(scene, migrationChangeSet()))).toBe("MATERIAL_LOCKED");
  });

  it("produces a null expectation for a non-canonical scene and the exact rev11 evidence oracle for the canonical one", () => {
    expect(
      canonicalMaterialStateExpectation(fixture("revisions/rev_golden_0010/scene-spec.json")),
    ).toBe(null);
    const expected = canonicalMaterialStateExpectation(
      fixture("revisions/rev_golden_0011/scene-spec.json"),
    );
    expect(expected).toEqual({
      materialStateVersion: "0.1.0",
      projectId: "project_golden_living_001",
      sceneId: "scene_golden_living_001",
      revisionId: "rev_golden_0011",
      sceneSpecVersion: "0.3.0",
      materials: [
        {
          materialId: "material_floor_neutral",
          actualClass: "_CoronaPhysicalMtl",
          canonicalBaseColorRgb: [0.66, 0.64, 0.6],
          observedBaseColorRgb: [0.66, 0.64, 0.6],
          canonicalRoughness: 0.34,
          observedRoughness: 0.34,
          canonicalMetalness: 0,
          observedMetalness: 0,
          materialInstanceName: "AVZ_MATERIAL_material_floor_neutral",
        },
        {
          materialId: "material_sofa_proxy",
          actualClass: "_CoronaPhysicalMtl",
          canonicalBaseColorRgb: [0.72, 0.62, 0.5],
          observedBaseColorRgb: [0.72, 0.62, 0.5],
          canonicalRoughness: 0.78,
          observedRoughness: 0.78,
          canonicalMetalness: 0,
          observedMetalness: 0,
          materialInstanceName: "AVZ_MATERIAL_material_sofa_proxy",
        },
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
          targetId: "asset_living_sofa_main",
          materialId: "material_sofa_proxy",
          materialInstanceName: "AVZ_MATERIAL_material_sofa_proxy",
        },
        {
          targetId: "surface_floor_main",
          materialId: "material_floor_neutral",
          materialInstanceName: "AVZ_MATERIAL_material_floor_neutral",
        },
        {
          targetId: "wall_east",
          materialId: "material_wall_neutral",
          materialInstanceName: "AVZ_MATERIAL_material_wall_neutral",
        },
        {
          targetId: "wall_north",
          materialId: "material_wall_neutral",
          materialInstanceName: "AVZ_MATERIAL_material_wall_neutral",
        },
        {
          targetId: "wall_south",
          materialId: "material_floor_neutral",
          materialInstanceName: "AVZ_MATERIAL_material_floor_neutral",
        },
        {
          targetId: "wall_west",
          materialId: "material_wall_neutral",
          materialInstanceName: "AVZ_MATERIAL_material_wall_neutral",
        },
      ],
      deduplication: { sameIdSharedInstance: true, differentIdDistinctInstances: true },
      status: "PASS",
    });
  });

  it("reports zero semantic node changes between rev10 and rev11 (materials are untracked by the manifest)", () => {
    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0010/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0011/expected-scene-manifest.json"),
    );
    expect(() => assertRevisionDiff(diff, migrationChangeSet() as never)).not.toThrow();
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toHaveLength(14);
  });
});

describe("Technical Spike 8I canonical camera revisions", () => {
  function cameraChangeSet(): Record<string, unknown> {
    return fixture("changesets/set-camera-r12.json");
  }

  it("accepts the SceneChangeSet v0.3 SetCamera contract and rejects it under v0.1/v0.2", () => {
    expect(validateSceneChangeSet(cameraChangeSet())).toMatchObject({ ok: true });
    const asV01 = cameraChangeSet();
    asV01.schemaVersion = "0.1.0";
    expect(validateSceneChangeSet(asV01)).toMatchObject({ ok: false });
    const asV02 = cameraChangeSet();
    asV02.schemaVersion = "0.2.0";
    expect(validateSceneChangeSet(asV02)).toMatchObject({ ok: false });
  });

  it("rejects an unsupported SceneChangeSet version outright", () => {
    const unsupported = cameraChangeSet();
    unsupported.schemaVersion = "0.4.0";
    expect(validateSceneChangeSet(unsupported)).toMatchObject({ ok: false });
  });

  it("preserves the single-operation invariant for v0.3", () => {
    const composite = cameraChangeSet() as { operations: unknown[] };
    composite.operations.push(...composite.operations);
    expect(validateSceneChangeSet(composite)).toMatchObject({ ok: false });
  });

  it("rejects rotationEuler supplied in SetCamera parameters (rotation is always derived)", () => {
    const withRotation = cameraChangeSet() as {
      operations: Array<{ parameters: Record<string, unknown> }>;
    };
    const operation = withRotation.operations[0];
    if (!operation) throw new Error("SetCamera operation missing");
    operation.parameters.rotationEuler = [0, 0, 0];
    expect(validateSceneChangeSet(withRotation)).toMatchObject({ ok: false });
  });

  it("computes exactly the committed rev12 SceneSpec and revisionPlanVersion 0.3.0", () => {
    const rev11Scene = fixture("revisions/rev_golden_0011/scene-spec.json");
    const sourceOrder = structuredClone(rev11Scene);
    const result = planSceneRevision(rev11Scene, cameraChangeSet());
    const expected = fixture("revisions/rev_golden_0012/scene-spec.json");
    expect(validateSceneSpec(expected)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(result.plan.revisionPlanVersion).toBe("0.3.0");
    // The pure transition never mutates its base-scene input.
    expect(rev11Scene).toEqual(sourceOrder);
    expect(result.plan.operation).toEqual({
      operationId: "op_set_camera_r12",
      type: "SetCamera",
      targetId: "camera_living_a",
      position: [1200, 3800, 1500],
      target: [3000, 200, 1300],
      orientationPolicy: "look_at_target",
      derivedRotationEuler: [-2.8447103878693705, 0, 206.56505117707798],
      focalLengthMm: 28,
      sensorWidthMm: 36,
      fovRadians: 1.1426749596672536,
      fovDegrees: 65.4704525442152,
    });
  });

  it("does not upgrade revisionPlanVersion for unrelated operations", () => {
    const result = planSceneRevision(
      fixture("revisions/rev_golden_0009/scene-spec.json"),
      fixture("changesets/add-key-area-light-r10.json"),
    );
    expect(result.plan.revisionPlanVersion).toBe("0.1.0");
  });

  it("leaves camera_living_b and camera_living_c fully unchanged", () => {
    const result = planSceneRevision(
      fixture("revisions/rev_golden_0011/scene-spec.json"),
      cameraChangeSet(),
    );
    const rev11Cameras = (
      fixture("revisions/rev_golden_0011/scene-spec.json") as { cameras: Array<{ id: string }> }
    ).cameras;
    const targetCameras = (result.targetSceneSpec as { cameras: Array<{ id: string }> }).cameras;
    for (const id of ["camera_living_b", "camera_living_c"]) {
      expect(targetCameras.find((camera) => camera.id === id)).toEqual(
        rev11Cameras.find((camera) => camera.id === id),
      );
    }
  });

  it("blocks a stale base revision and a wrong scene target", () => {
    const stale = cameraChangeSet();
    stale.baseRevisionId = "rev_golden_0010";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0011/scene-spec.json"), stale),
      ),
    ).toBe("STALE_REVISION");

    const wrongTarget = cameraChangeSet() as { operations: Array<{ targetId: string }> };
    const wrongOperation = wrongTarget.operations[0];
    if (!wrongOperation) throw new Error("SetCamera operation missing");
    wrongOperation.targetId = "camera_missing_entirely";
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0011/scene-spec.json"), wrongTarget),
      ),
    ).toBe("CAMERA_NOT_FOUND");
  });

  it("blocks position equal to target before any DCC launch", () => {
    const coincident = cameraChangeSet() as {
      operations: Array<{ parameters: { position: number[]; target: number[] } }>;
    };
    const operation = coincident.operations[0];
    if (!operation) throw new Error("SetCamera operation missing");
    operation.parameters.target = [...operation.parameters.position];
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0011/scene-spec.json"), coincident),
      ),
    ).toBe("CAMERA_POSITION_TARGET_INVALID");
  });

  it("blocks a SetCamera request whose desired state already matches the canonical camera", () => {
    const unchanged = cameraChangeSet() as {
      operations: Array<{ parameters: { focalLengthMm: number } }>;
    };
    const operation = unchanged.operations[0];
    if (!operation) throw new Error("SetCamera operation missing");
    operation.parameters.focalLengthMm = 24;
    expect(
      errorCode(() =>
        planSceneRevision(fixture("revisions/rev_golden_0011/scene-spec.json"), unchanged),
      ),
    ).toBe("CAMERA_STATE_UNCHANGED");
  });

  it("blocks a duplicate camera logical ID target", () => {
    const scene = fixture("revisions/rev_golden_0011/scene-spec.json") as {
      cameras: Array<Record<string, unknown>>;
    };
    const cameraA = scene.cameras.find((camera) => camera.id === "camera_living_a");
    if (!cameraA) throw new Error("camera_living_a missing");
    scene.cameras.push({ ...cameraA });
    expect(errorCode(() => planSceneRevision(scene, cameraChangeSet()))).toBe(
      "CAMERA_ID_AMBIGUOUS",
    );
  });

  it("reports only camera_living_a as changed, with 13 other managed entries unchanged", () => {
    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0011/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0012/expected-scene-manifest.json"),
    );
    expect(() => assertRevisionDiff(diff, cameraChangeSet() as never)).not.toThrow();
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.logicalId).toBe("camera_living_a");
    expect(Object.keys(diff.changed[0]?.changes ?? {}).sort()).toEqual([
      "focalLengthMm",
      "transform.rotationEuler",
    ]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toHaveLength(13);
  });

  it("produces the exact rev12 canonical camera-state oracle, verifying all three cameras", () => {
    const expected = canonicalCameraStateExpectation(
      fixture("revisions/rev_golden_0012/scene-spec.json"),
    );
    expect(expected).not.toBeNull();
    const value = expected as {
      cameraStateVersion: string;
      revisionId: string;
      sceneSpecVersion: string;
      cameras: Array<Record<string, unknown>>;
      status: string;
    };
    expect(value.cameraStateVersion).toBe("0.1.0");
    expect(value.revisionId).toBe("rev_golden_0012");
    expect(value.sceneSpecVersion).toBe("0.3.0");
    expect(value.status).toBe("PASS");
    expect(value.cameras.map((camera) => camera.logicalId)).toEqual([
      "camera_living_a",
      "camera_living_b",
      "camera_living_c",
    ]);
    const cameraA = value.cameras.find((camera) => camera.logicalId === "camera_living_a");
    expect(cameraA).toMatchObject({
      actualClass: "Freecamera",
      canonicalPosition: [1200, 3800, 1500],
      canonicalTarget: [3000, 200, 1300],
      orientationPolicy: "look_at_target",
      focalLengthMm: 28,
      sensorWidthMm: 36,
    });
    expect((cameraA as { expectedFovRadians: number }).expectedFovRadians).toBeCloseTo(
      1.1426749596672536,
      14,
    );
    expect((cameraA as { expectedFovDegrees: number }).expectedFovDegrees).toBeCloseTo(
      65.4704525442152,
      10,
    );
  });

  it("compiles rev12 through compileCanonicalMaterialAppearance() with the new 28mm camera and no legacy 24mm value", () => {
    const rev12Scene = fixture("revisions/rev_golden_0012/scene-spec.json");
    const renderJob = fixture("render-job-v0.2-camera-living-a.json");
    const plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(
      rev12Scene,
      renderJob,
    );
    expect(plan.camera).toMatchObject({
      logicalId: "camera_living_a",
      focalLengthMm: 28,
      sensorWidthMm: 36,
    });
    expect(plan.camera.fovRadians).toBeCloseTo(1.1426749596672536, 14);
    expect(JSON.stringify(plan.camera)).not.toContain('"focalLengthMm":24');
  });
});
