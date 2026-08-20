import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import { validateSceneManifest } from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  compareSceneManifests,
  compileGoldenBuildPlan,
  planSceneRevision,
  RevisionValidationError,
  validateAssetReplacementCandidate,
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

function definitionById(
  scene: Record<string, unknown>,
  definitionId: string,
): Record<string, unknown> {
  const definitions = scene.assetDefinitions as Array<Record<string, unknown>>;
  const definition = definitions.find((entry) => entry.id === definitionId);
  if (!definition) throw new Error(`Missing asset definition ${definitionId}`);
  return definition;
}

function assetById(scene: Record<string, unknown>, logicalId: string): Record<string, unknown> {
  const assets = scene.assets as Array<Record<string, unknown>>;
  const asset = assets.find((entry) => entry.id === logicalId);
  if (!asset) throw new Error(`Missing asset ${logicalId}`);
  return asset;
}

function assetReferences(scene: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    (scene.assets as Array<Record<string, unknown>>)
      .map((asset): [string, unknown] => [String(asset.id), asset.assetDefinitionId])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function manifestAssetReferences(manifest: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    (manifest.nodes as Array<Record<string, unknown>>)
      .filter((node) => node.type === "proxy_asset")
      .map((node): [string, unknown] => [String(node.logicalId), node.assetDefinitionId])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

describe("SceneSpec 0.2 asset identity contract", () => {
  it("accepts definition-owned intrinsic proxy data and distinct logical identities", () => {
    const scene = fixture("scene-spec.json");
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
    expect(scene.sceneSpecVersion).toBe("0.2.0");

    const sofa = assetById(scene, "asset_living_sofa_main");
    const definition = definitionById(scene, "assetdef_sofa_proxy_standard_v1");
    expect(sofa.assetDefinitionId).toBe(definition.id);
    expect(sofa.id).not.toBe(definition.id);
    for (const intrinsicField of [
      "category",
      "dimensions",
      "pivotPolicy",
      "allowNonUniformScale",
    ]) {
      expect(sofa).not.toHaveProperty(intrinsicField);
      expect(definition).toHaveProperty(intrinsicField);
    }
  });

  it("rejects unsupported intrinsic definitions, duplicate IDs, and unresolved references", () => {
    const invalidCategory = fixture("scene-spec.json");
    definitionById(invalidCategory, "assetdef_sofa_proxy_standard_v1").category = "armchair";
    expect(validateSceneSpec(invalidCategory)).toMatchObject({ ok: false });

    const invalidDimensions = fixture("scene-spec.json");
    definitionById(invalidDimensions, "assetdef_sofa_proxy_standard_v1").dimensions = [0, 950, 780];
    expect(validateSceneSpec(invalidDimensions)).toMatchObject({ ok: false });

    const invalidPivot = fixture("scene-spec.json");
    definitionById(invalidPivot, "assetdef_sofa_proxy_standard_v1").pivotPolicy = "wall_center";
    expect(validateSceneSpec(invalidPivot)).toMatchObject({ ok: false });

    const unsupportedSource = fixture("scene-spec.json");
    definitionById(unsupportedSource, "assetdef_sofa_proxy_standard_v1").sourceType =
      "external_max";
    expect(validateSceneSpec(unsupportedSource)).toMatchObject({ ok: false });

    const duplicate = fixture("scene-spec.json");
    const definitions = duplicate.assetDefinitions as Array<Record<string, unknown>>;
    const firstDefinition = definitions[0];
    if (!firstDefinition) throw new Error("Golden asset definitions are missing");
    definitions.push(structuredClone(firstDefinition));
    expect(validateSceneSpec(duplicate)).toMatchObject({ ok: false });

    const unresolved = fixture("scene-spec.json");
    assetById(unresolved, "asset_living_sofa_main").assetDefinitionId = "assetdef_missing";
    expect(validateSceneSpec(unresolved)).toMatchObject({ ok: false });

    const duplicateInstance = fixture("scene-spec.json");
    const assets = duplicateInstance.assets as Array<Record<string, unknown>>;
    const firstAsset = assets[0];
    if (!firstAsset) throw new Error("Golden assets are missing");
    assets.push(structuredClone(firstAsset));
    expect(validateSceneSpec(duplicateInstance)).toMatchObject({ ok: false });
  });

  it("uses resolved definition dimensions in the build plan, with no instance override", () => {
    const scene = fixture("scene-spec.json");
    definitionById(scene, "assetdef_sofa_proxy_standard_v1").dimensions = [2300, 900, 760];
    const plan = compileGoldenBuildPlan(scene);
    const sofa = plan.nodes.find((node) => node.logicalId === "asset_living_sofa_main");
    expect(sofa?.dimensions).toEqual([2300, 900, 760]);
    expect(sofa?.assetDefinitionId).toBe("assetdef_sofa_proxy_standard_v1");
    expect(sofa?.embeddedMetadata["AIArchViz.AssetDefinitionId"]).toBe(
      "assetdef_sofa_proxy_standard_v1",
    );
  });

  it("freezes preserve_anchor compatibility and accepts the spatially valid alternate sofa", () => {
    const scene = fixture("scene-spec.json");
    expect(
      validateAssetReplacementCandidate(
        scene,
        "asset_living_sofa_main",
        "assetdef_sofa_proxy_alternate_v1",
      ),
    ).toEqual({
      logicalId: "asset_living_sofa_main",
      currentAssetDefinitionId: "assetdef_sofa_proxy_standard_v1",
      candidateAssetDefinitionId: "assetdef_sofa_proxy_alternate_v1",
      placementPolicy: "preserve_anchor",
    });
    expect(assetById(scene, "asset_living_sofa_main").assetDefinitionId).toBe(
      "assetdef_sofa_proxy_standard_v1",
    );
  });

  it("rejects incompatible category, pivot, scale, and spatial fit without mutation", () => {
    const wrongCategory = fixture("scene-spec.json");
    definitionById(wrongCategory, "assetdef_sofa_proxy_alternate_v1").category = "coffee_table";
    expect(
      errorCode(() =>
        validateAssetReplacementCandidate(
          wrongCategory,
          "asset_living_sofa_main",
          "assetdef_sofa_proxy_alternate_v1",
        ),
      ),
    ).toBe("ASSET_CATEGORY_INCOMPATIBLE");

    const wrongPivot = fixture("scene-spec.json");
    definitionById(wrongPivot, "assetdef_sofa_proxy_alternate_v1").pivotPolicy =
      "back_center_floor";
    expect(
      errorCode(() =>
        validateAssetReplacementCandidate(
          wrongPivot,
          "asset_living_sofa_main",
          "assetdef_sofa_proxy_alternate_v1",
        ),
      ),
    ).toBe("ASSET_PIVOT_INCOMPATIBLE");

    const nonUniformScale = fixture("scene-spec.json");
    (
      assetById(nonUniformScale, "asset_living_sofa_main").transform as Record<string, unknown>
    ).scale = [1, 2, 1];
    expect(
      errorCode(() =>
        validateAssetReplacementCandidate(
          nonUniformScale,
          "asset_living_sofa_main",
          "assetdef_sofa_proxy_alternate_v1",
        ),
      ),
    ).toBe("NON_UNIFORM_SCALE_NOT_ALLOWED");

    const outsideBoundary = fixture("scene-spec.json");
    (
      assetById(outsideBoundary, "asset_living_sofa_main").transform as Record<string, unknown>
    ).position = [5500, 3350, 0];
    expect(
      errorCode(() =>
        validateAssetReplacementCandidate(
          outsideBoundary,
          "asset_living_sofa_main",
          "assetdef_sofa_proxy_alternate_v1",
        ),
      ),
    ).toBe("OBJECT_OUTSIDE_SPACE");
  });
});

describe("asset identity manifest and revision preservation", () => {
  it("compares assetDefinitionId as observed DCC manifest state", () => {
    const expected = fixture("expected-scene-manifest.json");
    expect(validateSceneManifest(expected)).toMatchObject({ ok: true });
    const actual = structuredClone(expected) as { nodes: Array<Record<string, unknown>> };
    const sofa = actual.nodes.find((node) => node.logicalId === "asset_living_sofa_main");
    if (!sofa) throw new Error("Missing sofa manifest node");
    sofa.assetDefinitionId = "assetdef_sofa_proxy_alternate_v1";
    const result = compareSceneManifests(expected, actual, {
      geometryToleranceMm: 0.01,
      transformToleranceMm: 0.01,
      rotationToleranceDeg: 0.001,
    });
    expect(result).toMatchObject({
      ok: false,
      differences: [
        {
          code: "ASSET_DEFINITION_ID_MISMATCH",
          path: "/nodes/asset_living_sofa_main/assetDefinitionId",
          expected: "assetdef_sofa_proxy_standard_v1",
          actual: "assetdef_sofa_proxy_alternate_v1",
        },
      ],
    });
  });

  it("preserves every proxy definition identity through the committed rev1-rev7 operations", () => {
    const expectedReferences = assetReferences(fixture("scene-spec.json"));
    const expectedDefinitions = fixture("scene-spec.json").assetDefinitions;
    const changeSets = [
      "changesets/move-coffee-table-r2.json",
      "changesets/update-window-sill-r3.json",
      "changesets/assign-wall-south-material-r4.json",
      "changesets/lock-coffee-table-transform-r5.json",
      "changesets/unlock-coffee-table-transform-r6.json",
      "changesets/move-coffee-table-after-unlock-r7.json",
    ];
    const revisionIds = ["0002", "0003", "0004", "0005", "0006", "0007"];
    let scene = fixture("scene-spec.json");
    for (const [index, changeSetPath] of changeSets.entries()) {
      const revision = planSceneRevision(scene, fixture(changeSetPath));
      expect(assetReferences(revision.targetSceneSpec)).toEqual(expectedReferences);
      expect(revision.targetSceneSpec.assetDefinitions).toEqual(expectedDefinitions);
      const revisionId = revisionIds[index];
      if (!revisionId) throw new Error("Expected revision fixture is missing");
      const expectedScene = fixture(`revisions/rev_golden_${revisionId}/scene-spec.json`);
      const expectedManifest = fixture(
        `revisions/rev_golden_${revisionId}/expected-scene-manifest.json`,
      );
      expect(validateSceneSpec(expectedScene)).toMatchObject({ ok: true });
      expect(validateSceneManifest(expectedManifest)).toMatchObject({ ok: true });
      expect(revision.targetSceneSpec).toEqual(expectedScene);
      expect(manifestAssetReferences(expectedManifest)).toEqual(expectedReferences);
      scene = revision.targetSceneSpec;
    }
  });
});
