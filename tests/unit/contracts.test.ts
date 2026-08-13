import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  checkBaseRevision,
  validateExecutionReport,
  validateJobEnvelope,
  validateSceneManifest,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureRoot, relativePath), "utf8"));
}

function applyFixtureMutation(caseName: string): unknown {
  const fixture = structuredClone(readJson("scene-spec.json")) as Record<string, unknown>;
  const testCase = readJson(`invalid/${caseName}`) as {
    mutation: { operation: "replace" | "remove"; path: string; value?: unknown };
  };
  const path = testCase.mutation.path
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const key = path.pop();
  if (!key) throw new Error("Invalid mutation path");
  let parent: Record<string, unknown> | unknown[] = fixture;
  for (const segment of path) {
    parent = Array.isArray(parent)
      ? (parent[Number(segment)] as Record<string, unknown> | unknown[])
      : (parent[segment] as Record<string, unknown> | unknown[]);
  }
  if (testCase.mutation.operation === "remove") {
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else delete parent[key];
  } else if (Array.isArray(parent)) {
    parent[Number(key)] = testCase.mutation.value;
  } else {
    parent[key] = testCase.mutation.value;
  }
  return fixture;
}

describe("SceneSpec contract", () => {
  it("accepts the Golden SceneSpec", () => {
    expect(validateSceneSpec(readJson("scene-spec.json"))).toMatchObject({ ok: true });
  });

  it.each(["invalid-schema-version.json", "missing-scene-id.json", "negative-scale.json"])(
    "rejects %s",
    (caseName) => {
      expect(validateSceneSpec(applyFixtureMutation(caseName))).toMatchObject({ ok: false });
    },
  );
});

describe("worker contracts", () => {
  it("accepts the Golden Job Envelope", () => {
    expect(validateJobEnvelope(readJson("job-envelope.json"))).toMatchObject({ ok: true });
  });

  it("recognizes the stale revision fixture after schema validation", () => {
    const validation = validateJobEnvelope(readJson("invalid/stale-revision-job.json"));
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(checkBaseRevision(validation.value, null)).toEqual({
      ok: false,
      errorCode: "STALE_REVISION",
      expectedBaseRevisionId: null,
      actualBaseRevisionId: "rev_golden_0000",
    });
  });

  it("accepts the expected semantic scene manifest", () => {
    expect(validateSceneManifest(readJson("expected-scene-manifest.json"))).toMatchObject({
      ok: true,
    });
  });

  it("accepts a deterministic successful execution report", () => {
    const job = readJson("job-envelope.json") as Record<string, unknown>;
    expect(
      validateExecutionReport({
        reportVersion: "0.1.0",
        jobId: job.jobId,
        idempotencyKey: job.idempotencyKey,
        requestHash: job.requestHash,
        projectId: job.projectId,
        sceneId: job.sceneId,
        revisionId: "rev_golden_0001",
        status: "SUCCESS",
        startedAt: "2026-08-13T09:30:00Z",
        completedAt: "2026-08-13T09:31:00Z",
        candidatePath: "candidate/project.max",
        verifiedOutputPath: "output/project.max",
        manifestPath: "verification/scene-manifest.json",
        validationResult: { status: "PASS", errors: [] },
        verificationResult: { status: "PASS", errors: [] },
        error: null,
      }),
    ).toMatchObject({ ok: true });
  });
});
