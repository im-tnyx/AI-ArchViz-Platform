import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  semanticJsonHash,
  validateAssetArtifact,
  validateAssetInspection,
} from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileGoldenBuildPlan,
  planSceneRevision,
  RevisionValidationError,
  resolveVerifiedAssetArtifact,
  validateAssetArtifactEligibility,
  validateAssetArtifactRegistry,
  WorkerError,
} from "../../apps/worker/src/index.js";

const goldenRoot = resolve("tests/fixtures/living-room-golden");
const fixtureRoot = resolve("tests/fixtures/asset-trust");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function goldenFixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(goldenRoot, path), "utf8")) as Record<string, unknown>;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing`);
  }
  return value as Record<string, unknown>;
}

function firstRecord(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return requiredRecord(value[0], label);
}

function replacementParameters(changeSet: Record<string, unknown>): Record<string, unknown> {
  return requiredRecord(
    firstRecord(changeSet.operations, "ChangeSet operation").parameters,
    "parameters",
  );
}

function firstRegistryRecord(registry: Record<string, unknown>): Record<string, unknown> {
  return firstRecord(registry.records, "Registry record");
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function registryFor(
  bytes: Buffer,
  storageKey = "objects/aa/bb/fixture.max",
): Record<string, unknown> {
  const artifact = {
    artifactContractVersion: "0.1.0",
    artifactId: "artifact_sofa_external_contract_fixture_v1",
    format: "3ds_max",
    sha256: sha256(bytes),
    byteLength: bytes.length,
    trustState: "VERIFIED",
    source: { kind: "curated_library", referenceId: "source_fixture_catalog_v1" },
  };
  return {
    records: [
      {
        artifact,
        storageKey,
        inspection: {
          inspectionVersion: "0.1.0",
          artifactId: artifact.artifactId,
          artifactSha256: artifact.sha256,
          inspector: { type: "trusted_3ds_max_asset_inspector", version: "0.1.0" },
          dcc: { product: "3ds_max", testedMajorVersion: 2025, compatibilityMode: true },
          result: "pass",
          findings: [],
        },
      },
    ],
  };
}

function externalDefinition(): Record<string, unknown> {
  return readFixture("external-sofa-asset-definition.json");
}

function workerErrorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof WorkerError ? error.code : null;
  }
}

function revisionErrorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof RevisionValidationError ? error.code : null;
  }
}

describe("trusted external asset contracts", () => {
  it("validates versioned artifact and inspection evidence fixtures", () => {
    const artifact = readFixture("artifact-record.json");
    const inspection = readFixture("inspection-evidence.json");
    expect(validateAssetArtifact(artifact)).toMatchObject({ ok: true });
    expect(validateAssetInspection(inspection)).toMatchObject({ ok: true });

    artifact.sha256 = "sha256:UPPERCASE";
    inspection.dcc = { product: "3ds_max", testedMajorVersion: 0, compatibilityMode: false };
    expect(validateAssetArtifact(artifact)).toMatchObject({ ok: false });
    expect(validateAssetInspection(inspection)).toMatchObject({ ok: false });
  });

  it("keeps external SceneSpec definitions structural, portable, and unassigned", () => {
    const scene = goldenFixture("scene-spec.json");
    (scene.assetDefinitions as Array<Record<string, unknown>>).push(externalDefinition());
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
    expect(
      (scene.assets as Array<Record<string, unknown>>).some(
        (asset) => asset.assetDefinitionId === "assetdef_sofa_external_contract_fixture_v1",
      ),
    ).toBe(false);

    const definition = (scene.assetDefinitions as Array<Record<string, unknown>>).at(-1);
    expect(definition).toEqual(externalDefinition());
    expect(definition).not.toHaveProperty("storageKey");
    expect(definition).not.toHaveProperty("path");
    expect(definition).not.toHaveProperty("url");
    expect(definition).not.toHaveProperty("command");
    const semanticHash = semanticJsonHash(scene);
    for (const trustedAssetRoot of ["C:/trusted-assets-a", "D:/trusted-assets-b"]) {
      expect(trustedAssetRoot).toMatch(/trusted-assets/u);
      expect(semanticJsonHash(scene)).toBe(semanticHash);
    }

    const missingArtifact = structuredClone(scene);
    const missingArtifactDefinition = (
      missingArtifact.assetDefinitions as Array<Record<string, unknown>>
    ).at(-1);
    if (!missingArtifactDefinition) throw new Error("External fixture definition is missing");
    delete missingArtifactDefinition.artifactId;
    expect(validateSceneSpec(missingArtifact)).toMatchObject({ ok: false });

    const proceduralWithArtifact = goldenFixture("scene-spec.json");
    firstRecord(proceduralWithArtifact.assetDefinitions, "Procedural definition").artifactId =
      "artifact_sofa_external_contract_fixture_v1";
    expect(validateSceneSpec(proceduralWithArtifact)).toMatchObject({ ok: false });
  });

  it("keeps external definitions out of the current procedural build and revision paths", () => {
    const scene = goldenFixture("scene-spec.json");
    (scene.assetDefinitions as Array<Record<string, unknown>>).push(externalDefinition());
    const assigned = structuredClone(scene);
    firstRecord(assigned.assets, "Golden asset").assetDefinitionId =
      "assetdef_sofa_external_contract_fixture_v1";
    expect(() => compileGoldenBuildPlan(assigned)).toThrow(/not buildable in Spike 7A/u);

    const revisionBase = goldenFixture("revisions/rev_golden_0007/scene-spec.json");
    (revisionBase.assetDefinitions as Array<Record<string, unknown>>).push(externalDefinition());
    const changeSet = goldenFixture("changesets/replace-sofa-r8.json");
    replacementParameters(changeSet).newAssetDefinitionId =
      "assetdef_sofa_external_contract_fixture_v1";
    expect(revisionErrorCode(() => planSceneRevision(revisionBase, changeSet))).toBe(
      "ASSET_EXTERNAL_SOURCE_UNSUPPORTED",
    );
  });

  it("keeps ReplaceAsset free of paths, hashes, and trust overrides", () => {
    const changeSet = goldenFixture("changesets/replace-sofa-r8.json");
    for (const field of ["path", "url", "artifactHash", "artifactId", "trustState", "storageKey"]) {
      const altered = structuredClone(changeSet);
      replacementParameters(altered)[field] = "bypass_attempt";
      expect(validateSceneChangeSet(altered)).toMatchObject({ ok: false });
    }
  });
});

describe("trusted external asset registry and resolver", () => {
  it("requires a unique verified artifact with correctly bound passing inspection", () => {
    const bytes = Buffer.from("synthetic-not-a-real-max-file", "utf8");
    const registry = registryFor(bytes);
    expect(
      validateAssetArtifactEligibility(externalDefinition() as never, registry as never),
    ).toEqual({
      artifactId: "artifact_sofa_external_contract_fixture_v1",
      format: "3ds_max",
      sha256: sha256(bytes),
      byteLength: bytes.length,
    });
    expect(
      validateAssetArtifactRegistry(registry as never).get(
        "artifact_sofa_external_contract_fixture_v1",
      ),
    ).not.toHaveProperty("storageKey");

    const duplicate = structuredClone(registry) as Record<string, unknown>;
    const duplicateRecords = duplicate.records as unknown[];
    const conflictingRecord = structuredClone(firstRegistryRecord(duplicate));
    requiredRecord(conflictingRecord.artifact, "Conflicting artifact").sha256 =
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    duplicateRecords.push(conflictingRecord);
    expect(workerErrorCode(() => validateAssetArtifactRegistry(duplicate as never))).toBe(
      "ASSET_ARTIFACT_REGISTRY_INVALID",
    );

    const mismatchedInspection = structuredClone(registry) as Record<string, unknown>;
    requiredRecord(
      firstRegistryRecord(mismatchedInspection).inspection,
      "Inspection evidence",
    ).artifactSha256 = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(
      workerErrorCode(() => validateAssetArtifactRegistry(mismatchedInspection as never)),
    ).toBe("ASSET_ARTIFACT_INSPECTION_INVALID");

    for (const trustState of ["QUARANTINED", "INSPECTED", "REJECTED"]) {
      const unverified = structuredClone(registry) as Record<string, unknown>;
      requiredRecord(firstRegistryRecord(unverified).artifact, "Artifact record").trustState =
        trustState;
      expect(
        workerErrorCode(() =>
          validateAssetArtifactEligibility(externalDefinition() as never, unverified as never),
        ),
      ).toBe("ASSET_ARTIFACT_NOT_VERIFIED");
    }
  });

  it("resolves only exact verified bytes inside the canonical trusted root", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-trusted-assets-"));
    temporaryDirectories.push(root);
    const bytes = Buffer.from("synthetic-not-a-real-max-file", "utf8");
    const storageKey = "objects/aa/bb/fixture.max";
    const artifactPath = join(root, "objects", "aa", "bb", "fixture.max");
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, bytes);
    const registry = registryFor(bytes, storageKey);

    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_sofa_external_contract_fixture_v1",
        trustedAssetRoot: root,
        registry: registry as never,
      }),
    ).resolves.toMatchObject({
      artifactId: "artifact_sofa_external_contract_fixture_v1",
      sha256: sha256(bytes),
      byteLength: bytes.length,
      internalPath: artifactPath,
    });

    writeFileSync(artifactPath, Buffer.from("mutated-synthetic-bytes", "utf8"));
    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_sofa_external_contract_fixture_v1",
        trustedAssetRoot: root,
        registry: registry as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_SIZE_MISMATCH" });

    writeFileSync(artifactPath, Buffer.alloc(bytes.length, "x"));
    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_sofa_external_contract_fixture_v1",
        trustedAssetRoot: root,
        registry: registry as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_HASH_MISMATCH" });
  });

  it("rejects missing files, directories, bad extensions, traversal, and symlink escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-trusted-assets-"));
    temporaryDirectories.push(root);
    const bytes = Buffer.from("synthetic-not-a-real-max-file", "utf8");
    const registry = registryFor(bytes);

    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_sofa_external_contract_fixture_v1",
        trustedAssetRoot: root,
        registry: registry as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_NOT_FOUND" });

    for (const storageKey of [
      "../outside.max",
      "objects/../outside.max",
      "objects\\outside.max",
      "objects/aa\\bb/fixture.max",
      "C:\\outside.max",
      "\\\\server\\share\\outside.max",
      "/outside.max",
      "objects/file.fbx",
      "objects/\u0000file.max",
    ]) {
      const unsafeRegistry = registryFor(bytes, storageKey);
      expect(workerErrorCode(() => validateAssetArtifactRegistry(unsafeRegistry as never))).toMatch(
        /^ASSET_ARTIFACT_(PATH_ESCAPE|TYPE_INVALID)$/u,
      );
    }

    const directoryPath = join(root, "objects", "aa", "bb", "fixture.max");
    mkdirSync(directoryPath, { recursive: true });
    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_sofa_external_contract_fixture_v1",
        trustedAssetRoot: root,
        registry: registry as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_TYPE_INVALID" });

    const outsideRoot = mkdtempSync(join(tmpdir(), "ai-archviz-untrusted-assets-"));
    temporaryDirectories.push(outsideRoot);
    const outsideFile = join(outsideRoot, "escape.max");
    writeFileSync(outsideFile, bytes);
    const linkPath = join(root, "objects", "aa", "bb", "fixture.max");
    rmSync(directoryPath, { recursive: true, force: true });
    mkdirSync(dirname(linkPath), { recursive: true });
    try {
      symlinkSync(outsideFile, linkPath, "file");
    } catch {
      return;
    }
    await expect(
      resolveVerifiedAssetArtifact({
        artifactId: "artifact_sofa_external_contract_fixture_v1",
        trustedAssetRoot: root,
        registry: registry as never,
      }),
    ).rejects.toMatchObject({ code: "ASSET_ARTIFACT_PATH_ESCAPE" });
  });
});
