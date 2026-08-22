import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type GoldenCoronaPreviewEvidence,
  semanticJsonHash,
  validateGoldenCoronaPreviewEvidence,
  validateGoldenCoronaPreviewPlan,
  validateSceneManifest,
} from "@ai-archviz/worker-contracts";
import {
  CoronaAdapterCompileError,
  CoronaRendererAdapter,
  type GoldenCoronaPreviewPlan,
  goldenLivingCoronaPreviewProfile,
} from "./corona-renderer-adapter.js";
import { isDccExecutionAuthorized } from "./dcc-execution-guard.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";
import { writeDeterministicJson } from "./workspace.js";

export interface GoldenCoronaPreviewExecutionConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  processTimeoutMs: number;
  threeDsMaxInstallationPath: string | null;
  allowCompatibilityVersionForSpike: boolean;
  allowDccExecution: boolean;
}

export interface GoldenCoronaPreviewExecutionResult {
  status: "PASS" | "FAILED" | "BLOCKED";
  error: { code: string; message: string } | null;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  process: ControlledProcessResult | null;
  plan: GoldenCoronaPreviewPlan | null;
  evidence: GoldenCoronaPreviewEvidence | null;
  requestHash: string | null;
}

interface ScriptResult {
  status: "PASS" | "FAILED";
  failureCode?: string;
  message?: string;
  renderer?: Record<string, unknown>;
  dcc?: Record<string, unknown>;
  canonical?: Record<string, unknown>;
  temporaryExecution?: Record<string, unknown>;
  render?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanField(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function rawFileHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function isExpectedPng(path: string): boolean {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size <= 0) return false;
  const bytes = readFileSync(path);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return (
    bytes.length >= 24 &&
    signature.every((value, index) => bytes[index] === value) &&
    bytes.readUInt32BE(16) === 320 &&
    bytes.readUInt32BE(20) === 240
  );
}

function parseScriptResult(value: unknown): ScriptResult | null {
  const record = asRecord(value);
  if (!record || (record.status !== "PASS" && record.status !== "FAILED")) return null;
  const result: ScriptResult = {
    status: record.status,
    ...(typeof record.failureCode === "string" ? { failureCode: record.failureCode } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
  const renderer = asRecord(record.renderer);
  const dcc = asRecord(record.dcc);
  const canonical = asRecord(record.canonical);
  const temporaryExecution = asRecord(record.temporaryExecution);
  const render = asRecord(record.render);
  if (renderer) result.renderer = renderer;
  if (dcc) result.dcc = dcc;
  if (canonical) result.canonical = canonical;
  if (temporaryExecution) result.temporaryExecution = temporaryExecution;
  if (render) result.render = render;
  return result;
}

function batchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}

function exactDccVersion(script: ScriptResult, process: ControlledProcessResult): string | null {
  return (
    process.stdout.match(/Product version:\s+3ds Max\s+(20\d{2}(?:\.\d+)?)/iu)?.[1] ??
    stringField(script.dcc?.version)
  );
}

function fail(
  code: string,
  message: string,
  dcc: ThreeDsMaxDiscoveryResult | null,
  compatibilityMode: boolean,
  plan: GoldenCoronaPreviewPlan | null,
  requestHash: string | null,
  process: ControlledProcessResult | null = null,
): GoldenCoronaPreviewExecutionResult {
  return {
    status: "FAILED",
    error: { code, message },
    dcc,
    compatibilityMode,
    process,
    plan,
    evidence: null,
    requestHash,
  };
}

export function calculateGoldenCoronaPreviewRequestHash(plan: GoldenCoronaPreviewPlan): string {
  return semanticJsonHash({
    artifactHash: plan.source.artifactHash,
    cameraId: plan.camera.logicalId,
    intentSource: plan.intentSource,
    profileId: plan.profileId,
    render: plan.render,
    revisionId: plan.source.revisionId,
    sceneId: plan.source.sceneId,
    sceneSpecHash: plan.source.sceneSpecHash,
  });
}

export function isWorkerControlledGoldenPreviewOutput(
  workspaceRoot: string,
  outputPath: string,
): boolean {
  return (
    resolve(outputPath) === resolve(workspaceRoot, "render", "golden-living-preview.png") &&
    !outputPath.includes("..")
  );
}

function buildEvidence(
  script: ScriptResult,
  outputPath: string,
  plan: GoldenCoronaPreviewPlan,
  stagedArtifactHash: string,
  dccVersion: string,
): GoldenCoronaPreviewEvidence | null {
  const evidence: GoldenCoronaPreviewEvidence = {
    evidenceVersion: "0.1.0",
    source: {
      ...plan.source,
      stagedArtifactHash,
    },
    intentSource: "trusted_diagnostic_profile",
    profileId: goldenLivingCoronaPreviewProfile.profileId,
    renderer: {
      engine: "corona",
      className: stringField(script.renderer?.className),
      version: typeof script.renderer?.version === "string" ? script.renderer.version : null,
    },
    dcc: {
      product: "3ds_max",
      version: dccVersion,
      compatibilityMode: booleanField(script.dcc?.compatibilityMode),
    },
    canonical: script.canonical,
    temporaryExecution: script.temporaryExecution,
    render: script.render,
    output: {
      format: "png",
      byteLength: statSync(outputPath).size,
      sha256: rawFileHash(outputPath),
    },
    status: "PASS",
  };
  return validateGoldenCoronaPreviewEvidence(evidence).ok ? evidence : null;
}

/**
 * Executes the repository-owned non-canonical Corona preview against only a
 * staged copy of a verified Golden rev8 artifact. It never saves a scene.
 */
export async function executeGoldenCoronaPreview({
  config,
  sceneSpec,
  expectedManifest,
  verifiedArtifactPath,
  authorizeDccExecution,
  executionEnvironment = process.env,
}: {
  config: GoldenCoronaPreviewExecutionConfig;
  sceneSpec: Record<string, unknown>;
  expectedManifest: Record<string, unknown>;
  verifiedArtifactPath: string;
  authorizeDccExecution: boolean;
  executionEnvironment?: NodeJS.ProcessEnv;
}): Promise<GoldenCoronaPreviewExecutionResult> {
  const manifestValidation = validateSceneManifest(expectedManifest);
  if (!manifestValidation.ok) {
    return fail(
      "RENDER_SOURCE_MANIFEST_MISMATCH",
      "Expected rev8 manifest is invalid",
      null,
      false,
      null,
      null,
    );
  }
  if (!existsSync(verifiedArtifactPath) || !statSync(verifiedArtifactPath).isFile()) {
    return fail(
      "RENDER_SOURCE_ARTIFACT_MISSING",
      "Verified rev8 artifact is unavailable",
      null,
      false,
      null,
      null,
    );
  }
  const artifactHash = rawFileHash(verifiedArtifactPath);
  const sceneSpecHash = semanticJsonHash(sceneSpec);
  let plan: GoldenCoronaPreviewPlan;
  try {
    plan = new CoronaRendererAdapter().compileDiagnosticPreview(sceneSpec, {
      artifactHash,
      sceneSpecHash,
    });
  } catch (error) {
    const code =
      error instanceof CoronaAdapterCompileError ? error.code : "GOLDEN_PREVIEW_PLAN_INVALID";
    return fail(
      code,
      error instanceof Error ? error.message : String(error),
      null,
      false,
      null,
      null,
    );
  }
  const requestHash = calculateGoldenCoronaPreviewRequestHash(plan);
  if (!validateGoldenCoronaPreviewPlan(plan).ok) {
    return fail(
      "GOLDEN_PREVIEW_PLAN_INVALID",
      "Diagnostic preview compiler produced an invalid plan",
      null,
      false,
      plan,
      requestHash,
    );
  }
  if (
    !isDccExecutionAuthorized({
      allowDccExecution: config.allowDccExecution,
      authorizeDccExecution,
    })
  ) {
    return {
      status: "BLOCKED",
      error: {
        code: "DCC_EXECUTION_DISABLED",
        message: "Golden Corona preview requires allowDccExecution=true and DCC authorization",
      },
      dcc: null,
      compatibilityMode: false,
      process: null,
      plan,
      evidence: null,
      requestHash,
    };
  }
  const dcc = await discoverThreeDsMax({ installationOverride: config.threeDsMaxInstallationPath });
  if (dcc.status === "NOT_FOUND" || !dcc.batchExecutablePath) {
    return fail("DCC_NOT_FOUND", "3ds Max Batch is unavailable", dcc, false, plan, requestHash);
  }
  const compatibilityMode = dcc.version !== "2026";
  if (compatibilityMode && !config.allowCompatibilityVersionForSpike) {
    return fail(
      "DCC_VERSION_UNSUPPORTED",
      "3ds Max compatibility mode is disabled",
      dcc,
      true,
      plan,
      requestHash,
    );
  }

  mkdirSync(config.workspaceRoot, { recursive: true });
  const workspace = mkdtempSync(join(config.workspaceRoot, "golden-corona-preview-"));
  const inputDirectory = join(workspace, "input");
  const renderDirectory = join(workspace, "render");
  const stagedArtifactPath = join(inputDirectory, "project.max");
  const expectedManifestPath = join(inputDirectory, "expected-scene-manifest.json");
  const actualManifestPath = join(workspace, "verification", "scene-manifest.json");
  const verifyResultPath = join(workspace, "verification", "verify-result.json");
  const planPath = join(workspace, "golden-corona-preview-plan.json");
  const resultPath = join(workspace, "golden-corona-preview-result.json");
  const outputPath = join(renderDirectory, "golden-living-preview.png");
  mkdirSync(inputDirectory, { recursive: true });
  mkdirSync(renderDirectory, { recursive: true });
  copyFileSync(verifiedArtifactPath, stagedArtifactPath);
  if (
    executionEnvironment.AI_ARCHVIZ_TEST_FORCE_GOLDEN_CORONA_PREVIEW_FAILURE === "base_hash_tamper"
  ) {
    const bytes = readFileSync(stagedArtifactPath);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(stagedArtifactPath, bytes);
  }
  const stagedArtifactHash = rawFileHash(stagedArtifactPath);
  if (stagedArtifactHash !== artifactHash) {
    rmSync(workspace, { recursive: true, force: true });
    return fail(
      "RENDER_SOURCE_ARTIFACT_HASH_MISMATCH",
      "Staged render input does not match the verified rev8 artifact",
      dcc,
      compatibilityMode,
      plan,
      requestHash,
    );
  }
  writeDeterministicJson(planPath, plan);
  writeDeterministicJson(expectedManifestPath, expectedManifest);

  try {
    if (!isWorkerControlledGoldenPreviewOutput(workspace, outputPath)) {
      return fail(
        "RENDER_OUTPUT_PATH_INVALID",
        "Preview output escaped worker control",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
      );
    }
    const process = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(
        resolve(config.repositoryRoot, "tools/3ds-max/python/render_golden_corona_preview.py"),
      ),
      cwd: dcc.installationPath ?? config.repositoryRoot,
      timeoutMs: config.processTimeoutMs,
      env: {
        ...executionEnvironment,
        AI_ARCHVIZ_CANDIDATE_PATH: stagedArtifactPath,
        AI_ARCHVIZ_MANIFEST_PATH: actualManifestPath,
        AI_ARCHVIZ_VERIFY_RESULT_PATH: verifyResultPath,
        AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
        AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_PLAN_PATH: planPath,
        AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_EXPECTED_MANIFEST_PATH: expectedManifestPath,
        AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_OUTPUT_PATH: outputPath,
        AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_RESULT_PATH: resultPath,
      },
      outputEncoding: "utf16le",
    });
    if (process.errorCode === "PROCESS_TIMEOUT") {
      return fail(
        "PROCESS_TIMEOUT",
        "Golden Corona preview exceeded worker timeout",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    if (!existsSync(resultPath)) {
      return fail(
        process.errorCode ?? "CORONA_RENDER_FAILED",
        "Preview runner produced no result",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    const script = parseScriptResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (!script) {
      return fail(
        "GOLDEN_PREVIEW_RUNNER_RESULT_INVALID",
        "Preview runner result is malformed",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    if (script.status !== "PASS") {
      return fail(
        script.failureCode ?? process.errorCode ?? "CORONA_RENDER_FAILED",
        script.message ?? "Preview runner failed",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    if (process.errorCode !== null || !isExpectedPng(outputPath)) {
      return fail(
        process.errorCode ?? "RENDER_OUTPUT_INVALID",
        "Preview output is not a valid 320x240 PNG",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    if (
      rawFileHash(verifiedArtifactPath) !== artifactHash ||
      rawFileHash(stagedArtifactPath) !== stagedArtifactHash
    ) {
      return fail(
        "RENDER_SOURCE_ARTIFACT_MUTATED",
        "Canonical or staged rev8 artifact changed during preview",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    const dccVersion = exactDccVersion(script, process);
    if (!dccVersion) {
      return fail(
        "DCC_VERSION_UNAVAILABLE",
        "Preview runner did not report a product version",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    const evidence = buildEvidence(script, outputPath, plan, stagedArtifactHash, dccVersion);
    if (!evidence) {
      return fail(
        "GOLDEN_PREVIEW_EVIDENCE_INVALID",
        "Golden preview evidence failed schema validation",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        process,
      );
    }
    return {
      status: "PASS",
      error: null,
      dcc,
      compatibilityMode,
      process,
      plan,
      evidence,
      requestHash,
    };
  } catch (error) {
    return fail(
      "CORONA_RENDER_FAILED",
      error instanceof Error ? error.message : String(error),
      dcc,
      compatibilityMode,
      plan,
      requestHash,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
