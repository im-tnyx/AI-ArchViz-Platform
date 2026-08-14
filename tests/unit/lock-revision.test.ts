import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import {
  assertRevisionDiff,
  compareSceneManifests,
  diffSemanticManifests,
  evaluateLedger,
  planSceneRevision,
  RevisionValidationError,
  startLedgerAttempt,
} from "../../apps/worker/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");
const tolerances = {
  geometryToleranceMm: 0.01,
  transformToleranceMm: 0.01,
  rotationToleranceDeg: 0.01,
};

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function lockChangeSet(): Record<string, unknown> {
  return fixture("changesets/lock-coffee-table-transform-r5.json");
}

function blockedMoveChangeSet(): Record<string, unknown> {
  return fixture("changesets/move-locked-coffee-table-r6.json");
}

function rev4(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0004/scene-spec.json");
}

function rev5(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0005/scene-spec.json");
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

function coffeeTable(scene: Record<string, unknown>): Record<string, unknown> {
  const assets = scene.assets as Array<Record<string, unknown>>;
  return required(assets.find((asset) => asset.id === "asset_living_coffee_table_main"));
}

describe("SceneChangeSet LockProperty contract", () => {
  it("accepts the Golden lock and rejects arbitrary nested property paths", () => {
    expect(validateSceneChangeSet(lockChangeSet())).toMatchObject({ ok: true });
    const invalid = lockChangeSet() as {
      operations: Array<{ parameters: { propertyPath: string } }>;
    };
    required(invalid.operations[0]).parameters.propertyPath = "transform.position";
    expect(validateSceneChangeSet(invalid)).toMatchObject({ ok: false });
  });
});

describe("LockProperty pre-DCC planning", () => {
  it("computes rev0005 while preserving all coffee-table design state except transform lock", () => {
    const base = rev4();
    const result = planSceneRevision(base, lockChangeSet());
    const expected = rev5();
    expect(validateSceneSpec(expected)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(result.plan.operation).toEqual({
      operationId: "op_lock_coffee_table_transform_r5",
      type: "LockProperty",
      targetId: "asset_living_coffee_table_main",
      propertyPath: "transform",
    });
    expect(coffeeTable(result.targetSceneSpec).transform).toEqual(coffeeTable(base).transform);
    expect(coffeeTable(result.targetSceneSpec).locks).toEqual({
      geometry: false,
      transform: true,
      material: false,
    });
    expect(result.targetSceneSpec.materialAssignments).toEqual(base.materialAssignments);
    expect(result.targetSceneSpec.geometry).toEqual(base.geometry);
  });

  it("blocks missing targets, unsupported paths, already-locked state, and stale revisions", () => {
    const missingTarget = lockChangeSet() as { operations: Array<{ targetId: string }> };
    required(missingTarget.operations[0]).targetId = "asset_missing";
    expect(errorCode(() => planSceneRevision(rev4(), missingTarget))).toBe("TARGET_NOT_FOUND");

    const cameraTarget = lockChangeSet() as { operations: Array<{ targetId: string }> };
    required(cameraTarget.operations[0]).targetId = "camera_living_a";
    expect(errorCode(() => planSceneRevision(rev4(), cameraTarget))).toBe(
      "PROPERTY_LOCK_UNSUPPORTED",
    );

    const alreadyLocked = lockChangeSet();
    alreadyLocked.baseRevisionId = "rev_golden_0005";
    alreadyLocked.targetRevisionId = "rev_golden_0006";
    expect(errorCode(() => planSceneRevision(rev5(), alreadyLocked))).toBe(
      "PROPERTY_ALREADY_LOCKED",
    );

    const stale = lockChangeSet();
    stale.baseRevisionId = "rev_golden_0003";
    expect(errorCode(() => planSceneRevision(rev4(), stale))).toBe("STALE_REVISION");
  });
});

describe("LockProperty semantic persistence and enforcement", () => {
  it("reports only locks.transform and normalizes manifest lock omission to false", () => {
    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0004/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0005/expected-scene-manifest.json"),
    );
    const planned = planSceneRevision(rev4(), lockChangeSet());
    expect(() => assertRevisionDiff(diff, planned.changeSet)).not.toThrow();
    expect(diff.changed).toEqual([
      {
        logicalId: "asset_living_coffee_table_main",
        changes: {
          "locks.transform": { before: false, after: true },
        },
      },
    ]);
    expect(diff.unchanged).toHaveLength(13);

    const expectedManifest = fixture("revisions/rev_golden_0005/expected-scene-manifest.json");
    const missingPersistedLock = structuredClone(expectedManifest) as {
      nodes: Array<{ logicalId: string; locks?: unknown }>;
    };
    delete required(
      missingPersistedLock.nodes.find(
        (node) => node.logicalId === "asset_living_coffee_table_main",
      ),
    ).locks;
    expect(compareSceneManifests(expectedManifest, missingPersistedLock, tolerances)).toMatchObject(
      {
        ok: false,
        differences: [
          { code: "LOCK_MISMATCH", path: "/nodes/asset_living_coffee_table_main/locks" },
        ],
      },
    );
  });

  it("enforces the verified persistent transform lock before spatial MoveObject execution", () => {
    expect(validateSceneChangeSet(blockedMoveChangeSet())).toMatchObject({ ok: true });
    expect(errorCode(() => planSceneRevision(rev5(), blockedMoveChangeSet()))).toBe(
      "TRANSFORM_LOCKED",
    );
  });

  it("routes an identical LockProperty request to durable replay semantics", () => {
    const request = {
      idempotencyKey: "revision.chg_lock_coffee_table_transform_r5",
      requestHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      jobId: "job_lock_revision_0001",
    };
    const inProgress = startLedgerAttempt(null, request);
    expect(evaluateLedger({ ...inProgress, status: "SUCCESS" }, request)).toBe("REPLAY_SUCCESS");
  });
});
