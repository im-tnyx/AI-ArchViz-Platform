import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import {
  assertRevisionDiff,
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

function operation(changeSet: Record<string, unknown>): Record<string, unknown> {
  const value = (changeSet.operations as Array<Record<string, unknown>>)[0];
  if (!value) throw new Error("ReplaceAsset operation is missing");
  return value;
}

function parameters(changeSet: Record<string, unknown>): Record<string, unknown> {
  return operation(changeSet).parameters as Record<string, unknown>;
}

function asset(scene: Record<string, unknown>, logicalId: string): Record<string, unknown> {
  const value = (scene.assets as Array<Record<string, unknown>>).find(
    (entry) => entry.id === logicalId,
  );
  if (!value) throw new Error(`Asset ${logicalId} is missing`);
  return value;
}

function definition(scene: Record<string, unknown>, definitionId: string): Record<string, unknown> {
  const value = (scene.assetDefinitions as Array<Record<string, unknown>>).find(
    (entry) => entry.id === definitionId,
  );
  if (!value) throw new Error(`Definition ${definitionId} is missing`);
  return value;
}

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof RevisionValidationError ? error.code : null;
  }
}

describe("SceneChangeSet ReplaceAsset contract", () => {
  it("accepts the strict Golden replacement and rejects unsupported policy payload", () => {
    const changeSet = fixture("changesets/replace-sofa-r8.json");
    expect(validateSceneChangeSet(changeSet)).toMatchObject({ ok: true });

    const unsupported = structuredClone(changeSet);
    parameters(unsupported).materialPolicy = "replace";
    expect(validateSceneChangeSet(unsupported)).toMatchObject({ ok: false });

    const wrongPolicy = structuredClone(changeSet);
    parameters(wrongPolicy).placementPolicy = "recenter";
    expect(validateSceneChangeSet(wrongPolicy)).toMatchObject({ ok: false });
  });

  it("computes only the immutable definition reference and revision transition", () => {
    const base = fixture("revisions/rev_golden_0007/scene-spec.json");
    const changeSet = fixture("changesets/replace-sofa-r8.json");
    const expected = fixture("revisions/rev_golden_0008/scene-spec.json");
    const result = planSceneRevision(base, changeSet);

    expect(validateSceneSpec(result.targetSceneSpec)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(asset(result.targetSceneSpec, "asset_living_sofa_main").id).toBe(
      "asset_living_sofa_main",
    );
    expect(asset(result.targetSceneSpec, "asset_living_sofa_main").assetDefinitionId).toBe(
      "assetdef_sofa_proxy_alternate_v1",
    );
    expect(asset(result.targetSceneSpec, "asset_living_sofa_main").transform).toEqual(
      asset(base, "asset_living_sofa_main").transform,
    );
    expect(asset(result.targetSceneSpec, "asset_living_sofa_main").locks).toEqual(
      asset(base, "asset_living_sofa_main").locks,
    );
    expect(result.targetSceneSpec.materialAssignments).toEqual(base.materialAssignments);
    expect(result.targetSceneSpec.assetDefinitions).toEqual(base.assetDefinitions);
    expect(result.plan.operation).toEqual({
      operationId: "op_replace_sofa_r8",
      type: "ReplaceAsset",
      targetId: "asset_living_sofa_main",
      oldAssetDefinitionId: "assetdef_sofa_proxy_standard_v1",
      newAssetDefinition: {
        id: "assetdef_sofa_proxy_alternate_v1",
        category: "sofa",
        dimensions: [2200, 900, 760],
        pivotPolicy: "floor_center",
        allowNonUniformScale: false,
      },
      placementPolicy: "preserve_anchor",
    });
  });

  it("blocks invalid replacements before DCC and allows unrelated property locks", () => {
    const base = fixture("revisions/rev_golden_0007/scene-spec.json");
    const changeSet = fixture("changesets/replace-sofa-r8.json");

    const missingTarget = structuredClone(changeSet);
    operation(missingTarget).targetId = "asset_missing_target";
    expect(errorCode(() => planSceneRevision(base, missingTarget))).toBe("TARGET_NOT_FOUND");

    const missingDefinition = structuredClone(changeSet);
    parameters(missingDefinition).newAssetDefinitionId = "assetdef_missing";
    expect(errorCode(() => planSceneRevision(base, missingDefinition))).toBe(
      "ASSET_DEFINITION_NOT_FOUND",
    );

    const sameDefinition = structuredClone(changeSet);
    parameters(sameDefinition).newAssetDefinitionId = "assetdef_sofa_proxy_standard_v1";
    expect(errorCode(() => planSceneRevision(base, sameDefinition))).toBe(
      "ASSET_DEFINITION_UNCHANGED",
    );

    const wrongCategory = structuredClone(changeSet);
    parameters(wrongCategory).newAssetDefinitionId = "assetdef_coffee_table_proxy_standard_v1";
    expect(errorCode(() => planSceneRevision(base, wrongCategory))).toBe(
      "ASSET_CATEGORY_INCOMPATIBLE",
    );

    const wrongPivotBase = structuredClone(base);
    definition(wrongPivotBase, "assetdef_sofa_proxy_alternate_v1").pivotPolicy =
      "back_center_floor";
    expect(errorCode(() => planSceneRevision(wrongPivotBase, changeSet))).toBe(
      "ASSET_PIVOT_INCOMPATIBLE",
    );

    const geometryLockedBase = structuredClone(base);
    (
      asset(geometryLockedBase, "asset_living_sofa_main").locks as Record<string, unknown>
    ).geometry = true;
    expect(errorCode(() => planSceneRevision(geometryLockedBase, changeSet))).toBe(
      "GEOMETRY_LOCKED",
    );

    const scaleIncompatibleBase = structuredClone(base);
    (
      asset(scaleIncompatibleBase, "asset_living_sofa_main").transform as Record<string, unknown>
    ).scale = [1, 2, 1];
    expect(errorCode(() => planSceneRevision(scaleIncompatibleBase, changeSet))).toBe(
      "NON_UNIFORM_SCALE_NOT_ALLOWED",
    );

    const outsideBase = structuredClone(base);
    (asset(outsideBase, "asset_living_sofa_main").transform as Record<string, unknown>).position = [
      5500, 3350, 0,
    ];
    expect(errorCode(() => planSceneRevision(outsideBase, changeSet))).toBe("OBJECT_OUTSIDE_SPACE");

    const stale = structuredClone(changeSet);
    stale.baseRevisionId = "rev_golden_0006";
    expect(errorCode(() => planSceneRevision(base, stale))).toBe("STALE_REVISION");

    const transformLockedBase = structuredClone(base);
    (
      asset(transformLockedBase, "asset_living_sofa_main").locks as Record<string, unknown>
    ).transform = true;
    expect(() => planSceneRevision(transformLockedBase, changeSet)).not.toThrow();

    const materialLockedBase = structuredClone(base);
    (
      asset(materialLockedBase, "asset_living_sofa_main").locks as Record<string, unknown>
    ).material = true;
    expect(() => planSceneRevision(materialLockedBase, changeSet)).not.toThrow();
  });

  it("accepts exactly the sofa definition and dimensions semantic diff", () => {
    const changeSet = fixture("changesets/replace-sofa-r8.json");
    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0007/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0008/expected-scene-manifest.json"),
    );
    expect(() => assertRevisionDiff(diff, changeSet as never)).not.toThrow();
    expect(diff).toMatchObject({
      revision: { before: "rev_golden_0007", after: "rev_golden_0008" },
      changed: [
        {
          logicalId: "asset_living_sofa_main",
          changes: {
            assetDefinitionId: {
              before: "assetdef_sofa_proxy_standard_v1",
              after: "assetdef_sofa_proxy_alternate_v1",
            },
            dimensions: { before: [2400, 950, 780], after: [2200, 900, 760] },
          },
        },
      ],
      added: [],
      removed: [],
    });
    expect(diff.unchanged).toHaveLength(13);
  });

  it("routes a completed replacement request to replay without a second mutation", () => {
    const request = {
      idempotencyKey: "revision.chg_replace_sofa_r8",
      requestHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      jobId: "job_replace_sofa_r8_0001",
    };
    const inProgress = startLedgerAttempt(null, request);
    expect(evaluateLedger({ ...inProgress, status: "SUCCESS" }, request)).toBe("REPLAY_SUCCESS");
  });
});
