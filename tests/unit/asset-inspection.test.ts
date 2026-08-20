import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateAssetInspection, validateAssetInspectionJob } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  promoteArtifactAfterInspection,
  resolveArtifactForInspection,
  resolveVerifiedAssetArtifact,
  WorkerError,
} from "../../apps/worker/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function artifact(bytes: Buffer, trustState: string = "QUARANTINED"): Record<string, unknown> {
  return {
    artifactContractVersion: "0.1.0",
    artifactId: "artifact_inspection_unit_fixture_v1",
    format: "3ds_max",
    sha256: sha256(bytes),
    byteLength: bytes.length,
    trustState,
    source: { kind: "internal", referenceId: "source_inspection_unit_fixture_v1" },
  };
}

function inspectionEvidence(
  artifactRecord: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    inspectionVersion: "0.1.0",
    artifactId: artifactRecord.artifactId,
    artifactSha256: artifactRecord.sha256,
    inspector: { type: "trusted_3ds_max_asset_inspector", version: "0.1.0" },
    dcc: { product: "3ds_max", testedMajorVersion: 2025, compatibilityMode: true },
    result: "pass",
    findings: [],
    observations: {
      scene: { nodeCount: 1, geometryNodeCount: 1, cameraCount: 0, lightCount: 0 },
      geometry: {
        worldBoundingBoxMm: [0, 0, 0, 2200, 900, 760],
        dimensionsMm: [2200, 900, 760],
        pivotPositionMm: [1100, 450, 0],
        floorCenterAnchorCompatible: true,
      },
      units: {
        systemType: "#millimeters",
        systemScale: 1,
        displayType: "#metric",
        normalization: "millimeters",
        useFileUnits: true,
      },
      materials: { materialCount: 1, classNames: ["standardmaterial"] },
      dependencies: {
        missingExternalFiles: 0,
        missingDLLs: 0,
        xrefs: 0,
        externalReferenceCount: 0,
      },
      security: {
        safeSceneScriptExecutionEnabled: true,
        settingsLocked: true,
        lockCause: "cmdline",
        scriptAssetsProtected: true,
      },
    },
    ...overrides,
  };
}

function registry(
  artifactRecord: Record<string, unknown>,
  inspection?: Record<string, unknown>,
  storageKey = "objects/inspection/fixture.max",
): Record<string, unknown> {
  return {
    records: [
      {
        artifact: artifactRecord,
        storageKey,
        ...(inspection ? { inspection } : {}),
      },
    ],
  };
}

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof WorkerError ? error.code : null;
  }
}

describe("isolated asset inspection contracts", () => {
  it("accepts only the minimal non-executable inspection job shape", () => {
    const bytes = Buffer.from("synthetic fixture", "utf8");
    const artifactRecord = artifact(bytes);
    const job = {
      inspectionJobVersion: "0.1.0",
      artifactId: artifactRecord.artifactId,
      artifactSha256: artifactRecord.sha256,
      format: "3ds_max",
    };
    expect(validateAssetInspectionJob(job)).toMatchObject({ ok: true });
    for (const forbidden of [
      "path",
      "storageKey",
      "python",
      "maxscript",
      "command",
      "outputPath",
    ]) {
      expect(validateAssetInspectionJob({ ...job, [forbidden]: "attempt" })).toMatchObject({
        ok: false,
      });
    }
  });

  it("resolves exact quarantined bytes for inspection but leaves production verified-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-inspection-"));
    temporaryDirectories.push(root);
    const bytes = Buffer.from("synthetic fixture", "utf8");
    const artifactRecord = artifact(bytes);
    const filePath = join(root, "objects", "inspection", "fixture.max");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);
    const pendingRegistry = registry(artifactRecord);

    await expect(
      resolveArtifactForInspection({
        artifactId: "artifact_inspection_unit_fixture_v1",
        trustedAssetRoot: root,
        registry: pendingRegistry as never,
      }),
    ).resolves.toMatchObject({ internalPath: filePath, sha256: sha256(bytes) });
    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_inspection_unit_fixture_v1",
        trustedAssetRoot: root,
        registry: pendingRegistry as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_NOT_VERIFIED" });

    for (const trustState of ["INSPECTED", "VERIFIED", "REJECTED"]) {
      const otherArtifact = { ...artifactRecord, trustState };
      await expect(
        resolveArtifactForInspection({
          artifactId: "artifact_inspection_unit_fixture_v1",
          trustedAssetRoot: root,
          registry: registry(otherArtifact, inspectionEvidence(otherArtifact)) as never,
        }),
      ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_NOT_VERIFIED" });
    }
    await expect(
      resolveArtifactForInspection({
        artifactId: "artifact_inspection_unit_fixture_v1",
        trustedAssetRoot: root,
        registry: registry(artifactRecord, undefined, "../outside.max") as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_PATH_ESCAPE" });
  });

  it("validates normalized observations and promotes only matching passing evidence", () => {
    const artifactRecord = artifact(Buffer.from("synthetic fixture", "utf8"));
    const evidence = inspectionEvidence(artifactRecord);
    expect(validateAssetInspection(evidence)).toMatchObject({ ok: true });
    expect(
      promoteArtifactAfterInspection({
        artifact: artifactRecord as never,
        evidence: evidence as never,
      }),
    ).toMatchObject({ trustState: "VERIFIED" });

    const dependencyEvidence = inspectionEvidence(artifactRecord, {
      result: "fail",
      failureCode: "ASSET_EXTERNAL_DEPENDENCY_DETECTED",
      findings: ["ASSET_EXTERNAL_DEPENDENCY_DETECTED"],
      observations: {
        ...((inspectionEvidence(artifactRecord).observations as Record<string, unknown>) ?? {}),
        dependencies: {
          missingExternalFiles: 2,
          missingDLLs: 0,
          xrefs: 0,
          externalReferenceCount: 2,
        },
      },
    });
    expect(validateAssetInspection(dependencyEvidence)).toMatchObject({ ok: true });
    expect(
      errorCode(() =>
        promoteArtifactAfterInspection({
          artifact: artifactRecord as never,
          evidence: dependencyEvidence as never,
        }),
      ),
    ).toBe("ASSET_ARTIFACT_INSPECTION_INVALID");

    const evidenceWithoutObservations = inspectionEvidence(artifactRecord);
    delete evidenceWithoutObservations.observations;
    expect(
      errorCode(() =>
        promoteArtifactAfterInspection({
          artifact: artifactRecord as never,
          evidence: evidenceWithoutObservations as never,
        }),
      ),
    ).toBe("ASSET_ARTIFACT_INSPECTION_INVALID");

    const mismatchedEvidence = inspectionEvidence(artifactRecord, {
      artifactSha256: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      errorCode(() =>
        promoteArtifactAfterInspection({
          artifact: artifactRecord as never,
          evidence: mismatchedEvidence as never,
        }),
      ),
    ).toBe("ASSET_ARTIFACT_INSPECTION_INVALID");
  });

  it("binds evidence to exact bytes and keeps the inspector free of production merge APIs", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-inspection-"));
    temporaryDirectories.push(root);
    const bytes = Buffer.from("synthetic fixture", "utf8");
    const artifactRecord = artifact(bytes);
    const evidence = inspectionEvidence(artifactRecord);
    const promoted = promoteArtifactAfterInspection({
      artifact: artifactRecord as never,
      evidence: evidence as never,
    });
    const filePath = join(root, "objects", "inspection", "fixture.max");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);
    const promotedRegistry = registry(promoted, evidence);
    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_inspection_unit_fixture_v1",
        trustedAssetRoot: root,
        registry: promotedRegistry as never,
      }),
    ).resolves.toMatchObject({ internalPath: filePath });
    writeFileSync(filePath, Buffer.alloc(bytes.length, 0x78));
    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_inspection_unit_fixture_v1",
        trustedAssetRoot: root,
        registry: promotedRegistry as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_HASH_MISMATCH" });

    const inspectorSource = readFileSync(
      resolve("apps/worker/src/asset-inspection.ts"),
      "utf8",
    ).toLowerCase();
    expect(inspectorSource).not.toContain("mergemaxfile");
    expect(inspectorSource).not.toContain("importfile");
    expect(inspectorSource).not.toContain("replaceasset");
  });
});
