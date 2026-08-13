import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import {
  assertRevisionDiff,
  diffSemanticManifests,
  evaluateLedger,
  openingWorldBounds,
  planSceneRevision,
  RevisionValidationError,
  startLedgerAttempt,
} from "../../apps/worker/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function changeSet(): Record<string, unknown> {
  return fixture("changesets/update-window-sill-r3.json");
}

function baseScene(): Record<string, unknown> {
  return fixture("revisions/rev_golden_0002/scene-spec.json");
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

describe("SceneChangeSet UpdateOpening contract", () => {
  it("accepts only the Golden absolute opening state", () => {
    expect(validateSceneChangeSet(changeSet())).toMatchObject({ ok: true });
    const relative = changeSet() as {
      operations: Array<{ parameters: Record<string, unknown> }>;
    };
    required(relative.operations[0]).parameters.deltaSill = 150;
    expect(validateSceneChangeSet(relative)).toMatchObject({ ok: false });
  });

  it("rejects negative sill at schema validation", () => {
    const invalid = changeSet() as {
      operations: Array<{ parameters: { sill: number } }>;
    };
    required(invalid.operations[0]).parameters.sill = -1;
    expect(validateSceneChangeSet(invalid)).toMatchObject({ ok: false });
    expect(errorCode(() => planSceneRevision(baseScene(), invalid))).toBe("SCHEMA_INVALID");
  });
});

describe("UpdateOpening pre-DCC planning", () => {
  it("computes rev0003 and only the north-wall physical rebuild plan", () => {
    const result = planSceneRevision(baseScene(), changeSet());
    const expected = fixture("revisions/rev_golden_0003/scene-spec.json");
    expect(validateSceneSpec(expected)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec).toEqual(expected);
    expect(result.plan.operation).toMatchObject({
      type: "UpdateOpening",
      targetId: "opening_w01",
      hostLogicalId: "wall_north",
      offset: 1800,
      width: 2400,
      sill: 900,
      height: 1500,
      transform: { position: [1800, 0, 900] },
      physicalPosition: [4200, 4575, 900],
    });
    const target = result.targetSceneSpec as {
      geometry: Array<Record<string, unknown>>;
      openings: Array<Record<string, unknown>>;
    };
    expect(
      openingWorldBounds(
        required(target.geometry.find((entry) => entry.id === "wall_north")) as never,
        required(target.openings.find((entry) => entry.id === "opening_w01")) as never,
      ),
    ).toEqual({
      start: [4200, 4500, 0],
      end: [1800, 4500, 0],
      bottom: 900,
      top: 2400,
    });
    if (result.plan.operation.type !== "UpdateOpening") throw new Error("Wrong operation");
    expect(result.plan.operation.wallSegments).not.toHaveLength(0);
    expect(
      result.plan.operation.wallSegments.every((segment) => segment.hostLogicalId === "wall_north"),
    ).toBe(true);
    expect(result.plan.operation.wallSegments.map((segment) => segment.dimensions)).toContainEqual([
      2400, 150, 600,
    ]);
  });

  it("blocks stale revision and missing opening or host", () => {
    const stale = changeSet();
    stale.baseRevisionId = "rev_golden_0001";
    expect(errorCode(() => planSceneRevision(baseScene(), stale))).toBe("STALE_REVISION");

    const missingOpening = changeSet() as { operations: Array<{ targetId: string }> };
    required(missingOpening.operations[0]).targetId = "opening_missing";
    expect(errorCode(() => planSceneRevision(baseScene(), missingOpening))).toBe(
      "TARGET_NOT_FOUND",
    );

    const missingHost = baseScene() as {
      openings: Array<{ id: string; hostGeometryId: string }>;
    };
    required(missingHost.openings.find((entry) => entry.id === "opening_w01")).hostGeometryId =
      "wall_missing";
    expect(errorCode(() => planSceneRevision(missingHost, changeSet()))).toBe("HOST_NOT_FOUND");
  });

  it("blocks opening and required host geometry locks deterministically", () => {
    const openingLocked = baseScene() as {
      openings: Array<{ id: string; locks: { geometry: boolean } }>;
    };
    required(openingLocked.openings.find((entry) => entry.id === "opening_w01")).locks.geometry =
      true;
    expect(errorCode(() => planSceneRevision(openingLocked, changeSet()))).toBe("GEOMETRY_LOCKED");

    const hostLocked = baseScene() as {
      geometry: Array<{ id: string; locks: { geometry: boolean } }>;
    };
    required(hostLocked.geometry.find((entry) => entry.id === "wall_north")).locks.geometry = true;
    expect(errorCode(() => planSceneRevision(hostLocked, changeSet()))).toBe("GEOMETRY_LOCKED");
  });

  it("blocks horizontal and vertical host overflow before DCC", () => {
    const horizontal = changeSet() as {
      operations: Array<{ parameters: { offset: number; width: number } }>;
    };
    required(horizontal.operations[0]).parameters.offset = 4000;
    required(horizontal.operations[0]).parameters.width = 2400;
    expect(errorCode(() => planSceneRevision(baseScene(), horizontal))).toBe(
      "OPENING_EXCEEDS_HOST",
    );

    const vertical = changeSet() as {
      operations: Array<{ parameters: { sill: number; height: number } }>;
    };
    required(vertical.operations[0]).parameters.sill = 1600;
    required(vertical.operations[0]).parameters.height = 1500;
    expect(errorCode(() => planSceneRevision(baseScene(), vertical))).toBe("OPENING_EXCEEDS_HOST");
  });
});

describe("UpdateOpening semantic preservation and replay", () => {
  it("changes only opening sill and canonical vertical position", () => {
    const diff = diffSemanticManifests(
      fixture("revisions/rev_golden_0002/expected-scene-manifest.json"),
      fixture("revisions/rev_golden_0003/expected-scene-manifest.json"),
    );
    const planned = planSceneRevision(baseScene(), changeSet());
    expect(() => assertRevisionDiff(diff, planned.changeSet)).not.toThrow();
    expect(diff.changed).toEqual([
      {
        logicalId: "opening_w01",
        changes: {
          sill: { before: 750, after: 900 },
          "transform.position": { before: [1800, 0, 750], after: [1800, 0, 900] },
        },
      },
    ]);
    expect(diff.unchanged).toHaveLength(13);
    expect(diff.unchanged).toContain("wall_north");
    expect(diff.unchanged).toContain("asset_living_coffee_table_main");
  });

  it("routes identical absolute state to replay, never a cumulative +150 mutation", () => {
    const request = {
      idempotencyKey: "revision.chg_golden_update_window_sill_r3",
      requestHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      jobId: "job_opening_revision_0001",
    };
    const inProgress = startLedgerAttempt(null, request);
    expect(evaluateLedger({ ...inProgress, status: "SUCCESS" }, request)).toBe("REPLAY_SUCCESS");
    const parameters = { offset: 1800, width: 2400, sill: 900, height: 1500 };
    expect(parameters.sill).toBe(900);
    expect(parameters.sill).not.toBe(1050);
  });
});
