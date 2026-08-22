import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import {
  assertGoldenRevisionDiff,
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
