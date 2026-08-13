import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import {
  compareSceneManifests,
  compileGoldenBuildPlan,
  planSceneRevision,
} from "../../apps/worker/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");
const tolerances = {
  geometryToleranceMm: 0.01,
  transformToleranceMm: 0.01,
  rotationToleranceDeg: 0.001,
};

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function nodeById(plan: ReturnType<typeof compileGoldenBuildPlan>, id: string) {
  const node = plan.nodes.find((entry) => entry.logicalId === id);
  if (!node) throw new Error(`Missing node ${id}`);
  return node;
}

function required<T>(value: T | undefined, message = "Required fixture value missing"): T {
  if (value === undefined) throw new Error(message);
  return value;
}

describe("material baseline compiler", () => {
  it("resolves canonical materials and their existing assignments", () => {
    const plan = compileGoldenBuildPlan(fixture("scene-spec.json"));
    expect(plan.materials).toEqual([
      {
        id: "material_floor_neutral",
        baseColorRgb: [0.6588235294117647, 0.6392156862745098, 0.6],
      },
      {
        id: "material_sofa_proxy",
        baseColorRgb: [0.7215686274509804, 0.6196078431372549, 0.5019607843137255],
      },
      {
        id: "material_wall_neutral",
        baseColorRgb: [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
      },
    ]);
    expect(plan.materialAssignments).toHaveLength(6);
    for (const wallId of ["wall_south", "wall_east", "wall_north", "wall_west"]) {
      expect(nodeById(plan, wallId)).toMatchObject({
        materialId: "material_wall_neutral",
        materialBaseColorRgb: [0.7803921568627451, 0.7411764705882353, 0.6784313725490196],
      });
    }
    expect(nodeById(plan, "surface_floor_main").materialId).toBe("material_floor_neutral");
    expect(nodeById(plan, "asset_living_sofa_main").materialId).toBe("material_sofa_proxy");
  });

  it("leaves unassigned logical objects canonically unassigned", () => {
    const plan = compileGoldenBuildPlan(fixture("scene-spec.json"));
    for (const id of [
      "asset_living_coffee_table_main",
      "asset_living_tv_unit_main",
      "surface_ceiling_main",
      "opening_d01",
      "opening_w01",
    ]) {
      expect(nodeById(plan, id)).not.toHaveProperty("materialId");
      expect(nodeById(plan, id)).not.toHaveProperty("materialBaseColorRgb");
    }
  });

  it("rejects duplicate material IDs and invalid assignment references before DCC", () => {
    const duplicate = fixture("scene-spec.json") as {
      materials: Array<Record<string, unknown>>;
    };
    duplicate.materials.push(structuredClone(required(duplicate.materials[0])));
    expect(validateSceneSpec(duplicate)).toMatchObject({ ok: false });

    const duplicateId = fixture("scene-spec.json") as {
      materials: Array<Record<string, unknown>>;
    };
    duplicateId.materials.push({
      id: "material_wall_neutral",
      name: "Different name",
      baseColorRgb: [0.1, 0.2, 0.3],
    });
    expect(() => compileGoldenBuildPlan(duplicateId)).toThrow("Duplicate material id");

    const missingMaterial = fixture("scene-spec.json") as {
      materialAssignments: Array<{ materialId: string }>;
    };
    required(missingMaterial.materialAssignments[0]).materialId = "material_missing";
    expect(() => compileGoldenBuildPlan(missingMaterial)).toThrow("references missing material");

    const missingTarget = fixture("scene-spec.json") as {
      materialAssignments: Array<{ targetId: string }>;
    };
    required(missingTarget.materialAssignments[0]).targetId = "target_missing";
    expect(() => compileGoldenBuildPlan(missingTarget)).toThrow("references missing target");
  });
});

describe("material observability and revision preservation", () => {
  it("compares normalized material colors with explicit tolerance", () => {
    const expected = fixture("expected-scene-manifest.json");
    const withinTolerance = structuredClone(expected) as {
      nodes: Array<{ logicalId: string; materialBaseColorRgb?: number[] }>;
    };
    const wall = withinTolerance.nodes.find((entry) => entry.logicalId === "wall_south");
    if (!wall?.materialBaseColorRgb) throw new Error("Golden wall material missing");
    required(wall.materialBaseColorRgb[0], "Golden wall red channel missing");
    wall.materialBaseColorRgb[0] = (wall.materialBaseColorRgb[0] as number) + 0.005;
    expect(compareSceneManifests(expected, withinTolerance as never, tolerances)).toEqual({
      ok: true,
      differences: [],
    });

    wall.materialBaseColorRgb[0] = (wall.materialBaseColorRgb[0] as number) + 0.02;
    const comparison = compareSceneManifests(expected, withinTolerance as never, tolerances);
    expect(comparison.ok).toBe(false);
    if (comparison.ok) return;
    expect(comparison.differences).toMatchObject([
      { code: "MATERIAL_COLOR_MISMATCH", path: "/nodes/wall_south/materialBaseColorRgb/0" },
    ]);
  });

  it("keeps material oracle state through MoveObject and UpdateOpening", () => {
    const rev1 = compileGoldenBuildPlan(fixture("scene-spec.json"));
    const rev2 = compileGoldenBuildPlan(
      planSceneRevision(fixture("scene-spec.json"), fixture("changesets/move-coffee-table-r2.json"))
        .targetSceneSpec,
    );
    const rev3 = compileGoldenBuildPlan(
      planSceneRevision(
        fixture("revisions/rev_golden_0002/scene-spec.json"),
        fixture("changesets/update-window-sill-r3.json"),
      ).targetSceneSpec,
    );
    for (const id of [
      "asset_living_sofa_main",
      "surface_floor_main",
      "wall_east",
      "wall_north",
      "wall_south",
      "wall_west",
    ]) {
      expect(nodeById(rev2, id).materialId).toBe(nodeById(rev1, id).materialId);
      expect(nodeById(rev3, id).materialId).toBe(nodeById(rev2, id).materialId);
      expect(nodeById(rev3, id).materialBaseColorRgb).toEqual(
        nodeById(rev2, id).materialBaseColorRgb,
      );
    }
    const northSegments = rev3.wallSegments.filter(
      (segment) => segment.hostLogicalId === "wall_north",
    );
    expect(northSegments).toHaveLength(8);
  });
});
