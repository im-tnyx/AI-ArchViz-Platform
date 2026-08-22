import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { describe, expect, it } from "vitest";
import type { AssetArtifactRegistry } from "../../apps/worker/src/asset-trust.js";
import {
  assertExternalDefinitionAppend,
  diffExternalSemanticManifests,
  ExternalAssetIngestionError,
  externalIngestionRequestHash,
  ingestVerifiedExternalMaxAsset,
  preflightExternalAssetIngestion,
  stageExactVerifiedArtifact,
  type TrustedExternalAssetCatalog,
} from "../../apps/worker/src/external-asset-ingestion.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");
const artifactId = "artifact_controlled_sofa_external_v1";
const artifactSha256 = `sha256:${"a".repeat(64)}`;

function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(fixtureRoot, path), "utf8")) as Record<string, unknown>;
}

function catalog(): TrustedExternalAssetCatalog {
  return {
    catalogVersion: "0.1.0",
    definitions: [
      {
        id: "assetdef_sofa_external_controlled_v1",
        version: "1",
        category: "sofa",
        sourceType: "external_max",
        artifactId,
        dimensions: [2200, 900, 760],
        pivotPolicy: "floor_center",
        allowNonUniformScale: false,
      },
    ],
  };
}

function registry(
  state: "QUARANTINED" | "INSPECTED" | "VERIFIED" | "REJECTED" = "VERIFIED",
): AssetArtifactRegistry {
  return {
    records: [
      {
        artifact: {
          artifactContractVersion: "0.1.0",
          artifactId,
          format: "3ds_max",
          sha256: artifactSha256,
          byteLength: 1024,
          trustState: state,
          source: { kind: "internal", referenceId: "source_controlled_sofa_fixture_v1" },
        },
        storageKey: "objects/external/controlled-sofa.max",
        inspection: {
          inspectionVersion: "0.1.0",
          artifactId,
          artifactSha256,
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
              systemType: "#Millimeters",
              systemScale: 1,
              displayType: "#Millimeters",
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
        },
      },
    ],
  };
}

function changeSet(): Record<string, unknown> {
  return {
    schemaVersion: "0.1.0",
    changeSetId: "chg_external_sofa_r9",
    projectId: "project_golden_living_001",
    sceneId: "scene_golden_living_001",
    baseRevisionId: "rev_golden_0008",
    targetRevisionId: "rev_external_0009",
    requestedBy: { type: "operator", id: "operator_golden_fixture" },
    source: { type: "manual_edit", referenceIds: ["source_golden_fixture"] },
    intent: "Replace the verified sofa source while preserving its canonical anchor.",
    riskLevel: "medium",
    operations: [
      {
        operationId: "op_replace_external_sofa_r9",
        type: "ReplaceAsset",
        targetId: "asset_living_sofa_main",
        reason: "Controlled external sofa ingestion.",
        riskLevel: "medium",
        parameters: {
          newAssetDefinitionId: "assetdef_sofa_external_controlled_v1",
          placementPolicy: "preserve_anchor",
        },
        preconditions: [],
        provenance: [],
        expectedImpact: { affectedLogicalIds: ["asset_living_sofa_main"] },
      },
    ],
    preconditions: [],
    metadata: { createdAt: "2026-08-20T00:00:00Z" },
  };
}

function base(): { scene: Record<string, unknown>; manifest: Record<string, unknown> } {
  return {
    scene: fixture("revisions/rev_golden_0008/scene-spec.json"),
    manifest: fixture("revisions/rev_golden_0008/expected-scene-manifest.json"),
  };
}

function errorCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof ExternalAssetIngestionError ? error.code : null;
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is required`);
  return value;
}

describe("Technical Spike 7C controlled external ingestion preflight", () => {
  it("requires both trusted config and operator authorization before DCC launch", async () => {
    const { scene, manifest } = base();
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-7c-guard-"));
    try {
      const baseArtifactPath = join(root, "base.max");
      writeFileSync(baseArtifactPath, Buffer.from("verified base bytes"));
      for (const { allowDccExecution, authorizeDccExecution } of [
        { allowDccExecution: false, authorizeDccExecution: true },
        { allowDccExecution: true, authorizeDccExecution: false },
        { allowDccExecution: false, authorizeDccExecution: false },
      ]) {
        const result = await ingestVerifiedExternalMaxAsset({
          config: {
            repositoryRoot: root,
            workspaceRoot: join(root, ".workspace"),
            processTimeoutMs: 5_000,
            threeDsMaxInstallationPath: null,
            allowCompatibilityVersionForSpike: false,
            allowDccExecution,
          },
          jobId: "job_external_guard_0001",
          idempotencyKey: "external.guard.test.0001",
          baseSceneSpec: scene,
          baseManifest: manifest,
          baseArtifactPath,
          changeSet: changeSet(),
          catalog: catalog(),
          registry: registry(),
          trustedAssetRoot: root,
          tolerances: {
            geometryToleranceMm: 0.01,
            transformToleranceMm: 0.01,
            rotationToleranceDeg: 0.001,
          },
          authorizeDccExecution,
        });
        expect(result).toMatchObject({
          status: "BLOCKED",
          error: { code: "DCC_EXECUTION_DISABLED" },
          dcc: null,
          mutationProcess: null,
          verificationProcess: null,
        });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes exactly one immutable verified definition and preserves canonical instance fields", () => {
    const { scene, manifest } = base();
    const result = preflightExternalAssetIngestion({
      baseSceneSpec: scene,
      baseManifest: manifest,
      changeSet: changeSet(),
      catalog: catalog(),
      registry: registry(),
    });
    expect(validateSceneSpec(result.targetSceneSpec)).toMatchObject({ ok: true });
    expect(validateSceneChangeSet(result.changeSet)).toMatchObject({ ok: true });
    expect(result.targetSceneSpec.assetDefinitions).toHaveLength(
      (scene.assetDefinitions as unknown[]).length + 1,
    );
    expect(result.targetSceneSpec.assetDefinitions).toEqual([
      ...(scene.assetDefinitions as unknown[]),
      catalog().definitions[0],
    ]);
    const target = (result.targetSceneSpec.assets as Array<Record<string, unknown>>).find(
      (entry) => entry.id === "asset_living_sofa_main",
    );
    const original = (scene.assets as Array<Record<string, unknown>>).find(
      (entry) => entry.id === "asset_living_sofa_main",
    );
    expect(target).toMatchObject({ assetDefinitionId: "assetdef_sofa_external_controlled_v1" });
    expect(target?.transform).toEqual(original?.transform);
    expect(target?.locks).toEqual(original?.locks);
    expect(result.targetSceneSpec.materialAssignments).toEqual(scene.materialAssignments);
    expect(result.expectedManifest.revisionId).toBe("rev_external_0009");
    const sofa = (result.expectedManifest.nodes as Array<Record<string, unknown>>).find(
      (entry) => entry.logicalId === "asset_living_sofa_main",
    );
    expect(sofa).toMatchObject({
      assetDefinitionId: "assetdef_sofa_external_controlled_v1",
      dimensions: [2200, 900, 760],
      materialId: "material_sofa_proxy",
    });
    expect(result.artifact).toEqual({
      artifactId,
      sha256: artifactSha256,
      byteLength: 1024,
      format: "3ds_max",
    });
    expect(externalIngestionRequestHash(result, `sha256:${"b".repeat(64)}`)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it("keeps ChangeSet portable and rejects definition, trust, evidence, and lock failures pre-DCC", () => {
    const { scene, manifest } = base();
    const directPath = changeSet();
    (
      (directPath.operations as Array<Record<string, unknown>>)[0]?.parameters as Record<
        string,
        unknown
      >
    ).artifactPath = "C:/untrusted/asset.max";
    expect(validateSceneChangeSet(directPath)).toMatchObject({ ok: false });

    const missingDefinition = changeSet();
    (
      (missingDefinition.operations as Array<Record<string, unknown>>)[0]?.parameters as Record<
        string,
        unknown
      >
    ).newAssetDefinitionId = "assetdef_missing";
    expect(
      errorCode(() =>
        preflightExternalAssetIngestion({
          baseSceneSpec: scene,
          baseManifest: manifest,
          changeSet: missingDefinition,
          catalog: catalog(),
          registry: registry(),
        }),
      ),
    ).toBe("ASSET_DEFINITION_NOT_FOUND");

    for (const state of ["QUARANTINED", "INSPECTED", "REJECTED"] as const) {
      expect(
        errorCode(() =>
          preflightExternalAssetIngestion({
            baseSceneSpec: scene,
            baseManifest: manifest,
            changeSet: changeSet(),
            catalog: catalog(),
            registry: registry(state),
          }),
        ),
      ).toBe("ASSET_ARTIFACT_NOT_VERIFIED");
    }
    const evidenceMismatch = registry();
    (evidenceMismatch.records[0]?.inspection as Record<string, unknown>).artifactSha256 =
      `sha256:${"c".repeat(64)}`;
    expect(
      errorCode(() =>
        preflightExternalAssetIngestion({
          baseSceneSpec: scene,
          baseManifest: manifest,
          changeSet: changeSet(),
          catalog: catalog(),
          registry: evidenceMismatch,
        }),
      ),
    ).toBe("ASSET_ARTIFACT_INSPECTION_INVALID");
    const locked = structuredClone(scene);
    (
      (locked.assets as Array<Record<string, unknown>>).find(
        (entry) => entry.id === "asset_living_sofa_main",
      )?.locks as Record<string, unknown>
    ).geometry = true;
    expect(
      errorCode(() =>
        preflightExternalAssetIngestion({
          baseSceneSpec: locked,
          baseManifest: manifest,
          changeSet: changeSet(),
          catalog: catalog(),
          registry: registry(),
        }),
      ),
    ).toBe("GEOMETRY_LOCKED");
  });

  it("enforces pivot/category/scale/space/stale-revision and definition append invariants", () => {
    const { scene, manifest } = base();
    const cases: Array<
      [
        string,
        (
          scene: Record<string, unknown>,
          values: TrustedExternalAssetCatalog,
          set: Record<string, unknown>,
        ) => void,
      ]
    > = [
      [
        "ASSET_CATEGORY_INCOMPATIBLE",
        (_scene, values) => {
          required(values.definitions[0], "definition").category = "generic_proxy";
        },
      ],
      [
        "ASSET_PIVOT_INCOMPATIBLE",
        (_scene, values) => {
          required(values.definitions[0], "definition").pivotPolicy = "back_center_floor";
        },
      ],
      [
        "NON_UNIFORM_SCALE_NOT_ALLOWED",
        (value) => {
          (
            (value.assets as Array<Record<string, unknown>>).find(
              (entry) => entry.id === "asset_living_sofa_main",
            )?.transform as Record<string, unknown>
          ).scale = [1, 2, 1];
        },
      ],
      [
        "OBJECT_OUTSIDE_SPACE",
        (value) => {
          (
            (value.assets as Array<Record<string, unknown>>).find(
              (entry) => entry.id === "asset_living_sofa_main",
            )?.transform as Record<string, unknown>
          ).position = [5900, 3350, 0];
        },
      ],
      [
        "STALE_REVISION",
        (_scene, _values, set) => {
          set.baseRevisionId = "rev_golden_0007";
        },
      ],
    ];
    for (const [expected, mutate] of cases) {
      const candidateScene = structuredClone(scene);
      const candidateCatalog = catalog();
      const candidateSet = changeSet();
      mutate(candidateScene, candidateCatalog, candidateSet);
      expect(
        errorCode(() =>
          preflightExternalAssetIngestion({
            baseSceneSpec: candidateScene,
            baseManifest: manifest,
            changeSet: candidateSet,
            catalog: candidateCatalog,
            registry: registry(),
          }),
        ),
      ).toBe(expected);
    }
    const good = preflightExternalAssetIngestion({
      baseSceneSpec: scene,
      baseManifest: manifest,
      changeSet: changeSet(),
      catalog: catalog(),
      registry: registry(),
    });
    const rebound = structuredClone(good.targetSceneSpec);
    required(rebound.assetDefinitions as Array<Record<string, unknown>>, "definitions")[0] = {
      ...required(
        (rebound.assetDefinitions as Array<Record<string, unknown>>)[0],
        "first definition",
      ),
      version: "mutated",
    };
    const trustedDefinition = required(catalog().definitions[0], "trusted definition");
    expect(() => assertExternalDefinitionAppend(scene, rebound, trustedDefinition)).toThrow(
      ExternalAssetIngestionError,
    );
    expect(errorCode(() => assertExternalDefinitionAppend(scene, rebound, trustedDefinition))).toBe(
      "ASSET_DEFINITION_COLLECTION_INVALID",
    );
  });

  it("rehashes the worker-only staged copy and expresses only the source transition semantically", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-7c-unit-"));
    try {
      const source = join(root, "source.max");
      const staged = join(root, "replacement.max");
      writeFileSync(source, Buffer.from("trusted synthetic bytes"));
      const hash = `sha256:${createHash("sha256").update(readFileSync(source)).digest("hex")}`;
      expect(
        stageExactVerifiedArtifact({
          sourcePath: source,
          destinationPath: staged,
          artifact: { sha256: hash, byteLength: readFileSync(source).length },
        }),
      ).toEqual({ sha256: hash, byteLength: readFileSync(source).length });
      writeFileSync(source, Buffer.from("tampered synthetic bytes"));
      expect(
        errorCode(() =>
          stageExactVerifiedArtifact({
            sourcePath: source,
            destinationPath: staged,
            artifact: { sha256: hash, byteLength: readFileSync(staged).length },
          }),
        ),
      ).toBe("ASSET_ARTIFACT_HASH_MISMATCH");

      const { manifest } = base();
      const target = structuredClone(manifest);
      target.revisionId = "rev_external_0009";
      const sofa = required(
        (target.nodes as Array<Record<string, unknown>>).find(
          (entry) => entry.logicalId === "asset_living_sofa_main",
        ),
        "sofa manifest node",
      );
      sofa.assetDefinitionId = "assetdef_sofa_external_controlled_v1";
      const diff = diffExternalSemanticManifests(manifest, target);
      expect(diff.changed).toEqual([
        {
          logicalId: "asset_living_sofa_main",
          changes: {
            assetDefinitionId: {
              before: "assetdef_sofa_proxy_alternate_v1",
              after: "assetdef_sofa_external_controlled_v1",
            },
          },
        },
      ]);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
      expect(diff.unchanged).toHaveLength(13);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
