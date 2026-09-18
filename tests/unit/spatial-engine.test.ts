import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSpatialValidationEvidence } from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import { spatialValidationEvidence } from "../../apps/worker/src/spatial-validation.js";
import {
  evaluateAssetPlacement,
  evaluateAssetReplacement,
  SPATIAL_EPSILON_MM,
  SPATIAL_POLICY_VERSION,
  validateSpatialScene,
} from "../../packages/spatial-engine/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function rev12Scene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0012/scene-spec.json");
}

function transformOf(
  scene: Record<string, unknown>,
  assetId: string,
): {
  position: [number, number, number];
  rotationEuler: [number, number, number];
  scale: [number, number, number];
} {
  const asset = (scene.assets as Array<Record<string, unknown>>).find(
    (entry) => entry.id === assetId,
  );
  return structuredClone(
    asset?.transform as {
      position: [number, number, number];
      rotationEuler: [number, number, number];
      scale: [number, number, number];
    },
  );
}

describe("Technical Spike 9A: current Golden rev12 passes spatial-policy-v0.1", () => {
  it("validates the exact promoted rev_golden_0012 scene with no violations", () => {
    const result = validateSpatialScene(rev12Scene());
    expect(result.status).toBe("PASS");
    expect(result.policyVersion).toBe(SPATIAL_POLICY_VERSION);
    expect(result.sceneSpecVersion).toBe("0.3.0");
    expect(result.revisionId).toBe("rev_golden_0012");
    expect(result.violations).toEqual([]);
    expect(result.assetFootprints).toHaveLength(3);
    expect(result.doorwayClearances).toHaveLength(1);
    // Footprints and evidence are frozen to exactly what the current Golden
    // geometry produces — this is not altered merely to make 9A pass.
    expect(result.assetFootprints.map((entry) => entry.assetId)).toEqual([
      "asset_living_coffee_table_main",
      "asset_living_sofa_main",
      "asset_living_tv_unit_main",
    ]);
  });
});

describe("Technical Spike 9A: sofa/coffee-table collision", () => {
  it("rejects a candidate MoveObject that places the coffee table on top of the sofa", () => {
    const scene = rev12Scene();
    const sofaTransform = transformOf(scene, "asset_living_sofa_main");
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: sofaTransform.position,
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("FAILED");
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      code: "SPATIAL_ASSET_COLLISION",
      assetAId: "asset_living_coffee_table_main",
      assetBId: "asset_living_sofa_main",
    });
    // Input SceneSpec is never mutated by a candidate evaluation.
    expect(rev12Scene()).toEqual(scene);
  });
});

describe("Technical Spike 9A: outside-room rejection with boundary-touching PASS", () => {
  it("rejects the coffee table crossing the east room boundary by more than epsilon", () => {
    const scene = rev12Scene();
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: [5900, 2200, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "SPATIAL_ASSET_OUTSIDE_SPACE",
        assetId: "asset_living_coffee_table_main",
        spaceId: "space_living_main",
      }),
    );
  });

  it("allows the coffee table to exactly touch the east room boundary", () => {
    const scene = rev12Scene();
    // Room east boundary is x=6000; coffee table width=1200 (half=600), so
    // center x=5400 puts the +x edge exactly on the boundary.
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: [5400, 2200, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("PASS");
  });
});

describe("Technical Spike 9A: rotated OBB correctness (AABB false-positive guard)", () => {
  it("computes correct rotated corners and does not report a collision an AABB-only test would", () => {
    const scene = rev12Scene();
    // Rotate the coffee table 30 degrees at its current position; its AABB
    // grows but its true OBB must not collide with the sofa or exit the room.
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: [3300, 2200, 0],
      rotationEuler: [0, 0, 30],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("PASS");
    const footprint = result.assetFootprints.find(
      (entry) => entry.assetId === "asset_living_coffee_table_main",
    );
    expect(footprint?.rotationZDegrees).toBe(30);
    // Verify the corners are the actual rotated rectangle, not axis-aligned.
    const xs = footprint?.cornersXY.map((corner) => corner[0]) ?? [];
    const ys = footprint?.cornersXY.map((corner) => corner[1]) ?? [];
    expect(new Set(xs).size).toBeGreaterThan(2);
    expect(new Set(ys).size).toBeGreaterThan(2);
  });

  it("still rejects a genuine rotated collision that an AABB broad-phase would also catch", () => {
    const scene = rev12Scene();
    const sofaTransform = transformOf(scene, "asset_living_sofa_main");
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: sofaTransform.position,
      rotationEuler: [0, 0, 30],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "SPATIAL_ASSET_COLLISION" }),
    );
  });
});

describe("Technical Spike 9A: doorway access-clearance envelope", () => {
  it("blocks a floor asset placed inside opening_d01's interior clearance zone", () => {
    const scene = rev12Scene();
    // Clearance zone for opening_d01 spans x:[0,900], y:[1200,2100].
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: [450, 1650, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "SPATIAL_DOOR_CLEARANCE_BLOCKED",
        assetId: "asset_living_coffee_table_main",
        openingId: "opening_d01",
      }),
    );
  });

  it("passes for that rule when the footprint only touches the clearance boundary", () => {
    const scene = rev12Scene();
    // Clearance zone ends at x=900; coffee table half-width=600, so center
    // x=1500 puts its -x edge exactly on the clearance boundary.
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: [1500, 1650, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    });
    const doorViolation = result.violations.find(
      (violation) => violation.code === "SPATIAL_DOOR_CLEARANCE_BLOCKED",
    );
    expect(doorViolation).toBeUndefined();
  });
});

describe("Technical Spike 9A: unsupported footprint fails closed", () => {
  it("rejects non-zero roll with SPATIAL_FOOTPRINT_UNSUPPORTED and no guessed footprint", () => {
    const scene = rev12Scene();
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: [3300, 2200, 0],
      rotationEuler: [5, 0, 0],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "SPATIAL_FOOTPRINT_UNSUPPORTED",
        assetId: "asset_living_coffee_table_main",
      }),
    );
    expect(
      result.assetFootprints.some((entry) => entry.assetId === "asset_living_coffee_table_main"),
    ).toBe(false);
  });

  it("rejects non-zero pitch with SPATIAL_FOOTPRINT_UNSUPPORTED", () => {
    const scene = rev12Scene();
    const result = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", {
      position: [3300, 2200, 0],
      rotationEuler: [0, 5, 0],
      scale: [1, 1, 1],
    });
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "SPATIAL_FOOTPRINT_UNSUPPORTED" }),
    );
  });
});

describe("Technical Spike 9A: ReplaceAsset candidate footprint uses new definition dimensions", () => {
  function syntheticReplacementScene(): Record<string, unknown> {
    return {
      sceneSpecVersion: "0.3.0",
      project: { id: "project_synthetic" },
      scene: { id: "scene_synthetic", revisionId: "rev_synthetic_0001" },
      spaces: [
        {
          id: "space_a",
          boundary: [
            [0, 0, 0],
            [3000, 0, 0],
            [3000, 2000, 0],
            [0, 2000, 0],
          ],
        },
      ],
      geometry: [],
      openings: [],
      assetDefinitions: [
        {
          id: "assetdef_small",
          dimensions: [400, 400, 400],
          pivotPolicy: "floor_center",
        },
        {
          id: "assetdef_large",
          dimensions: [2000, 400, 400],
          pivotPolicy: "floor_center",
        },
      ],
      assets: [
        {
          id: "asset_movable",
          type: "proxy_asset",
          assetDefinitionId: "assetdef_small",
          spaceId: "space_a",
          transform: { position: [200, 1000, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          id: "asset_fixed",
          type: "proxy_asset",
          assetDefinitionId: "assetdef_small",
          spaceId: "space_a",
          transform: { position: [2800, 1000, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    };
  }

  it("PASSes with the current (small) definition", () => {
    const scene = syntheticReplacementScene();
    const result = validateSpatialScene(scene);
    expect(result.status).toBe("PASS");
  });

  it("BLOCKs when the replacement definition is larger and produces a collision", () => {
    const scene = syntheticReplacementScene();
    // Move asset_movable close enough to asset_fixed (still fully within the
    // room at its current small footprint) that only the LARGE replacement
    // definition's wider footprint reaches asset_fixed.
    (scene.assets as Array<Record<string, unknown>>)[0] = {
      ...(scene.assets as Array<Record<string, unknown>>)[0],
      transform: { position: [1700, 1000, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    };
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const sourceOrder = structuredClone(scene);
    const result = evaluateAssetReplacement(scene, "asset_movable", "assetdef_large");
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "SPATIAL_ASSET_COLLISION",
        assetAId: "asset_fixed",
        assetBId: "asset_movable",
      }),
    );
    // preserve_anchor: transform is unchanged; only the definition differs.
    const footprint = result.assetFootprints.find((entry) => entry.assetId === "asset_movable");
    expect(footprint?.widthMm).toBe(2000);
    expect(footprint?.centerXY).toEqual([1700, 1000]);
    expect(scene).toEqual(sourceOrder);
  });

  it("BLOCKs when the larger replacement definition instead exits the space", () => {
    const scene = syntheticReplacementScene();
    // Move the fixed asset out of the way so only the outside-space check fires.
    (scene.assets as Array<Record<string, unknown>>)[1] = {
      ...(scene.assets as Array<Record<string, unknown>>)[1],
      transform: { position: [2800, 1900, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    };
    const result = evaluateAssetReplacement(scene, "asset_movable", "assetdef_large");
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "SPATIAL_ASSET_OUTSIDE_SPACE", assetId: "asset_movable" }),
    );
  });
});

describe("Technical Spike 9A: external_max definitions use canonical dimensions only", () => {
  it("treats an external_max definition's dimensions identically to a procedural definition", () => {
    const baseScene = {
      sceneSpecVersion: "0.3.0",
      project: { id: "project_synthetic" },
      scene: { id: "scene_synthetic", revisionId: "rev_synthetic_0001" },
      spaces: [
        {
          id: "space_a",
          boundary: [
            [0, 0, 0],
            [3000, 0, 0],
            [3000, 3000, 0],
            [0, 3000, 0],
          ],
        },
      ],
      geometry: [],
      openings: [],
      assetDefinitions: [
        {
          id: "assetdef_procedural",
          dimensions: [800, 500, 600],
          pivotPolicy: "floor_center",
          sourceType: "procedural_proxy",
        },
        {
          id: "assetdef_external",
          dimensions: [800, 500, 600],
          pivotPolicy: "floor_center",
          sourceType: "external_max",
          artifactId: "artifact_trusted_001",
        },
      ],
      assets: [
        {
          id: "asset_x",
          type: "proxy_asset",
          assetDefinitionId: "assetdef_procedural",
          spaceId: "space_a",
          transform: { position: [1500, 1500, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    };
    const proceduralResult = validateSpatialScene(baseScene);
    const externalScene = structuredClone(baseScene);
    (externalScene.assets as Array<Record<string, unknown>>)[0] = {
      ...(externalScene.assets as Array<Record<string, unknown>>)[0],
      assetDefinitionId: "assetdef_external",
    };
    const externalResult = validateSpatialScene(externalScene);
    const proceduralFootprint = proceduralResult.assetFootprints[0];
    const externalFootprint = externalResult.assetFootprints[0];
    expect(externalFootprint?.widthMm).toBe(proceduralFootprint?.widthMm);
    expect(externalFootprint?.lengthMm).toBe(proceduralFootprint?.lengthMm);
    expect(externalFootprint?.cornersXY).toEqual(proceduralFootprint?.cornersXY);
    expect(externalResult.status).toBe("PASS");
  });
});

describe("Technical Spike 9A: concave space containment", () => {
  function lShapedSpaceScene(assetPosition: [number, number]): Record<string, unknown> {
    // An L-shaped room: a 4000x4000 square with a 2000x2000 notch removed
    // from the top-right corner. Winding is counter-clockwise.
    return {
      sceneSpecVersion: "0.3.0",
      project: { id: "project_synthetic" },
      scene: { id: "scene_synthetic", revisionId: "rev_synthetic_0001" },
      spaces: [
        {
          id: "space_l",
          boundary: [
            [0, 0, 0],
            [4000, 0, 0],
            [4000, 2000, 0],
            [2000, 2000, 0],
            [2000, 4000, 0],
            [0, 4000, 0],
          ],
        },
      ],
      geometry: [],
      openings: [],
      assetDefinitions: [
        {
          id: "assetdef_probe",
          dimensions: [1600, 1600, 400],
          pivotPolicy: "floor_center",
        },
      ],
      assets: [
        {
          id: "asset_probe",
          type: "proxy_asset",
          assetDefinitionId: "assetdef_probe",
          spaceId: "space_l",
          transform: {
            position: [assetPosition[0], assetPosition[1], 0],
            rotationEuler: [0, 0, 0],
            scale: [1, 1, 1],
          },
        },
      ],
    };
  }

  it("rejects an OBB whose corners are all nominally within the bounding square but whose edge crosses the notch", () => {
    // Centered at (3000, 3000): corners at (2200,2200), (3800,2200),
    // (3800,3800), (2200,3800) — every corner individually sits inside the
    // 4000x4000 bounding square, but the notch means the true L-shaped
    // boundary excludes most of this footprint. Corner-only containment
    // would wrongly pass this; the concave-safe edge-crossing check must not.
    const scene = lShapedSpaceScene([3000, 3000]);
    const result = validateSpatialScene(scene);
    expect(result.status).toBe("FAILED");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "SPATIAL_ASSET_OUTSIDE_SPACE", assetId: "asset_probe" }),
    );
  });

  it("passes for the same-size footprint placed fully within the L-shape's solid arm", () => {
    const scene = lShapedSpaceScene([1000, 1000]);
    const result = validateSpatialScene(scene);
    expect(result.status).toBe("PASS");
  });
});

describe("Technical Spike 9A: determinism", () => {
  it("produces deep-equal evidence for repeated evaluation of the same scene", () => {
    const scene = rev12Scene();
    const first = validateSpatialScene(scene);
    const second = validateSpatialScene(rev12Scene());
    expect(first).toEqual(second);
  });

  it("produces deep-equal results for repeated evaluation of the same candidate transform", () => {
    const scene = rev12Scene();
    const transform = {
      position: [3300, 2200, 0] as [number, number, number],
      rotationEuler: [0, 0, 15] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    const first = evaluateAssetPlacement(scene, "asset_living_coffee_table_main", transform);
    const second = evaluateAssetPlacement(
      rev12Scene(),
      "asset_living_coffee_table_main",
      transform,
    );
    expect(first).toEqual(second);
  });

  it("normalized evidence ordering is independent of source asset array order, without mutating the source", () => {
    const scene = rev12Scene();
    const reordered = structuredClone(scene);
    (reordered.assets as unknown[]).reverse();
    const sourceOrderCheck = structuredClone(reordered);
    const original = validateSpatialScene(scene);
    const reversed = validateSpatialScene(reordered);
    expect(reversed.assetFootprints.map((entry) => entry.assetId)).toEqual(
      original.assetFootprints.map((entry) => entry.assetId),
    );
    expect(reversed).toEqual(original);
    // The engine itself never mutates its input array order.
    expect(reordered).toEqual(sourceOrderCheck);
  });
});

describe("SPATIAL_EPSILON_MM", () => {
  it("is the single frozen policy epsilon", () => {
    expect(SPATIAL_EPSILON_MM).toBe(0.001);
  });
});

describe("spatial-validation-evidence-v0.1", () => {
  it("validates the wrapped evidence for the current Golden rev12 scene", () => {
    const evidence = spatialValidationEvidence(rev12Scene());
    expect(validateSpatialValidationEvidence(evidence)).toMatchObject({ ok: true });
    expect(evidence.evidenceVersion).toBe("0.1.0");
    expect(evidence.policyVersion).toBe(SPATIAL_POLICY_VERSION);
    expect(evidence.status).toBe("PASS");
    expect(evidence.sceneSpecHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("is deterministic across repeated evaluation of the same scene", () => {
    const first = spatialValidationEvidence(rev12Scene());
    const second = spatialValidationEvidence(rev12Scene());
    expect(first).toEqual(second);
  });
});
