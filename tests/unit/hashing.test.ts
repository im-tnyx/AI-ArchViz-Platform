import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  calculateRequestHash,
  canonicalizeJson,
  isIdempotencyKeyReuseMismatch,
  semanticJsonHash,
  validateJobEnvelope,
  verifyJobHashes,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(resolve(fixtureRoot, relativePath), "utf8"));
}

describe("RFC 8785 semantic JSON hashing", () => {
  it("passes all equivalence vectors", () => {
    const vectors = readJson("hash-vectors.json") as {
      equivalentJson: {
        expectedCanonicalJson: string;
        expectedContentHash: string;
        cases: Array<{ name: string; jsonText: string }>;
      };
    };
    for (const testCase of vectors.equivalentJson.cases) {
      const value = JSON.parse(testCase.jsonText);
      expect(canonicalizeJson(value), testCase.name).toBe(
        vectors.equivalentJson.expectedCanonicalJson,
      );
      expect(semanticJsonHash(value), testCase.name).toBe(
        vectors.equivalentJson.expectedContentHash,
      );
    }
  });

  it("changes the hash when semantic content changes", () => {
    const vectors = readJson("hash-vectors.json") as {
      semanticDifference: {
        left: { jsonText: string; expectedContentHash: string };
        right: { jsonText: string; expectedContentHash: string };
      };
    };
    const leftHash = semanticJsonHash(JSON.parse(vectors.semanticDifference.left.jsonText));
    const rightHash = semanticJsonHash(JSON.parse(vectors.semanticDifference.right.jsonText));
    expect(leftHash).toBe(vectors.semanticDifference.left.expectedContentHash);
    expect(rightHash).toBe(vectors.semanticDifference.right.expectedContentHash);
    expect(leftHash).not.toBe(rightHash);
  });

  it("matches all Golden content and request hashes", () => {
    const jobValidation = validateJobEnvelope(readJson("job-envelope.json"));
    expect(jobValidation.ok).toBe(true);
    if (!jobValidation.ok) return;
    const sceneSpec = readJson("scene-spec.json");
    const expectedManifest = readJson("expected-scene-manifest.json");
    expect(semanticJsonHash(sceneSpec)).toBe(
      "sha256:f8b06cacd2acc5a5a979dedcc3eee8f1a9ba7deef72205041821cc406634977a",
    );
    expect(semanticJsonHash(expectedManifest)).toBe(
      "sha256:08ebbd75fff42908b6e54c9fe1d4096b91fb223e2ec4ee5d072f5efc8ba6a628",
    );
    expect(calculateRequestHash(jobValidation.value)).toBe(
      "sha256:6bc30b61c8297ddf6ea0366b6a9cf270663166f8ca50277486ca051421be88e5",
    );
    expect(verifyJobHashes(jobValidation.value, sceneSpec, expectedManifest)).toEqual({
      ok: true,
    });
  });

  it("excludes execution-attempt, path, and policy fields from requestHash", () => {
    const validation = validateJobEnvelope(readJson("job-envelope.json"));
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const changedEnvelope = structuredClone(validation.value);
    changedEnvelope.jobId = "job_golden_build_retry_9999";
    changedEnvelope.idempotencyKey = "different-logical-key";
    changedEnvelope.requestHash = `sha256:${"f".repeat(64)}`;
    changedEnvelope.inputs.sceneSpecPath = "moved/scene-spec.json";
    changedEnvelope.inputs.expectedManifestPath = "moved/manifest.json";
    changedEnvelope.policy = {
      mode: "batch",
      timeoutSeconds: 1,
      retryPolicy: "none",
    };
    expect(calculateRequestHash(changedEnvelope)).toBe(calculateRequestHash(validation.value));
  });

  it("recognizes the idempotency-key reuse mismatch fixture", () => {
    const fixture = readJson("invalid/idempotency-key-reuse-mismatch.json") as {
      existingLedgerEntry: { idempotencyKey: string; requestHash: string };
      submittedJob: { idempotencyKey: string; requestHash: string };
    };
    expect(isIdempotencyKeyReuseMismatch(fixture.existingLedgerEntry, fixture.submittedJob)).toBe(
      true,
    );
  });
});
