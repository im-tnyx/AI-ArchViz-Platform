import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import {
  assertRevisionDiff,
  diffSemanticManifests,
  planSceneRevision,
  RevisionValidationError,
} from "../../apps/worker/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function changeSet(): Record<string, unknown> {
  return fixture("changesets/assign-wall-south-material-r4.json");
}

function baseScene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0003/scene-spec.json");
}

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof RevisionValidationError ? error.code : null;
  }
}

function required<T>(value: T | undefined, message = "Required fixture value missing"): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function assignment(
  scene: Record<string, unknown>,
  targetId: string,
): { id: string; targetId: string; materialId: string } {
  const assignments = scene.materialAssignments as Array<{
    id: string;
    targetId: string;
    materialId: string;
  }>;
  return required(assignments.find((entry) => entry.targetId === targetId));
}

describe("SceneChangeSet AssignMaterial contract", () => {
  it("accepts the Golden assignment and rejects arbitrary material payloads", () => {
    expect(validateSceneChangeSet(changeSet())).toMatchObject({ ok: true });
    const invalid = changeSet() as {
      operations: Array<{ parameters: Record<string, unknown> }>;
    };
    required(invalid.operations[0]).parameters.baseColorRgb = [1, 0, 0];
    expect(validateSceneChangeSet(invalid)).toMatchObject({ ok: false });
  });
});

describe("AssignMaterial pre-DCC planning", () => {
  it("computes rev0004 with one preserved material-assignment identity", () => {
    const base = baseScene();
    const result = planSceneRevision(base, changeSet());
    const expected = fixture("revisions/rev_golden_0004/scene-spec.json");
    expect(validateSceneSpec(expected)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(result.plan.operation).toEqual({
      operationId: "op_assign_wall_south_material_r4",
      type: "AssignMaterial",
      targetId: "wall_south",
      material: {
        id: "material_floor_neutral",
        baseColorRgb: [0.6588235294117647, 0.6392156862745098, 0.6],
      },
    });
    expect(assignment(result.targetSceneSpec, "wall_south")).toEqual({
      id: assignment(base, "wall_south").id,
      targetId: "wall_south",
      materialId: "material_floor_neutral",
    });
    expect(result.targetSceneSpec.materials).toEqual(base.materials);
    expect(result.targetSceneSpec.geometry).toEqual(base.geometry);
  });

  it("blocks stale, missing-target, missing-material, and material-lock requests", () => {
    const stale = changeSet();
    stale.baseRevisionId = "rev_golden_0002";
    expect(errorCode(() => planSceneRevision(baseScene(), stale))).toBe("STALE_REVISION");

    const missingTarget = changeSet() as { operations: Array<{ targetId: string }> };
    required(missingTarget.operations[0]).targetId = "wall_missing";
    expect(errorCode(() => planSceneRevision(baseScene(), missingTarget))).toBe("TARGET_NOT_FOUND");

    const missingMaterial = changeSet() as {
      operations: Array<{ parameters: { materialId: string } }>;
    };
    required(missingMaterial.operations[0]).parameters.materialId = "material_nonexistent";
    expect(errorCode(() => planSceneRevision(baseScene(), missingMaterial))).toBe(
      "MATERIAL_NOT_FOUND",
    );

    const locked = baseScene() as {
      geometry: Array<{ id: string; locks: { material: boolean } }>;
    };
    required(locked.geometry.find((entry) => entry.id === "wall_south")).locks.material = true;
    expect(errorCode(() => planSceneRevision(locked, changeSet()))).toBe("MATERIAL_LOCKED");
  });

  it("rejects an already-satisfied desired state without duplicate assignment churn", () => {
    const noOp = changeSet() as {
      operations: Array<{ parameters: { materialId: string } }>;
    };
    required(noOp.operations[0]).parameters.materialId = "material_wall_neutral";
    expect(errorCode(() => planSceneRevision(baseScene(), noOp))).toBe("MATERIAL_ALREADY_ASSIGNED");
  });
});

describe("AssignMaterial semantic preservation", () => {
  it("changes only wall_south material semantics and leaves shared walls intact", () => {
    const base = baseScene();
    const planned = planSceneRevision(base, changeSet());
    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0003/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0004/expected-scene-manifest.json"),
    );
    expect(() => assertRevisionDiff(diff, planned.changeSet)).not.toThrow();
    expect(diff.changed).toEqual([
      {
        logicalId: "wall_south",
        changes: {
          materialBaseColorRgb: {
            before: [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
            after: [0.6588235294117647, 0.6392156862745098, 0.6],
          },
          materialId: { before: "material_wall_neutral", after: "material_floor_neutral" },
        },
      },
    ]);
    expect(diff.unchanged).toHaveLength(13);
    for (const targetId of ["wall_east", "wall_north", "wall_west", "surface_floor_main"]) {
      expect(assignment(planned.targetSceneSpec, targetId)).toEqual(assignment(base, targetId));
    }
    expect(assignment(planned.targetSceneSpec, "wall_south").id).toBe(
      assignment(base, "wall_south").id,
    );
  });
});
