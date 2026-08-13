import { existsSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  type JobEnvelope,
  validateExecutionReport,
  validateJobEnvelope,
  validateSceneManifest,
  verifyJobHashes,
} from "@ai-archviz/worker-contracts";
import { compileGoldenBuildPlan } from "./build-plan.js";
import type { WorkerConfig } from "./config.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import { compareSceneManifests, type ManifestTolerances } from "./manifest.js";
import { resolveWithinRoot } from "./paths.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";
import {
  createJobWorkspace,
  type JobWorkspace,
  promoteCandidate,
  readJson,
  writeDeterministicJson,
} from "./workspace.js";

const targetVersion = "2026";

interface ReportError {
  code: string;
  message: string;
  retryable: boolean;
}

interface ExecutionReport {
  reportVersion: "0.1.0";
  jobId: string;
  idempotencyKey: string;
  requestHash: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  status: "SUCCESS" | "FAILED" | "BLOCKED";
  startedAt: string;
  completedAt: string;
  candidatePath: "candidate/project.max" | null;
  verifiedOutputPath: "output/project.max" | null;
  manifestPath: "verification/scene-manifest.json" | null;
  validationResult: { status: "PASS" | "FAIL" | "NOT_RUN"; errors: ReportError[] };
  verificationResult: { status: "PASS" | "FAIL" | "NOT_RUN"; errors: ReportError[] };
  error: ReportError | null;
}

export interface GoldenBuildResult {
  workerVersion: "0.1.0";
  status: "SUCCESS" | "FAILED" | "BLOCKED";
  targetVersion: "2026";
  dccVersion: string | null;
  compatibilityMode: boolean;
  dcc: ThreeDsMaxDiscoveryResult | null;
  workspace: string | null;
  buildProcess: ControlledProcessResult | null;
  verificationProcess: ControlledProcessResult | null;
  comparison: ReturnType<typeof compareSceneManifests> | null;
  report: ExecutionReport | null;
}

interface BuildContext {
  startedAt: string;
  job: JobEnvelope;
  workspace: JobWorkspace;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  buildProcess: ControlledProcessResult | null;
  verificationProcess: ControlledProcessResult | null;
  comparison: ReturnType<typeof compareSceneManifests> | null;
}

function reportError(code: string, message: string, retryable = false): ReportError {
  return { code, message, retryable };
}

function sourcePath(repositoryRoot: string, jobPath: string, declaredPath: string): string {
  const fileName = basename(declaredPath);
  const candidate = resolve(dirname(jobPath), fileName);
  return resolveWithinRoot(repositoryRoot, relative(repositoryRoot, candidate));
}

function assertIdentity(
  job: JobEnvelope,
  sceneSpec: Record<string, unknown>,
  expectedManifest: Record<string, unknown>,
): void {
  const project = sceneSpec.project as { id?: unknown };
  const scene = sceneSpec.scene as { id?: unknown; revisionId?: unknown; headRevisionId?: unknown };
  const mismatches = [
    ["projectId", job.projectId, project.id],
    ["sceneId", job.sceneId, scene.id],
    ["requestedRevisionId", job.requestedRevisionId, scene.revisionId],
    ["headRevisionId", job.requestedRevisionId, scene.headRevisionId],
    ["manifest.projectId", job.projectId, expectedManifest.projectId],
    ["manifest.sceneId", job.sceneId, expectedManifest.sceneId],
    ["manifest.revisionId", job.requestedRevisionId, expectedManifest.revisionId],
  ].filter(([, expected, actual]) => expected !== actual);
  if (mismatches.length > 0) {
    throw new Error(`Identity mismatch: ${JSON.stringify(mismatches)}`);
  }
  if (job.jobType !== "buildScene") throw new Error("Spike 1B only accepts buildScene jobs");
  if (
    job.workerRequirements.os !== "windows" ||
    job.workerRequirements.dcc !== "3ds_max" ||
    job.workerRequirements.renderer !== "none"
  ) {
    throw new Error("Job worker requirements do not match Spike 1B");
  }
}

function makeReport(
  context: BuildContext,
  status: ExecutionReport["status"],
  validationStatus: "PASS" | "FAIL",
  verificationStatus: "PASS" | "FAIL" | "NOT_RUN",
  error: ReportError | null,
): ExecutionReport {
  const candidateExists = existsSync(context.workspace.candidatePath);
  const manifestExists = existsSync(context.workspace.manifestPath);
  const outputExists = status === "SUCCESS" && existsSync(context.workspace.outputPath);
  const report: ExecutionReport = {
    reportVersion: "0.1.0",
    jobId: context.job.jobId,
    idempotencyKey: context.job.idempotencyKey,
    requestHash: context.job.requestHash,
    projectId: context.job.projectId,
    sceneId: context.job.sceneId,
    revisionId: context.job.requestedRevisionId,
    status,
    startedAt: context.startedAt,
    completedAt: new Date().toISOString(),
    candidatePath: candidateExists ? "candidate/project.max" : null,
    verifiedOutputPath: outputExists ? "output/project.max" : null,
    manifestPath: manifestExists ? "verification/scene-manifest.json" : null,
    validationResult: {
      status: validationStatus,
      errors:
        validationStatus === "PASS"
          ? []
          : [error ?? reportError("SCHEMA_INVALID", "Validation failed")],
    },
    verificationResult: {
      status: verificationStatus,
      errors:
        verificationStatus === "FAIL"
          ? [error ?? reportError("VERIFICATION_FAILED", "Verification failed")]
          : [],
    },
    error,
  };
  const validation = validateExecutionReport(report);
  if (!validation.ok) {
    throw new Error(`Execution report violates contract: ${JSON.stringify(validation.errors)}`);
  }
  writeDeterministicJson(context.workspace.executionReportPath, report);
  return report;
}

function outer(context: BuildContext, report: ExecutionReport): GoldenBuildResult {
  return {
    workerVersion: "0.1.0",
    status: report.status,
    targetVersion,
    dccVersion: context.dcc?.version ?? null,
    compatibilityMode: context.compatibilityMode,
    dcc: context.dcc,
    workspace: context.workspace.root,
    buildProcess: context.buildProcess,
    verificationProcess: context.verificationProcess,
    comparison: context.comparison,
    report,
  };
}

function fail(
  context: BuildContext,
  code: string,
  message: string,
  options: { blocked?: boolean; validationFailed?: boolean; verificationFailed?: boolean } = {},
): GoldenBuildResult {
  const error = reportError(code, message);
  const report = makeReport(
    context,
    options.blocked ? "BLOCKED" : "FAILED",
    options.validationFailed ? "FAIL" : "PASS",
    options.verificationFailed ? "FAIL" : "NOT_RUN",
    error,
  );
  return outer(context, report);
}

function processError(
  result: ControlledProcessResult,
  phase: "build" | "verification",
): ReportError {
  return reportError(
    result.errorCode ?? "PROCESS_EXIT_NONZERO",
    `${phase} process failed with exit code ${String(result.exitCode)}`,
    result.errorCode === "DCC_LAUNCH_FAILED" || result.errorCode === "PROCESS_TIMEOUT",
  );
}

export async function buildGoldenScene(
  config: WorkerConfig,
  suppliedJobPath: string,
): Promise<GoldenBuildResult> {
  const startedAt = new Date().toISOString();
  const absoluteJobPath = resolveWithinRoot(
    config.repositoryRoot,
    relative(config.repositoryRoot, resolve(config.repositoryRoot, suppliedJobPath)),
  );
  const jobValidation = validateJobEnvelope(readJson(absoluteJobPath));
  if (!jobValidation.ok) {
    throw new Error(`Job Envelope validation failed: ${JSON.stringify(jobValidation.errors)}`);
  }
  const job = jobValidation.value;
  const workspace = createJobWorkspace(config.workspaceRoot, job.jobId);
  const context: BuildContext = {
    startedAt,
    job,
    workspace,
    dcc: null,
    compatibilityMode: false,
    buildProcess: null,
    verificationProcess: null,
    comparison: null,
  };

  let sceneSpec: Record<string, unknown>;
  let expectedManifest: Record<string, unknown>;
  let tolerances: ManifestTolerances;
  try {
    sceneSpec = readJson(
      sourcePath(config.repositoryRoot, absoluteJobPath, job.inputs.sceneSpecPath),
    ) as Record<string, unknown>;
    expectedManifest = readJson(
      sourcePath(config.repositoryRoot, absoluteJobPath, job.inputs.expectedManifestPath),
    ) as Record<string, unknown>;
    tolerances = readJson(
      resolve(dirname(absoluteJobPath), "fixture-manifest.json"),
    ) as ManifestTolerances;
    const sceneValidation = validateSceneSpec(sceneSpec);
    const manifestValidation = validateSceneManifest(expectedManifest);
    if (!sceneValidation.ok || !manifestValidation.ok) {
      return fail(context, "SCHEMA_INVALID", "SceneSpec or expected manifest validation failed", {
        validationFailed: true,
      });
    }
    const hashes = verifyJobHashes(job, sceneSpec, expectedManifest);
    if (!hashes.ok) {
      return fail(context, "HASH_MISMATCH", JSON.stringify(hashes.mismatches), {
        validationFailed: true,
      });
    }
    assertIdentity(job, sceneSpec, expectedManifest);
  } catch (error) {
    return fail(
      context,
      "IDENTITY_MISMATCH",
      error instanceof Error ? error.message : String(error),
      { validationFailed: true },
    );
  }

  let buildPlan: ReturnType<typeof compileGoldenBuildPlan>;
  try {
    buildPlan = compileGoldenBuildPlan(sceneSpec);
  } catch (error) {
    return fail(context, "SCHEMA_INVALID", error instanceof Error ? error.message : String(error), {
      validationFailed: true,
    });
  }
  writeDeterministicJson(workspace.jobPath, job);
  writeDeterministicJson(workspace.sceneSpecPath, sceneSpec);
  writeDeterministicJson(workspace.expectedManifestPath, expectedManifest);
  writeDeterministicJson(workspace.buildPlanPath, buildPlan);
  const materializedHashes = verifyJobHashes(
    job,
    readJson(workspace.sceneSpecPath),
    readJson(workspace.expectedManifestPath),
  );
  if (!materializedHashes.ok) {
    return fail(context, "HASH_MISMATCH", "Materialized input hashes changed", {
      validationFailed: true,
    });
  }

  context.dcc = await discoverThreeDsMax({
    installationOverride: config.threeDsMaxInstallationPath,
  });
  if (context.dcc.status === "NOT_FOUND") {
    return fail(context, "DCC_NOT_FOUND", "3ds Max was not found", { blocked: true });
  }
  if (!context.dcc.batchExecutablePath || !context.dcc.batchExecutableAvailable) {
    return fail(context, "DCC_BATCH_NOT_FOUND", "3ds Max Batch executable was not found", {
      blocked: true,
    });
  }
  if (context.dcc.status === "UNSUPPORTED") {
    const compatibilityAllowed =
      config.allowCompatibilityVersionForSpike && context.dcc.version === "2025";
    if (!compatibilityAllowed) {
      return fail(
        context,
        "DCC_VERSION_UNSUPPORTED",
        `Detected ${context.dcc.version ?? "unknown"}; target is ${targetVersion}`,
        { blocked: true },
      );
    }
    context.compatibilityMode = true;
  }

  const commonEnvironment = {
    ...process.env,
    AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
  };
  context.buildProcess = await runControlledProcess({
    executable: context.dcc.batchExecutablePath,
    args: [resolve(config.repositoryRoot, "tools/3ds-max/python/build_scene.py"), "-v", "2"],
    cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
    timeoutMs: Math.min(config.processTimeoutMs, job.policy.timeoutSeconds * 1_000),
    env: {
      ...commonEnvironment,
      AI_ARCHVIZ_BUILD_PLAN_PATH: workspace.buildPlanPath,
      AI_ARCHVIZ_BUILD_RESULT_PATH: workspace.buildResultPath,
    },
    outputEncoding: "utf16le",
  });
  if (context.buildProcess.errorCode) {
    const error = processError(context.buildProcess, "build");
    return outer(context, makeReport(context, "FAILED", "PASS", "NOT_RUN", error));
  }
  if (existsSync(workspace.buildResultPath)) {
    const buildResult = readJson(workspace.buildResultPath) as {
      status?: unknown;
      message?: unknown;
    };
    if (buildResult.status !== "SUCCESS") {
      return fail(
        context,
        "BUILD_FAILED",
        typeof buildResult.message === "string"
          ? buildResult.message
          : "3ds Max build script reported failure",
      );
    }
  } else {
    return fail(context, "BUILD_FAILED", "3ds Max build result is missing");
  }
  if (!existsSync(workspace.candidatePath) || statSync(workspace.candidatePath).size <= 0) {
    return fail(
      context,
      "CANDIDATE_MISSING",
      "Build process did not produce candidate/project.max",
    );
  }

  context.verificationProcess = await runControlledProcess({
    executable: context.dcc.batchExecutablePath,
    args: [resolve(config.repositoryRoot, "tools/3ds-max/python/verify_scene.py"), "-v", "2"],
    cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
    timeoutMs: Math.min(config.processTimeoutMs, job.policy.timeoutSeconds * 1_000),
    env: {
      ...commonEnvironment,
      AI_ARCHVIZ_MANIFEST_PATH: workspace.manifestPath,
      AI_ARCHVIZ_VERIFY_RESULT_PATH: workspace.verificationResultPath,
    },
    outputEncoding: "utf16le",
  });
  if (context.verificationProcess.errorCode) {
    const error = processError(context.verificationProcess, "verification");
    return outer(context, makeReport(context, "FAILED", "PASS", "FAIL", error));
  }
  if (existsSync(workspace.verificationResultPath)) {
    const verificationResult = readJson(workspace.verificationResultPath) as {
      status?: unknown;
      message?: unknown;
    };
    if (verificationResult.status !== "SUCCESS") {
      return fail(
        context,
        "VERIFICATION_FAILED",
        typeof verificationResult.message === "string"
          ? verificationResult.message
          : "Fresh-process verifier reported failure",
        { verificationFailed: true },
      );
    }
  } else {
    return fail(context, "VERIFICATION_FAILED", "Fresh-process verification result is missing", {
      verificationFailed: true,
    });
  }
  if (!existsSync(workspace.manifestPath)) {
    return fail(context, "VERIFICATION_FAILED", "Fresh process did not produce a manifest", {
      verificationFailed: true,
    });
  }
  const actualManifest = readJson(workspace.manifestPath) as Record<string, unknown>;
  const actualValidation = validateSceneManifest(actualManifest);
  if (!actualValidation.ok) {
    return fail(context, "SCHEMA_INVALID", JSON.stringify(actualValidation.errors), {
      verificationFailed: true,
    });
  }
  context.comparison = compareSceneManifests(expectedManifest, actualManifest, tolerances);
  if (!context.comparison.ok) {
    return fail(context, "MANIFEST_MISMATCH", JSON.stringify(context.comparison.differences), {
      verificationFailed: true,
    });
  }

  try {
    promoteCandidate(workspace.candidatePath, workspace.outputPath);
  } catch (error) {
    return fail(
      context,
      "PROMOTION_FAILED",
      error instanceof Error ? error.message : String(error),
      { verificationFailed: true },
    );
  }
  const report = makeReport(context, "SUCCESS", "PASS", "PASS", null);
  return outer(context, report);
}
