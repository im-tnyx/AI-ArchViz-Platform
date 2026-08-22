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
import {
  type AssetArtifact,
  type AssetInspectionEvidence,
  validateAssetInspection,
  validateAssetInspectionJob,
} from "@ai-archviz/worker-contracts";
import { inspectExternalMaxArtifact } from "./asset-inspection.js";
import {
  type AssetArtifactRegistry,
  promoteArtifactAfterInspection,
  resolveArtifactForInspection,
  resolveVerifiedAssetArtifact,
} from "./asset-trust.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { discoverThreeDsMax } from "./discovery.js";
import { runControlledProcess } from "./process.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolve(repositoryRoot, ".workspace/asset-inspection-7b");
const fixtureRoot = join(runRoot, "fixture-build");
const trustedAssetRoot = join(runRoot, "trusted-quarantine");
const inspectionWorkspaceRoot = join(runRoot, "inspection-workspaces");
const sourceAssetPath = join(fixtureRoot, "source_asset.max");
const fixtureResultPath = join(fixtureRoot, "fixture-result.json");
const quarantineStorageKey = "objects/inspection/controlled-sofa.max";
const quarantinedAssetPath = join(trustedAssetRoot, "objects", "inspection", "controlled-sofa.max");
const artifactId = "artifact_controlled_sofa_inspection_v1";

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayOfNumbers(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number")) {
    throw new Error(`${label} must be a numeric array`);
  }
  return value as number[];
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`,
  );
}

function inspectionJob(sha256: string): Record<string, unknown> {
  return {
    inspectionJobVersion: "0.1.0",
    artifactId,
    artifactSha256: sha256,
    format: "3ds_max",
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
        storageKey: quarantineStorageKey,
        ...(inspection ? { inspection } : {}),
      },
    ],
  };
}

function batchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(dirname(quarantinedAssetPath), { recursive: true });
  try {
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
    assert.ok(existsSync(sourceAssetPath), "controlled source_asset.max must exist");
    const fixtureResult = readJson(fixtureResultPath);
    assert.equal(fixtureResult.status, "SUCCESS");
    assert.deepEqual(fixtureResult.dimensionsMm, [2200, 900, 760]);
    assert.deepEqual(fixtureResult.expectedPivotPositionMm, [1100, 450, 0]);

    copyFileSync(sourceAssetPath, quarantinedAssetPath);
    const sourceSha256 = sha256File(sourceAssetPath);
    const sourceSize = statSync(sourceAssetPath).size;
    assert.equal(sha256File(quarantinedAssetPath), sourceSha256);
    assert.equal(statSync(quarantinedAssetPath).size, sourceSize);
    const quarantinedArtifact = artifact(sourceSha256, sourceSize);
    const registry = registryFor(quarantinedArtifact);
    const job = inspectionJob(sourceSha256);
    assert.equal(validateAssetInspectionJob(job).ok, true);
    await assert.doesNotReject(() =>
      resolveArtifactForInspection({ artifactId, trustedAssetRoot, registry }),
    );

    const inspection = await inspectExternalMaxArtifact({
      config: {
        repositoryRoot,
        workspaceRoot: inspectionWorkspaceRoot,
        processTimeoutMs: 180_000,
        threeDsMaxInstallationPath: null,
        allowCompatibilityVersionForSpike: true,
        allowDccExecution: true,
      },
      registry,
      job,
      trustedAssetRoot,
      authorizeDccExecution: true,
    });
    assert.equal(inspection.status, "PASS", inspection.failureCode ?? "inspection failed");
    assert.ok(inspection.evidence, "inspection evidence is required");
    assert.ok(
      inspection.process?.processId && inspection.process.processId > 0,
      "inspector PID is required",
    );
    assert.notEqual(
      inspection.process?.processId,
      fixtureProcess.processId,
      "fixture and inspector must be distinct processes",
    );
    assert.equal(validateAssetInspection(inspection.evidence).ok, true);
    const observations = record(inspection.evidence.observations, "inspection observations");
    const scene = record(observations.scene, "scene observations");
    const geometry = record(observations.geometry, "geometry observations");
    const dependencies = record(observations.dependencies, "dependency observations");
    const security = record(observations.security, "security observations");
    assert.equal(scene.nodeCount, 1);
    assert.equal(scene.geometryNodeCount, 1);
    assert.equal(scene.cameraCount, 0);
    assert.equal(scene.lightCount, 0);
    const dimensions = arrayOfNumbers(geometry.dimensionsMm, "dimensionsMm");
    [2200, 900, 760].forEach((expected, index) => {
      assertClose(dimensions[index] ?? Number.NaN, expected, 0.01, `dimension ${String(index)}`);
    });
    assert.equal(geometry.floorCenterAnchorCompatible, true);
    assert.deepEqual(dependencies, {
      missingExternalFiles: 0,
      missingDLLs: 0,
      xrefs: 0,
      externalReferenceCount: 0,
    });
    assert.deepEqual(security, {
      safeSceneScriptExecutionEnabled: true,
      settingsLocked: true,
      lockCause: "cmdline",
      scriptAssetsProtected: true,
    });

    const timedOutEnvironment = process.env.AI_ARCHVIZ_TEST_FORCE_INSPECTION_TIMEOUT;
    process.env.AI_ARCHVIZ_TEST_FORCE_INSPECTION_TIMEOUT = "1";
    try {
      const timeoutResult = await inspectExternalMaxArtifact({
        config: {
          repositoryRoot,
          workspaceRoot: inspectionWorkspaceRoot,
          processTimeoutMs: 1_000,
          threeDsMaxInstallationPath: null,
          allowCompatibilityVersionForSpike: true,
          allowDccExecution: true,
        },
        registry,
        job,
        trustedAssetRoot,
        authorizeDccExecution: true,
      });
      assert.equal(timeoutResult.status, "FAILED");
      assert.equal(timeoutResult.failureCode, "PROCESS_TIMEOUT");
      assert.equal(timeoutResult.evidence, null);
    } finally {
      if (timedOutEnvironment === undefined)
        delete process.env.AI_ARCHVIZ_TEST_FORCE_INSPECTION_TIMEOUT;
      else process.env.AI_ARCHVIZ_TEST_FORCE_INSPECTION_TIMEOUT = timedOutEnvironment;
    }

    const promotedArtifact = promoteArtifactAfterInspection({
      artifact: quarantinedArtifact,
      evidence: inspection.evidence,
    });
    const promotedRegistry = registryFor(promotedArtifact, inspection.evidence);
    const productionResolved = await resolveVerifiedAssetArtifact({
      artifactId,
      trustedAssetRoot,
      registry: promotedRegistry,
    });
    assert.equal(productionResolved.internalPath, quarantinedAssetPath);

    const tampered = readFileSync(quarantinedAssetPath);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    writeFileSync(quarantinedAssetPath, tampered);
    await assert.rejects(
      () =>
        resolveVerifiedAssetArtifact({
          artifactId,
          trustedAssetRoot,
          registry: promotedRegistry,
        }),
      { code: "ASSET_ARTIFACT_HASH_MISMATCH" },
    );

    const fakePath = join(trustedAssetRoot, "objects", "inspection", "invalid.max");
    writeFileSync(fakePath, Buffer.from("not a 3ds Max scene", "utf8"));
    const fakeSha256 = sha256File(fakePath);
    const fakeArtifact = {
      ...artifact(fakeSha256, statSync(fakePath).size),
      artifactId: "artifact_invalid_max_fixture_v1",
    };
    const fakeRegistry: AssetArtifactRegistry = {
      records: [{ artifact: fakeArtifact, storageKey: "objects/inspection/invalid.max" }],
    };
    const fakeInspection = await inspectExternalMaxArtifact({
      config: {
        repositoryRoot,
        workspaceRoot: inspectionWorkspaceRoot,
        processTimeoutMs: 180_000,
        threeDsMaxInstallationPath: null,
        allowCompatibilityVersionForSpike: true,
        allowDccExecution: true,
      },
      registry: fakeRegistry,
      job: {
        ...inspectionJob(fakeSha256),
        artifactId: fakeArtifact.artifactId,
      },
      trustedAssetRoot,
      authorizeDccExecution: true,
    });
    assert.equal(fakeInspection.status, "FAILED");
    assert.equal(fakeInspection.failureCode, "ASSET_INSPECTION_LOAD_FAILED");

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 7B isolated external max inspection",
          status: "PASS",
          targetDccVersion: "2026",
          testedDccVersion: inspection.dcc?.version,
          compatibilityMode: inspection.compatibilityMode,
          artifact: { sha256: sourceSha256, byteLength: sourceSize },
          processIds: {
            fixtureGeneration: fixtureProcess.processId,
            isolatedInspection: inspection.process?.processId,
          },
          observations: inspection.evidence.observations,
          security: "Safe Scene enabled and command-line locked; no mutation or production merge",
          timeout: "owned inspector process timeout blocked promotion",
          tamper: "same-length byte mutation rejected by exact SHA-256 verification",
          invalidMax: "non-Max bytes rejected by isolated loadMaxFile inspection",
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
