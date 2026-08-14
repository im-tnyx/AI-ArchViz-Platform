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

function required<T>(value: T | undefined, message = "Required fixture value missing"): T {
  if (value === undefined) throw new Error(message);
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

function coffeeTable(scene: Record<string, unknown>): Record<string, unknown> {
  const assets = scene.assets as Array<Record<string, unknown>>;
  return required(assets.find((asset) => asset.id === "asset_living_coffee_table_main"));
}

function unlockChangeSet(): Record<string, unknown> {
  return fixture("changesets/unlock-coffee-table-transform-r6.json");
}

function moveAfterUnlockChangeSet(): Record<string, unknown> {
  return fixture("changesets/move-coffee-table-after-unlock-r7.json");
}

function rev5(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0005/scene-spec.json");
}

function rev6(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0006/scene-spec.json");
}

function rev7(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0007/scene-spec.json");
}

describe("SceneChangeSet UnlockProperty contract", () => {
  it("accepts the Golden unlock and rejects arbitrary paths or bypass fields", () => {
    expect(validateSceneChangeSet(unlockChangeSet())).toMatchObject({ ok: true });

    const arbitraryPath = unlockChangeSet() as {
      operations: Array<{ parameters: { propertyPath: string } }>;
    };
    required(arbitraryPath.operations[0]).parameters.propertyPath = "transform.position";
    expect(validateSceneChangeSet(arbitraryPath)).toMatchObject({ ok: false });

    const bypass = unlockChangeSet() as {
      operations: Array<{ parameters: Record<string, unknown> }>;
    };
    required(bypass.operations[0]).parameters.force = true;
    expect(validateSceneChangeSet(bypass)).toMatchObject({ ok: false });
  });
});

describe("UnlockProperty pre-DCC planning", () => {
  it("computes rev0006 and changes only the active transform lock", () => {
    const base = rev5();
    const result = planSceneRevision(base, unlockChangeSet());
    const expected = rev6();
    expect(validateSceneSpec(expected)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(result.plan.operation).toEqual({
      operationId: "op_unlock_coffee_table_transform_r6",
      type: "UnlockProperty",
      targetId: "asset_living_coffee_table_main",
      propertyPath: "transform",
    });
    expect(coffeeTable(result.targetSceneSpec).transform).toEqual(coffeeTable(base).transform);
    expect(coffeeTable(result.targetSceneSpec).locks).toEqual({
      geometry: false,
      transform: false,
      material: false,
    });
    expect(result.targetSceneSpec.geometry).toEqual(base.geometry);
    expect(result.targetSceneSpec.materialAssignments).toEqual(base.materialAssignments);
  });

  it("blocks missing, unsupported, already-unlocked, wrong-property, and stale unlocks", () => {
    const missingTarget = unlockChangeSet() as { operations: Array<{ targetId: string }> };
    required(missingTarget.operations[0]).targetId = "asset_missing";
    expect(errorCode(() => planSceneRevision(rev5(), missingTarget))).toBe("TARGET_NOT_FOUND");

    const unsupportedTarget = unlockChangeSet() as { operations: Array<{ targetId: string }> };
    required(unsupportedTarget.operations[0]).targetId = "camera_living_a";
    expect(errorCode(() => planSceneRevision(rev5(), unsupportedTarget))).toBe(
      "PROPERTY_LOCK_UNSUPPORTED",
    );

    const alreadyUnlocked = unlockChangeSet();
    alreadyUnlocked.baseRevisionId = "rev_golden_0006";
    alreadyUnlocked.targetRevisionId = "rev_golden_0007";
    expect(errorCode(() => planSceneRevision(rev6(), alreadyUnlocked))).toBe(
      "PROPERTY_ALREADY_UNLOCKED",
    );

    const wrongProperty = unlockChangeSet() as {
      operations: Array<{ parameters: { propertyPath: "material" } }>;
    };
    required(wrongProperty.operations[0]).parameters.propertyPath = "material";
    expect(errorCode(() => planSceneRevision(rev5(), wrongProperty))).toBe(
      "PROPERTY_ALREADY_UNLOCKED",
    );

    const stale = unlockChangeSet();
    stale.baseRevisionId = "rev_golden_0004";
    expect(errorCode(() => planSceneRevision(rev5(), stale))).toBe("STALE_REVISION");
  });
});

describe("UnlockProperty and MoveObject semantic transitions", () => {
  it("reports only locks.transform from rev0005 to rev0006", () => {
    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0005/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0006/expected-scene-manifest.json"),
    );
    const planned = planSceneRevision(rev5(), unlockChangeSet());
    expect(() => assertRevisionDiff(diff, planned.changeSet)).not.toThrow();
    expect(diff).toMatchObject({
      revision: { before: "rev_golden_0005", after: "rev_golden_0006" },
      changed: [
        {
          logicalId: "asset_living_coffee_table_main",
          changes: { "locks.transform": { before: true, after: false } },
        },
      ],
      added: [],
      removed: [],
    });
    expect(diff.unchanged).toHaveLength(13);
  });

  it("permits the absolute rev0007 move after explicit unlock without cumulative movement", () => {
    const base = rev6();
    const result = planSceneRevision(base, moveAfterUnlockChangeSet());
    expect(result.targetSceneSpec).toEqual(rev7());
    expect(coffeeTable(result.targetSceneSpec).transform).toEqual({
      position: [3300, 2200, 0],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    });
    expect(coffeeTable(result.targetSceneSpec).locks).toEqual({
      geometry: false,
      transform: false,
      material: false,
    });
    expect(planSceneRevision(base, moveAfterUnlockChangeSet()).targetSceneSpec).toEqual(rev7());

    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0006/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0007/expected-scene-manifest.json"),
    );
    expect(() => assertRevisionDiff(diff, result.changeSet)).not.toThrow();
    expect(diff.changed).toEqual([
      {
        logicalId: "asset_living_coffee_table_main",
        changes: { "transform.position": { before: [3250, 2200, 0], after: [3300, 2200, 0] } },
      },
    ]);
    expect(diff.unchanged).toHaveLength(13);
  });
});

describe("UnlockProperty durable idempotency", () => {
  it("replays successful unlock and move requests but rejects same-key semantic reuse", () => {
    const unlockRequest = {
      idempotencyKey: "revision.chg_unlock_coffee_table_transform_r6",
      requestHash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      jobId: "job_unlock_revision_0001",
    };
    const unlockSuccess = {
      ...startLedgerAttempt(null, unlockRequest),
      status: "SUCCESS" as const,
    };
    expect(evaluateLedger(unlockSuccess, unlockRequest)).toBe("REPLAY_SUCCESS");
    expect(
      evaluateLedger(unlockSuccess, {
        ...unlockRequest,
        requestHash: unlockRequest.requestHash.replace("d", "e"),
      }),
    ).toBe("IDEMPOTENCY_KEY_REUSE_MISMATCH");

    const moveRequest = {
      idempotencyKey: "revision.chg_move_coffee_table_after_unlock_r7",
      requestHash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      jobId: "job_unlock_revision_0002",
    };
    const moveSuccess = { ...startLedgerAttempt(null, moveRequest), status: "SUCCESS" as const };
    expect(evaluateLedger(moveSuccess, moveRequest)).toBe("REPLAY_SUCCESS");
  });
});
