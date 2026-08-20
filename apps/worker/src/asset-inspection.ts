import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AssetInspectionEvidence,
  type AssetInspectionJob,
  validateAssetInspection,
  validateAssetInspectionJob,
} from "@ai-archviz/worker-contracts";
import { type AssetArtifactRegistry, resolveArtifactForInspection } from "./asset-trust.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";

const targetDccMajorVersion = 2026;

export interface AssetInspectionConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  processTimeoutMs: number;
  threeDsMaxInstallationPath: string | null;
  allowCompatibilityVersionForSpike: boolean;
}

export interface ExternalAssetInspectionResult {
  status: "PASS" | "FAILED" | "BLOCKED";
  failureCode: string | null;
  evidence: AssetInspectionEvidence | null;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  process: ControlledProcessResult | null;
}

function failure(
  status: ExternalAssetInspectionResult["status"],
  failureCode: string,
  partial: Partial<ExternalAssetInspectionResult> = {},
): ExternalAssetInspectionResult {
  return {
    status,
    failureCode,
    evidence: partial.evidence ?? null,
    dcc: partial.dcc ?? null,
    compatibilityMode: partial.compatibilityMode ?? false,
    process: partial.process ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasZeroDependencies(evidence: AssetInspectionEvidence): boolean {
  const observations = evidence.observations;
  if (!isRecord(observations) || !isRecord(observations.dependencies)) return false;
  const dependencies = observations.dependencies;
  return ["missingExternalFiles", "missingDLLs", "xrefs", "externalReferenceCount"].every(
    (key) => dependencies[key] === 0,
  );
}

function hasObservedSafeScenePosture(evidence: AssetInspectionEvidence): boolean {
  const observations = evidence.observations;
  if (!isRecord(observations) || !isRecord(observations.security)) return false;
  const security = observations.security;
  return (
    security.safeSceneScriptExecutionEnabled === true &&
    security.settingsLocked === true &&
    security.lockCause === "cmdline" &&
    security.scriptAssetsProtected === true
  );
}

function evidenceFailureCode(evidence: AssetInspectionEvidence): string {
  return typeof evidence.failureCode === "string"
    ? evidence.failureCode
    : "ASSET_INSPECTION_FAILED";
}

function evidenceMatchesDcc(
  evidence: AssetInspectionEvidence,
  dcc: ThreeDsMaxDiscoveryResult,
  compatibilityMode: boolean,
): boolean {
  if (!isRecord(evidence.dcc)) return false;
  return (
    evidence.dcc.product === "3ds_max" &&
    evidence.dcc.testedMajorVersion === Number(dcc.version) &&
    evidence.dcc.compatibilityMode === compatibilityMode
  );
}

function batchArguments(scriptPath: string): string[] {
  // 3dsmaxbatch.exe supports Python scripts directly. These flags retain
  // Autodesk Dialog Monitor and force Safe Scene Script Execution on.
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}

function readInspectionEvidence(path: string): AssetInspectionEvidence | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.evidence)) return null;
  const validation = validateAssetInspection(parsed.evidence);
  return validation.ok ? validation.value : null;
}

/**
 * Opens only a previously quarantined artifact in a fresh, worker-owned 3ds
 * Max Batch process. This does not mutate or promote registry state; callers
 * must validate and persist promotion separately with worker-owned logic.
 */
export async function inspectExternalMaxArtifact({
  config,
  registry,
  job,
  trustedAssetRoot,
  authorizeDccExecution,
}: {
  config: AssetInspectionConfig;
  registry: AssetArtifactRegistry;
  job: AssetInspectionJob;
  trustedAssetRoot: string;
  /** Trusted operator/service boundary; not present in the job contract. */
  authorizeDccExecution: boolean;
}): Promise<ExternalAssetInspectionResult> {
  const jobValidation = validateAssetInspectionJob(job);
  if (!jobValidation.ok) return failure("BLOCKED", "ASSET_INSPECTION_JOB_INVALID");
  if (!authorizeDccExecution) return failure("BLOCKED", "DCC_EXECUTION_DISABLED");

  const normalizedJob = jobValidation.value as {
    artifactId: string;
    artifactSha256: string;
    format: "3ds_max";
  };
  let resolved: Awaited<ReturnType<typeof resolveArtifactForInspection>>;
  try {
    resolved = await resolveArtifactForInspection({
      artifactId: normalizedJob.artifactId,
      trustedAssetRoot,
      registry,
    });
  } catch (error) {
    return failure(
      "BLOCKED",
      isRecord(error) && typeof error.code === "string"
        ? error.code
        : "ASSET_INSPECTION_RESOLUTION_FAILED",
    );
  }
  if (
    resolved.sha256 !== normalizedJob.artifactSha256 ||
    normalizedJob.format !== resolved.format
  ) {
    return failure("BLOCKED", "ASSET_ARTIFACT_HASH_MISMATCH");
  }

  const dcc = await discoverThreeDsMax({
    installationOverride: config.threeDsMaxInstallationPath,
  });
  if (dcc.status === "NOT_FOUND") return failure("BLOCKED", "DCC_NOT_FOUND", { dcc });
  if (!dcc.batchExecutablePath) return failure("BLOCKED", "DCC_BATCH_NOT_FOUND", { dcc });
  const compatibilityMode = dcc.version !== String(targetDccMajorVersion);
  if (compatibilityMode && !config.allowCompatibilityVersionForSpike) {
    return failure("BLOCKED", "DCC_VERSION_UNSUPPORTED", { dcc });
  }

  mkdirSync(config.workspaceRoot, { recursive: true });
  const inspectionWorkspace = mkdtempSync(join(resolve(config.workspaceRoot), "asset-inspection-"));
  const resultPath = join(inspectionWorkspace, "inspection-result.json");
  let inspectionProcess: ControlledProcessResult | null = null;
  try {
    inspectionProcess = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(resolve(config.repositoryRoot, "tools/3ds-max/python/inspect_asset.py")),
      cwd: dcc.installationPath ?? resolve(config.repositoryRoot),
      timeoutMs: config.processTimeoutMs,
      env: {
        ...process.env,
        AI_ARCHVIZ_INSPECTION_ARTIFACT_ID: resolved.artifactId,
        AI_ARCHVIZ_INSPECTION_ARTIFACT_SHA256: resolved.sha256,
        AI_ARCHVIZ_INSPECTION_ASSET_PATH: resolved.internalPath,
        AI_ARCHVIZ_INSPECTION_RESULT_PATH: resultPath,
      },
      outputEncoding: "utf16le",
    });
    const evidence = readInspectionEvidence(resultPath);
    if (!evidence) {
      return failure("FAILED", inspectionProcess.errorCode ?? "ASSET_INSPECTION_REPORT_INVALID", {
        dcc,
        compatibilityMode,
        process: inspectionProcess,
      });
    }
    if (
      evidence.artifactId !== resolved.artifactId ||
      evidence.artifactSha256 !== resolved.sha256 ||
      !evidenceMatchesDcc(evidence, dcc, compatibilityMode)
    ) {
      return failure("FAILED", "ASSET_INSPECTION_EVIDENCE_IDENTITY_MISMATCH", {
        evidence,
        dcc,
        compatibilityMode,
        process: inspectionProcess,
      });
    }
    if (evidence.result !== "pass") {
      return failure("FAILED", evidenceFailureCode(evidence), {
        evidence,
        dcc,
        compatibilityMode,
        process: inspectionProcess,
      });
    }
    if (!hasObservedSafeScenePosture(evidence)) {
      return failure("FAILED", "ASSET_INSPECTION_SECURITY_POSTURE_UNKNOWN", {
        evidence,
        dcc,
        compatibilityMode,
        process: inspectionProcess,
      });
    }
    if (
      !hasZeroDependencies(evidence) ||
      !Array.isArray(evidence.findings) ||
      evidence.findings.length !== 0
    ) {
      return failure("FAILED", "ASSET_EXTERNAL_DEPENDENCY_DETECTED", {
        evidence,
        dcc,
        compatibilityMode,
        process: inspectionProcess,
      });
    }
    if (inspectionProcess.errorCode !== null) {
      return failure("FAILED", inspectionProcess.errorCode, {
        evidence,
        dcc,
        compatibilityMode,
        process: inspectionProcess,
      });
    }
    return {
      status: "PASS",
      failureCode: null,
      evidence,
      dcc,
      compatibilityMode,
      process: inspectionProcess,
    };
  } finally {
    rmSync(inspectionWorkspace, { recursive: true, force: true });
  }
}
