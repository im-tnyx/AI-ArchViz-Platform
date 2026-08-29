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
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  type CanonicalCoronaPreviewEvidence,
  semanticJsonHash,
  validateCanonicalCoronaPreviewEvidence,
  validateRenderJobV02,
  validateSceneManifest,
} from "@ai-archviz/worker-contracts";
import {
  CoronaAdapterCompileError,
  type CoronaExecutionPlan,
  CoronaRendererAdapter,
} from "./corona-renderer-adapter.js";
import { buildDccChildEnvironment } from "./dcc-environment.js";
import { isDccExecutionAuthorized } from "./dcc-execution-guard.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";
import { canonicalRenderStateExpectation, RevisionValidationError } from "./revision.js";
import { writeDeterministicJson } from "./workspace.js";

const canonicalProjectId = "project_golden_living_001";
const canonicalSceneId = "scene_golden_living_001";
const canonicalRevisionId = "rev_golden_0010";
const canonicalLightLogicalId = "light_living_key_area";
const canonicalCameraLogicalId = "camera_living_a";

export interface CanonicalGoldenCoronaPreviewExecutionConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  processTimeoutMs: number;
  threeDsMaxInstallationPath: string | null;
  allowCompatibilityVersionForSpike: boolean;
  allowDccExecution: boolean;
}

export interface CanonicalGoldenCoronaPreviewExecutionResult {
  status: "PASS" | "FAILED" | "BLOCKED";
  error: { code: string; message: string } | null;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  process: ControlledProcessResult | null;
  plan: CoronaExecutionPlan | null;
  requestHash: string | null;
  materialDeduplicationVerified: boolean;
  evidence: CanonicalCoronaPreviewEvidence | null;
}

interface ScriptResult {
  status: "PASS" | "FAILED";
  failureCode?: string;
  message?: string;
  renderer?: Record<string, unknown>;
  dcc?: Record<string, unknown>;
  canonicalRenderState?: Record<string, unknown>;
  materials?: unknown;
  materialAssignments?: unknown;
  camera?: Record<string, unknown>;
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

function parseScriptResult(value: unknown): ScriptResult | null {
  const record = asRecord(value);
  if (!record || (record.status !== "PASS" && record.status !== "FAILED")) return null;
  return {
    status: record.status,
    ...(typeof record.failureCode === "string" ? { failureCode: record.failureCode } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(asRecord(record.renderer)
      ? { renderer: asRecord(record.renderer) as Record<string, unknown> }
      : {}),
    ...(asRecord(record.dcc) ? { dcc: asRecord(record.dcc) as Record<string, unknown> } : {}),
    ...(asRecord(record.canonicalRenderState)
      ? { canonicalRenderState: asRecord(record.canonicalRenderState) as Record<string, unknown> }
      : {}),
    ...(record.materials !== undefined ? { materials: record.materials } : {}),
    ...(record.materialAssignments !== undefined
      ? { materialAssignments: record.materialAssignments }
      : {}),
    ...(asRecord(record.camera)
      ? { camera: asRecord(record.camera) as Record<string, unknown> }
      : {}),
    ...(asRecord(record.render)
      ? { render: asRecord(record.render) as Record<string, unknown> }
      : {}),
  };
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

function batchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}

function fail(
  code: string,
  message: string,
  dcc: ThreeDsMaxDiscoveryResult | null,
  compatibilityMode: boolean,
  plan: CoronaExecutionPlan | null,
  requestHash: string | null,
  process: ControlledProcessResult | null = null,
): CanonicalGoldenCoronaPreviewExecutionResult {
  return {
    status: "FAILED",
    error: { code, message },
    dcc,
    compatibilityMode,
    process,
    plan,
    requestHash,
    materialDeduplicationVerified: false,
    evidence: null,
  };
}

/** No absolute paths, PID, timestamp, PNG hash, or machine identity. */
export function calculateCanonicalGoldenCoronaPreviewRequestHash(
  plan: CoronaExecutionPlan,
  sceneSpecHash: string,
  canonicalArtifactHash: string,
): string {
  return semanticJsonHash({
    sceneSpecHash,
    canonicalArtifactHash,
    revisionId: plan.revisionId,
    cameraId: plan.camera.logicalId,
    engine: plan.engine,
    mode: plan.render.mode,
    resolution: plan.render.resolution,
    termination: plan.render.termination,
    adapterDefaults: plan.adapterDefaults,
  });
}

export function isWorkerControlledCanonicalPreviewOutput(
  workspaceRoot: string,
  outputPath: string,
): boolean {
  return (
    resolve(outputPath) === resolve(workspaceRoot, "render", "canonical-golden-preview.png") &&
    !outputPath.includes("..")
  );
}

/** Same canonical materialId must realize to the same native Corona material instance. */
function verifyMaterialDeduplication(assignments: readonly Record<string, unknown>[]): boolean {
  const instanceByMaterial = new Map<string, string>();
  for (const assignment of assignments) {
    const materialId = stringField(assignment.materialId);
    const instanceName = stringField(assignment.materialInstanceName);
    if (!materialId || !instanceName) return false;
    const existing = instanceByMaterial.get(materialId);
    if (existing === undefined) {
      instanceByMaterial.set(materialId, instanceName);
    } else if (existing !== instanceName) {
      return false;
    }
  }
  return true;
}

function exactDccVersion(script: ScriptResult, process: ControlledProcessResult): string | null {
  return (
    process.stdout.match(/Product version:\s+3ds Max\s+(20\d{2}(?:\.\d+)?)/iu)?.[1] ??
    stringField(script.dcc?.version)
  );
}

function buildEvidence(
  script: ScriptResult,
  outputPath: string,
  sceneSpecHash: string,
  canonicalArtifactHash: string,
  stagedArtifactHash: string,
  requestHash: string,
  dccVersion: string,
): CanonicalCoronaPreviewEvidence | null {
  const renderState = script.canonicalRenderState;
  const evidence: CanonicalCoronaPreviewEvidence = {
    evidenceVersion: "0.1.0",
    intentSource: "canonical_scene_spec",
    projectId: canonicalProjectId,
    sceneId: canonicalSceneId,
    revisionId: canonicalRevisionId,
    sceneSpecHash,
    canonicalArtifactHash,
    stagedArtifactHash,
    requestHash,
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
    canonicalLights: renderState?.lights,
    materials: script.materials,
    materialAssignments: script.materialAssignments,
    camera: script.camera,
    render: script.render,
    output: {
      format: "png",
      byteLength: statSync(outputPath).size,
      sha256: rawFileHash(outputPath),
    },
    status: "PASS",
  };
  return validateCanonicalCoronaPreviewEvidence(evidence).ok ? evidence : null;
}

/**
 * Renders the first Corona preview whose renderer and light intent are both
 * already-canonical rev10 SceneSpec revision state: it opens only a staged
 * copy of the already-VERIFIED rev10 artifact, verifies it fresh, and reuses
 * the persisted CoronaLight and renderer as-is. It never rebuilds geometry
 * from the plan, never creates a light, never switches the renderer, and
 * never saves the loaded scene.
 */
export async function executeCanonicalGoldenCoronaPreview({
  config,
  sceneSpec,
  renderJob,
  expectedManifest,
  verifiedArtifactPath,
  authorizeDccExecution,
  executionEnvironment = process.env,
}: {
  config: CanonicalGoldenCoronaPreviewExecutionConfig;
  sceneSpec: Record<string, unknown>;
  renderJob: unknown;
  expectedManifest: Record<string, unknown>;
  verifiedArtifactPath: string;
  authorizeDccExecution: boolean;
  executionEnvironment?: NodeJS.ProcessEnv;
}): Promise<CanonicalGoldenCoronaPreviewExecutionResult> {
  const sceneValidation = validateSceneSpec(sceneSpec);
  if (!sceneValidation.ok) {
    return fail(
      "SCENE_SPEC_INVALID",
      "Canonical source SceneSpec is invalid",
      null,
      false,
      null,
      null,
    );
  }
  const scene = sceneValidation.value as unknown as {
    project: { id: string };
    scene: { id: string; revisionId: string; headRevisionId: string };
    render: { engine: string; mode: string };
  };
  if (
    scene.project.id !== canonicalProjectId ||
    scene.scene.id !== canonicalSceneId ||
    scene.scene.revisionId !== canonicalRevisionId ||
    scene.scene.headRevisionId !== canonicalRevisionId
  ) {
    return fail(
      "CANONICAL_SOURCE_REVISION_MISMATCH",
      "Canonical Golden preview requires exactly the verified rev10 SceneSpec",
      null,
      false,
      null,
      null,
    );
  }
  if (scene.render.engine !== "corona" || scene.render.mode !== "preview") {
    return fail(
      "RENDER_SOURCE_RENDER_STATE_MISMATCH",
      "Canonical rev10 SceneSpec must declare render.engine=corona and render.mode=preview",
      null,
      false,
      null,
      null,
    );
  }
  if (!validateSceneManifest(expectedManifest).ok) {
    return fail(
      "RENDER_SOURCE_MANIFEST_MISMATCH",
      "Expected rev10 manifest is invalid",
      null,
      false,
      null,
      null,
    );
  }
  let expectedRenderState: Record<string, unknown> | null;
  try {
    expectedRenderState = canonicalRenderStateExpectation(sceneSpec);
  } catch (error) {
    const code = error instanceof RevisionValidationError ? error.code : "RENDER_STATE_MISMATCH";
    return fail(
      code,
      error instanceof Error ? error.message : String(error),
      null,
      false,
      null,
      null,
    );
  }
  if (!expectedRenderState) {
    return fail(
      "RENDER_SOURCE_RENDER_STATE_MISMATCH",
      "Canonical rev10 SceneSpec did not produce a Corona preview render state",
      null,
      false,
      null,
      null,
    );
  }
  const expectedLights = (expectedRenderState.lights as Array<{ logicalId?: string }>) ?? [];
  if (!expectedLights.some((light) => light.logicalId === canonicalLightLogicalId)) {
    return fail(
      "CANONICAL_LIGHT_NOT_FOUND",
      `Canonical rev10 render state must contain ${canonicalLightLogicalId}`,
      null,
      false,
      null,
      null,
    );
  }
  if (!existsSync(verifiedArtifactPath) || !statSync(verifiedArtifactPath).isFile()) {
    return fail(
      "RENDER_SOURCE_ARTIFACT_MISSING",
      "Verified rev10 artifact is unavailable",
      null,
      false,
      null,
      null,
    );
  }
  const canonicalArtifactHash = rawFileHash(verifiedArtifactPath);
  const sceneSpecHash = semanticJsonHash(sceneSpec);

  let plan: CoronaExecutionPlan;
  try {
    plan = new CoronaRendererAdapter().compile(sceneSpec, renderJob);
  } catch (error) {
    const code =
      error instanceof CoronaAdapterCompileError ? error.code : "CORONA_EXECUTION_PLAN_INVALID";
    return fail(
      code,
      error instanceof Error ? error.message : String(error),
      null,
      false,
      null,
      null,
    );
  }
  if (
    plan.revisionId !== canonicalRevisionId ||
    plan.camera.logicalId !== canonicalCameraLogicalId ||
    !plan.lights.some((light) => light.logicalId === canonicalLightLogicalId)
  ) {
    return fail(
      "CANONICAL_SOURCE_REVISION_MISMATCH",
      "Compiled plan does not describe the canonical rev10 renderer/light intent",
      null,
      false,
      plan,
      null,
    );
  }
  const requestHash = calculateCanonicalGoldenCoronaPreviewRequestHash(
    plan,
    sceneSpecHash,
    canonicalArtifactHash,
  );
  if (!validateRenderJobV02(renderJob).ok) {
    return fail(
      "RENDER_JOB_INVALID",
      "render-job-v0.2 failed schema validation",
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
        message: "Canonical Golden preview requires allowDccExecution=true and DCC authorization",
      },
      dcc: null,
      compatibilityMode: false,
      process: null,
      plan,
      requestHash,
      materialDeduplicationVerified: false,
      evidence: null,
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
  const workspace = mkdtempSync(join(config.workspaceRoot, "canonical-golden-preview-"));
  const inputDirectory = join(workspace, "input");
  const renderDirectory = join(workspace, "render");
  const verificationDirectory = join(workspace, "verification");
  const stagedArtifactPath = join(inputDirectory, "rev10.max");
  const expectedManifestPath = join(inputDirectory, "expected-scene-manifest.json");
  const expectedRenderStatePath = join(inputDirectory, "expected-render-state.json");
  const actualManifestPath = join(verificationDirectory, "scene-manifest.json");
  const verifyResultPath = join(verificationDirectory, "verify-result.json");
  const renderStatePath = join(verificationDirectory, "render-state.json");
  const renderStateResultPath = join(verificationDirectory, "render-state-result.json");
  const planPath = join(workspace, "canonical-execution-plan.json");
  const resultPath = join(workspace, "canonical-preview-result.json");
  const outputPath = join(renderDirectory, "canonical-golden-preview.png");
  mkdirSync(inputDirectory, { recursive: true });
  mkdirSync(renderDirectory, { recursive: true });
  mkdirSync(verificationDirectory, { recursive: true });
  copyFileSync(verifiedArtifactPath, stagedArtifactPath);
  if (
    executionEnvironment.AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_FAILURE ===
    "staged_hash_tamper"
  ) {
    const bytes = readFileSync(stagedArtifactPath);
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    writeFileSync(stagedArtifactPath, bytes);
  }
  const stagedArtifactHash = rawFileHash(stagedArtifactPath);
  if (stagedArtifactHash !== canonicalArtifactHash) {
    rmSync(workspace, { recursive: true, force: true });
    return fail(
      "RENDER_SOURCE_ARTIFACT_HASH_MISMATCH",
      "Staged render input does not match the verified rev10 artifact",
      dcc,
      compatibilityMode,
      plan,
      requestHash,
    );
  }
  writeDeterministicJson(planPath, plan);
  writeDeterministicJson(expectedManifestPath, expectedManifest);
  writeDeterministicJson(expectedRenderStatePath, expectedRenderState);

  try {
    if (!isWorkerControlledCanonicalPreviewOutput(workspace, outputPath)) {
      return fail(
        "RENDER_OUTPUT_PATH_INVALID",
        "Canonical preview output escaped worker control",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
      );
    }
    const dccProcess = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(
        resolve(
          config.repositoryRoot,
          "tools/3ds-max/python/render_canonical_golden_corona_preview.py",
        ),
      ),
      cwd: dcc.installationPath ?? config.repositoryRoot,
      timeoutMs: config.processTimeoutMs,
      env: buildDccChildEnvironment({
        parentEnvironment: executionEnvironment,
        overrides: {
          AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_FAILURE:
            executionEnvironment.AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_FAILURE,
          AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH:
            executionEnvironment.AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH,
          AI_ARCHVIZ_TEST_FORCE_VERIFICATION_FAILURE:
            executionEnvironment.AI_ARCHVIZ_TEST_FORCE_VERIFICATION_FAILURE,
          AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE:
            executionEnvironment.AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE,
          AI_ARCHVIZ_CANDIDATE_PATH: stagedArtifactPath,
          AI_ARCHVIZ_MANIFEST_PATH: actualManifestPath,
          AI_ARCHVIZ_VERIFY_RESULT_PATH: verifyResultPath,
          AI_ARCHVIZ_EXPECTED_MANIFEST_PATH: expectedManifestPath,
          AI_ARCHVIZ_EXPECTED_RENDER_STATE_PATH: expectedRenderStatePath,
          AI_ARCHVIZ_RENDER_STATE_PATH: renderStatePath,
          AI_ARCHVIZ_RENDER_STATE_RESULT_PATH: renderStateResultPath,
          AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
          AI_ARCHVIZ_CANONICAL_PREVIEW_PLAN_PATH: planPath,
          AI_ARCHVIZ_CANONICAL_PREVIEW_OUTPUT_PATH: outputPath,
          AI_ARCHVIZ_CANONICAL_PREVIEW_RESULT_PATH: resultPath,
        },
      }),
      outputEncoding: "utf16le",
    });
    if (dccProcess.errorCode === "PROCESS_TIMEOUT") {
      return fail(
        "PROCESS_TIMEOUT",
        "Canonical Golden preview exceeded worker timeout",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    if (!existsSync(resultPath)) {
      return fail(
        dccProcess.errorCode ?? "CORONA_RENDER_FAILED",
        "Canonical preview runner produced no result",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    const script = parseScriptResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (!script) {
      return fail(
        "CANONICAL_PREVIEW_RUNNER_RESULT_INVALID",
        "Canonical preview runner result is malformed",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    if (script.status !== "PASS") {
      return fail(
        script.failureCode ?? dccProcess.errorCode ?? "CORONA_RENDER_FAILED",
        script.message ?? "Canonical preview runner failed",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    if (dccProcess.errorCode !== null || !isExpectedPng(outputPath)) {
      return fail(
        dccProcess.errorCode ?? "RENDER_OUTPUT_INVALID",
        "Canonical preview output is not a valid 320x240 PNG",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    if (
      rawFileHash(verifiedArtifactPath) !== canonicalArtifactHash ||
      rawFileHash(stagedArtifactPath) !== stagedArtifactHash
    ) {
      return fail(
        "RENDER_SOURCE_ARTIFACT_MUTATED",
        "Canonical or staged rev10 artifact changed during preview",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    const dccVersion = exactDccVersion(script, dccProcess);
    if (!dccVersion) {
      return fail(
        "DCC_VERSION_UNAVAILABLE",
        "Canonical preview runner did not report a product version",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    const assignments = (script.materialAssignments as Array<Record<string, unknown>>) ?? [];
    const materialDeduplicationVerified = verifyMaterialDeduplication(assignments);
    if (!materialDeduplicationVerified) {
      return fail(
        "CORONA_MATERIAL_ASSIGNMENT_FAILED",
        "Canonical material IDs did not realize to a single shared native instance",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    const evidence = buildEvidence(
      script,
      outputPath,
      sceneSpecHash,
      canonicalArtifactHash,
      stagedArtifactHash,
      requestHash,
      dccVersion,
    );
    if (!evidence) {
      return fail(
        "CANONICAL_PREVIEW_EVIDENCE_INVALID",
        "Canonical preview evidence failed schema validation",
        dcc,
        compatibilityMode,
        plan,
        requestHash,
        dccProcess,
      );
    }
    return {
      status: "PASS",
      error: null,
      dcc,
      compatibilityMode,
      process: dccProcess,
      plan,
      requestHash,
      materialDeduplicationVerified,
      evidence,
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
