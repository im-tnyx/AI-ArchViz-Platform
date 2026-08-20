import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetArtifact, AssetInspectionEvidence } from "@ai-archviz/worker-contracts";
import { inspectExternalMaxArtifact } from "./asset-inspection.js";
import { type AssetArtifactRegistry, promoteArtifactAfterInspection } from "./asset-trust.js";
import type { WorkerConfig } from "./config.js";
import { discoverThreeDsMax } from "./discovery.js";
import {
  type ExternalAssetIngestionInput,
  ingestVerifiedExternalMaxAsset,
  type TrustedExternalAssetCatalog,
} from "./external-asset-ingestion.js";
import { buildGoldenScene } from "./golden-build.js";
import { runControlledProcess } from "./process.js";
import { applySceneChangeSet } from "./revision.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolve(repositoryRoot, ".workspace/external-asset-ingestion-7c");
const trustedAssetRoot = join(runRoot, "trusted-assets");
const fixtureRoot = join(runRoot, "fixture");
const productionWorkspaceRoot = join(runRoot, "production");
const inspectionWorkspaceRoot = join(runRoot, "inspection");
const sourceAssetPath = join(fixtureRoot, "source_asset.max");
const fixtureResultPath = join(fixtureRoot, "fixture-result.json");
const trustedAssetPath = join(trustedAssetRoot, "objects", "external", "controlled-sofa.max");
const artifactId = "artifact_controlled_sofa_external_v1";

function requireDccTestApproval(): void {
  if (process.env.AI_ARCHVIZ_ALLOW_DCC_TESTS !== "1") {
    throw new Error(
      "AI_ARCHVIZ_ALLOW_DCC_TESTS=1 is required before running a DCC integration suite",
    );
  }
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function batchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
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
    intent: "Controlled replacement with a previously VERIFIED external sofa artifact.",
    riskLevel: "medium",
    operations: [
      {
        operationId: "op_replace_external_sofa_r9",
        type: "ReplaceAsset",
        targetId: "asset_living_sofa_main",
        reason: "Controlled verified external source ingestion.",
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

function artifact(sha256: string, byteLength: number): AssetArtifact {
  return {
    artifactContractVersion: "0.1.0",
    artifactId,
    format: "3ds_max",
    sha256,
    byteLength,
    trustState: "QUARANTINED",
    source: { kind: "internal", referenceId: "source_controlled_sofa_fixture_v1" },
  };
}

function registryFor(
  artifactRecord: AssetArtifact,
  inspection?: AssetInspectionEvidence,
): AssetArtifactRegistry {
  return {
    records: [
      {
        artifact: artifactRecord,
        storageKey: "objects/external/controlled-sofa.max",
        ...(inspection ? { inspection } : {}),
      },
    ],
  };
}

function integrationConfig(): WorkerConfig {
  // The cast maintains compatibility with the clean 7B baseline while the
  // pre-existing local default-deny DCC safety worktree is also present.
  return Object.assign(
    {
      repositoryRoot,
      workspaceRoot: productionWorkspaceRoot,
      processTimeoutMs: 180_000,
      threeDsMaxInstallationPath: null,
      allowCompatibilityVersionForSpike: true,
      trustedAssetRoot: null,
    },
    { allowDccExecution: true },
  ) as WorkerConfig;
}

async function produceVerifiedRev8(config: WorkerConfig): Promise<{
  scene: Record<string, unknown>;
  manifest: Record<string, unknown>;
  artifactPath: string;
}> {
  const baseJobPath = "tests/fixtures/living-room-golden/job-envelope.json";
  const build = await buildGoldenScene(config, baseJobPath);
  assert.equal(build.status, "SUCCESS", build.error?.message);
  const paths = [
    "changesets/move-coffee-table-r2.json",
    "changesets/update-window-sill-r3.json",
    "changesets/assign-wall-south-material-r4.json",
    "changesets/lock-coffee-table-transform-r5.json",
    "changesets/unlock-coffee-table-transform-r6.json",
    "changesets/move-coffee-table-after-unlock-r7.json",
    "changesets/replace-sofa-r8.json",
  ];
  let finalResult: Awaited<ReturnType<typeof applySceneChangeSet>> | null = null;
  for (const path of paths) {
    finalResult = await applySceneChangeSet(
      config,
      baseJobPath,
      `tests/fixtures/living-room-golden/${path}`,
    );
    assert.equal(finalResult.status, "SUCCESS", finalResult.error?.message);
  }
  assert.ok(finalResult?.verifiedOutputPath, "verified rev8 output is required");
  assert.ok(finalResult.workspace, "rev8 workspace is required");
  return {
    scene: readJson(join(finalResult.workspace, "input", "target-scene-spec.json")),
    manifest: readJson(join(finalResult.workspace, "verification", "scene-manifest.json")),
    artifactPath: finalResult.verifiedOutputPath,
  };
}

async function createVerifiedArtifact(): Promise<{
  registry: AssetArtifactRegistry;
  sourceHash: string;
  sourceSize: number;
  fixtureProcessId: number;
  inspectionProcessId: number;
}> {
  const dcc = await discoverThreeDsMax();
  assert.notEqual(dcc.status, "NOT_FOUND", "3ds Max Batch must be installed");
  assert.ok(dcc.batchExecutablePath, "3dsmaxbatch.exe is required");
  const fixtureProcess = await runControlledProcess({
    executable: dcc.batchExecutablePath,
    args: batchArguments(
      resolve(repositoryRoot, "tools/3ds-max/python/create_inspection_fixture.py"),
    ),
    cwd: dcc.installationPath ?? repositoryRoot,
    timeoutMs: 180_000,
    env: {
      ...process.env,
      AI_ARCHVIZ_INSPECTION_FIXTURE_PATH: sourceAssetPath,
      AI_ARCHVIZ_INSPECTION_FIXTURE_RESULT_PATH: fixtureResultPath,
    },
    outputEncoding: "utf16le",
  });
  assert.equal(fixtureProcess.errorCode, null, fixtureProcess.stderr);
  assert.ok(fixtureProcess.processId && fixtureProcess.processId > 0, "fixture PID is required");
  assert.deepEqual(readJson(fixtureResultPath).dimensionsMm, [2200, 900, 760]);
  copyFileSync(sourceAssetPath, trustedAssetPath);
  const sourceHash = sha256File(sourceAssetPath);
  const sourceSize = statSync(sourceAssetPath).size;
  const quarantined = artifact(sourceHash, sourceSize);
  const inspection = await inspectExternalMaxArtifact({
    config: {
      repositoryRoot,
      workspaceRoot: inspectionWorkspaceRoot,
      processTimeoutMs: 180_000,
      threeDsMaxInstallationPath: null,
      allowCompatibilityVersionForSpike: true,
    },
    registry: registryFor(quarantined),
    job: {
      inspectionJobVersion: "0.1.0",
      artifactId,
      artifactSha256: sourceHash,
      format: "3ds_max",
    },
    trustedAssetRoot,
    authorizeDccExecution: true,
  });
  assert.equal(inspection.status, "PASS", inspection.failureCode ?? "inspection failed");
  assert.ok(inspection.evidence, "inspection evidence is required");
  assert.ok(inspection.process?.processId, "inspection PID is required");
  assert.notEqual(
    inspection.process?.processId,
    fixtureProcess.processId,
    "fixture and inspector differ",
  );
  const verified = promoteArtifactAfterInspection({
    artifact: quarantined,
    evidence: inspection.evidence,
  });
  return {
    registry: registryFor(verified, inspection.evidence),
    sourceHash,
    sourceSize,
    fixtureProcessId: fixtureProcess.processId,
    inspectionProcessId: inspection.process.processId as number,
  };
}

function ingestionInput(
  base: Awaited<ReturnType<typeof produceVerifiedRev8>>,
  verified: Awaited<ReturnType<typeof createVerifiedArtifact>>,
  jobId: string,
  idempotencyKey: string,
  executionEnvironment?: NodeJS.ProcessEnv,
): ExternalAssetIngestionInput {
  return {
    config: integrationConfig(),
    jobId,
    idempotencyKey,
    baseSceneSpec: base.scene,
    baseManifest: base.manifest,
    baseArtifactPath: base.artifactPath,
    changeSet: changeSet(),
    catalog: catalog(),
    registry: verified.registry,
    trustedAssetRoot,
    tolerances: {
      geometryToleranceMm: 0.01,
      transformToleranceMm: 0.01,
      rotationToleranceDeg: 0.001,
    },
    authorizeDccExecution: true,
    ...(executionEnvironment ? { executionEnvironment } : {}),
  };
}

async function assertFailedDccMutation(
  base: Awaited<ReturnType<typeof produceVerifiedRev8>>,
  verified: Awaited<ReturnType<typeof createVerifiedArtifact>>,
  suffix: string,
  environment: NodeJS.ProcessEnv,
  expectedCode: string,
): Promise<void> {
  const hashBefore = sha256File(base.artifactPath);
  const input = ingestionInput(
    base,
    verified,
    `job_external_failure_${suffix}`,
    `external.failure.${suffix}`,
    environment,
  );
  if (suffix === "timeout") {
    input.config = { ...input.config, processTimeoutMs: 1_000 };
  }
  const result = await ingestVerifiedExternalMaxAsset(input);
  assert.equal(result.status, "FAILED");
  assert.equal(result.error?.code, expectedCode);
  assert.equal(result.verifiedOutputPath, null);
  assert.equal(
    sha256File(base.artifactPath),
    hashBefore,
    "rev8 must remain canonical after failure",
  );
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(dirname(trustedAssetPath), { recursive: true });
  mkdirSync(fixtureRoot, { recursive: true });
  try {
    const config = integrationConfig();
    const base = await produceVerifiedRev8(config);
    const verified = await createVerifiedArtifact();
    const baseHash = sha256File(base.artifactPath);
    const first = await ingestVerifiedExternalMaxAsset(
      ingestionInput(base, verified, "job_external_sofa_r9", "external.chg_external_sofa_r9"),
    );
    assert.equal(
      first.status,
      "SUCCESS",
      JSON.stringify(
        {
          error: first.error,
          mutation: first.mutationProcess,
          verification: first.verificationProcess,
        },
        null,
        2,
      ),
    );
    assert.equal(first.replayed, false);
    assert.equal(first.baseArtifactHash, baseHash);
    assert.equal(first.sourceArtifactHash, verified.sourceHash);
    assert.equal(first.stagedArtifactHash, verified.sourceHash);
    assert.ok(
      first.verifiedOutputPath && existsSync(first.verifiedOutputPath),
      "rev9 output is required",
    );
    assert.ok(first.mutationProcess?.processId, "mutation PID is required");
    assert.ok(first.verificationProcess?.processId, "verifier PID is required");
    assert.notEqual(
      first.mutationProcess?.processId,
      first.verificationProcess?.processId,
      "fresh verifier PID required",
    );
    assert.notEqual(
      first.mutationProcess?.processId,
      verified.inspectionProcessId,
      "merge and inspector differ",
    );
    assert.equal(sha256File(base.artifactPath), baseHash, "rev8 must be byte-preserved");
    assert.equal(
      sha256File(sourceAssetPath),
      verified.sourceHash,
      "source fixture must be byte-preserved",
    );
    assert.equal(
      sha256File(trustedAssetPath),
      verified.sourceHash,
      "trusted source must be byte-preserved",
    );
    assert.deepEqual(first.semanticDiff?.changed, [
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
    assert.equal(first.semanticDiff?.unchanged.length, 13);
    assert.deepEqual(first.semanticDiff?.added, []);
    assert.deepEqual(first.semanticDiff?.removed, []);
    const targetScene = readJson(
      join(first.workspace as string, "input", "target-scene-spec.json"),
    );
    assert.equal(
      (targetScene.assetDefinitions as unknown[]).length,
      (base.scene.assetDefinitions as unknown[]).length + 1,
    );
    assert.equal(
      JSON.stringify(targetScene).includes(trustedAssetRoot),
      false,
      "SceneSpec must not contain root path",
    );
    assert.equal(
      JSON.stringify(first.comparison).includes(trustedAssetRoot),
      false,
      "semantic evidence must not contain root path",
    );

    const replay = await ingestVerifiedExternalMaxAsset(
      ingestionInput(
        base,
        verified,
        "job_external_sofa_r9_replay",
        "external.chg_external_sofa_r9",
      ),
    );
    assert.equal(replay.status, "SUCCESS");
    assert.equal(replay.replayed, true);
    assert.equal(replay.mutationProcess, null);
    assert.equal(replay.verificationProcess, null);
    assert.equal(replay.verifiedOutputPath, first.verifiedOutputPath);

    const originalBytes = readFileSync(trustedAssetPath);
    const tampered = Buffer.from(originalBytes);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    writeFileSync(trustedAssetPath, tampered);
    const tamperResult = await ingestVerifiedExternalMaxAsset(
      ingestionInput(base, verified, "job_external_tamper", "external.preflight.tamper"),
    );
    assert.equal(tamperResult.status, "BLOCKED");
    assert.equal(tamperResult.error?.code, "ASSET_ARTIFACT_HASH_MISMATCH");
    assert.equal(tamperResult.mutationProcess, null);
    assert.equal(tamperResult.verificationProcess, null);
    writeFileSync(trustedAssetPath, originalBytes);

    await assertFailedDccMutation(
      base,
      verified,
      "merge_false",
      { AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MERGE_FALSE: "1" },
      "ASSET_MERGE_FAILED",
    );
    await assertFailedDccMutation(
      base,
      verified,
      "shape_count",
      { AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MERGED_NODE_COUNT: "1" },
      "ASSET_MERGE_SHAPE_UNSUPPORTED",
    );
    await assertFailedDccMutation(
      base,
      verified,
      "shape_type",
      { AI_ARCHVIZ_TEST_FORCE_EXTERNAL_NON_GEOMETRY: "1" },
      "ASSET_MERGE_SHAPE_UNSUPPORTED",
    );
    await assertFailedDccMutation(
      base,
      verified,
      "dependency",
      { AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MERGE_DEPENDENCY: "1" },
      "ASSET_MERGE_EXTERNAL_DEPENDENCY",
    );
    await assertFailedDccMutation(
      base,
      verified,
      "safe_scene",
      { AI_ARCHVIZ_TEST_FORCE_EXTERNAL_SAFE_SCENE_FAILURE: "1" },
      "SAFE_SCENE_REQUIRED",
    );
    await assertFailedDccMutation(
      base,
      verified,
      "verification",
      { AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH: "1" },
      "MANIFEST_MISMATCH",
    );
    await assertFailedDccMutation(
      base,
      verified,
      "timeout",
      { AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MUTATION_TIMEOUT: "1" },
      "PROCESS_TIMEOUT",
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 7C controlled verified external max ingestion",
          status: "PASS",
          targetDccVersion: "2026",
          testedDccVersion: first.dcc?.version,
          compatibilityMode: first.compatibilityMode,
          artifact: { sha256: verified.sourceHash, byteLength: verified.sourceSize },
          processIds: {
            fixture: verified.fixtureProcessId,
            inspection: verified.inspectionProcessId,
            mutation: first.mutationProcess?.processId,
            freshVerifier: first.verificationProcess?.processId,
          },
          preservation: { rev8: "PASS", verifiedExternalSource: "PASS" },
          replay: "same idempotency key and request hash launched no second mutation or verifier",
          failureSafety:
            "merge, shape, dependency, Safe Scene, verification, and timeout failures did not promote",
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
