import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type RendererRealizationEvidence,
  validateCoronaExecutionPlan,
  validateRendererRealizationEvidence,
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
import { writeDeterministicJson } from "./workspace.js";

export interface CoronaAdapterExecutionConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  processTimeoutMs: number;
  threeDsMaxInstallationPath: string | null;
  allowCompatibilityVersionForSpike: boolean;
  allowDccExecution: boolean;
}

export interface CoronaAdapterExecutionResult {
  status: "PASS" | "FAILED" | "BLOCKED";
  error: { code: string; message: string } | null;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  process: ControlledProcessResult | null;
  plan: CoronaExecutionPlan | null;
  evidence: RendererRealizationEvidence | null;
}

interface ScriptResult {
  status: "PASS" | "FAILED";
  failureCode?: string;
  message?: string;
  renderer?: Record<string, unknown>;
  dcc?: Record<string, unknown>;
  materials?: unknown;
  materialAssignments?: unknown;
  lights?: unknown;
  camera?: unknown;
  render?: unknown;
  adapterDefaults?: unknown;
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
    ...(record.materials !== undefined ? { materials: record.materials } : {}),
    ...(record.materialAssignments !== undefined
      ? { materialAssignments: record.materialAssignments }
      : {}),
    ...(record.lights !== undefined ? { lights: record.lights } : {}),
    ...(record.camera !== undefined ? { camera: record.camera } : {}),
    ...(record.render !== undefined ? { render: record.render } : {}),
    ...(record.adapterDefaults !== undefined ? { adapterDefaults: record.adapterDefaults } : {}),
  };
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function isExpectedPng(path: string): boolean {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size <= 0) return false;
  const bytes = readFileSync(path);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return false;
  return bytes.readUInt32BE(16) === 320 && bytes.readUInt32BE(20) === 240;
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
  process: ControlledProcessResult | null = null,
): CoronaAdapterExecutionResult {
  return {
    status: "FAILED",
    error: { code, message },
    dcc,
    compatibilityMode,
    process,
    plan,
    evidence: null,
  };
}

function exactDccVersion(script: ScriptResult, process: ControlledProcessResult): string | null {
  const observed = process.stdout.match(/Product version:\s+3ds Max\s+(20\d{2}(?:\.\d+)?)/iu)?.[1];
  return observed ?? stringField(script.dcc?.version);
}

function buildEvidence(
  script: ScriptResult,
  outputPath: string,
  dccVersion: string,
): RendererRealizationEvidence | null {
  const renderer = script.renderer;
  const dcc = script.dcc;
  const evidence: RendererRealizationEvidence = {
    rendererRealizationEvidenceVersion: "0.1.0",
    renderer: {
      engine: "corona",
      className: stringField(renderer?.className),
      version: typeof renderer?.version === "string" ? renderer.version : null,
    },
    dcc: {
      product: "3ds_max",
      version: dccVersion,
      compatibilityMode: booleanField(dcc?.compatibilityMode),
    },
    materials: script.materials,
    materialAssignments: script.materialAssignments,
    lights: script.lights,
    camera: script.camera,
    render: script.render,
    adapterDefaults: script.adapterDefaults,
    output: {
      format: "png",
      byteLength: statSync(outputPath).size,
      sha256: sha256File(outputPath),
    },
    status: "PASS",
  };
  return validateRendererRealizationEvidence(evidence).ok ? evidence : null;
}

export function isWorkerControlledCoronaAdapterOutput(
  workspaceRoot: string,
  outputPath: string,
): boolean {
  return (
    resolve(outputPath) === resolve(workspaceRoot, "render", "corona-adapter-preview.png") &&
    !outputPath.includes("..")
  );
}

/** Executes only a previously pure-compiled Corona plan in a fresh owned DCC process. */
export async function executeCoronaAdapter({
  config,
  sceneSpec,
  renderJob,
  authorizeDccExecution,
  executionEnvironment = process.env,
}: {
  config: CoronaAdapterExecutionConfig;
  sceneSpec: Record<string, unknown>;
  renderJob: unknown;
  authorizeDccExecution: boolean;
  executionEnvironment?: NodeJS.ProcessEnv;
}): Promise<CoronaAdapterExecutionResult> {
  let plan: CoronaExecutionPlan;
  try {
    plan = new CoronaRendererAdapter().compile(sceneSpec, renderJob);
  } catch (error) {
    const code =
      error instanceof CoronaAdapterCompileError ? error.code : "CORONA_EXECUTION_PLAN_INVALID";
    return fail(code, error instanceof Error ? error.message : String(error), null, false, null);
  }
  if (!validateCoronaExecutionPlan(plan).ok) {
    return fail(
      "CORONA_EXECUTION_PLAN_INVALID",
      "Pure Corona adapter produced an invalid trusted plan",
      null,
      false,
      plan,
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
        message: "Corona adapter requires allowDccExecution=true and DCC authorization",
      },
      dcc: null,
      compatibilityMode: false,
      process: null,
      plan,
      evidence: null,
    };
  }

  const dcc = await discoverThreeDsMax({ installationOverride: config.threeDsMaxInstallationPath });
  if (dcc.status === "NOT_FOUND" || !dcc.batchExecutablePath) {
    return fail("DCC_NOT_FOUND", "3ds Max Batch is unavailable", dcc, false, plan);
  }
  const compatibilityMode = dcc.version !== "2026";
  if (compatibilityMode && !config.allowCompatibilityVersionForSpike) {
    return fail(
      "DCC_VERSION_UNSUPPORTED",
      "3ds Max compatibility mode is disabled",
      dcc,
      true,
      plan,
    );
  }

  mkdirSync(config.workspaceRoot, { recursive: true });
  const workspace = mkdtempSync(join(config.workspaceRoot, "corona-adapter-"));
  const renderDirectory = join(workspace, "render");
  const outputPath = join(renderDirectory, "corona-adapter-preview.png");
  const planPath = join(workspace, "corona-execution-plan.json");
  const resultPath = join(workspace, "renderer-realization-result.json");
  mkdirSync(renderDirectory, { recursive: true });
  writeDeterministicJson(planPath, plan);

  try {
    if (!isWorkerControlledCoronaAdapterOutput(workspace, outputPath)) {
      return fail(
        "RENDER_OUTPUT_PATH_INVALID",
        "Render output escaped worker control",
        dcc,
        compatibilityMode,
        plan,
      );
    }
    const process = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(
        resolve(config.repositoryRoot, "tools/3ds-max/python/render_corona_adapter.py"),
      ),
      cwd: dcc.installationPath ?? config.repositoryRoot,
      timeoutMs: config.processTimeoutMs,
      env: buildDccChildEnvironment({
        parentEnvironment: executionEnvironment,
        overrides: {
          AI_ARCHVIZ_TEST_FORCE_CORONA_ADAPTER_FAILURE:
            executionEnvironment.AI_ARCHVIZ_TEST_FORCE_CORONA_ADAPTER_FAILURE,
          AI_ARCHVIZ_CORONA_ADAPTER_PLAN_PATH: planPath,
          AI_ARCHVIZ_CORONA_ADAPTER_OUTPUT_PATH: outputPath,
          AI_ARCHVIZ_CORONA_ADAPTER_RESULT_PATH: resultPath,
        },
      }),
      outputEncoding: "utf16le",
    });
    if (process.errorCode === "PROCESS_TIMEOUT") {
      return fail(
        "PROCESS_TIMEOUT",
        "Corona adapter exceeded worker timeout",
        dcc,
        compatibilityMode,
        plan,
        process,
      );
    }
    if (!existsSync(resultPath)) {
      return fail(
        process.errorCode ?? "CORONA_RENDER_FAILED",
        "Corona adapter runner produced no result",
        dcc,
        compatibilityMode,
        plan,
        process,
      );
    }
    const script = parseScriptResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (!script) {
      return fail(
        "CORONA_RUNNER_RESULT_INVALID",
        "Corona adapter runner result is malformed",
        dcc,
        compatibilityMode,
        plan,
        process,
      );
    }
    if (script.status !== "PASS") {
      return fail(
        script.failureCode ?? process.errorCode ?? "CORONA_RENDER_FAILED",
        script.message ?? "Corona adapter did not complete",
        dcc,
        compatibilityMode,
        plan,
        process,
      );
    }
    if (process.errorCode !== null || !isExpectedPng(outputPath)) {
      return fail(
        process.errorCode ?? "RENDER_OUTPUT_INVALID",
        "Corona adapter output is not the required non-empty 320x240 PNG",
        dcc,
        compatibilityMode,
        plan,
        process,
      );
    }
    const observedDccVersion = exactDccVersion(script, process);
    if (!observedDccVersion) {
      return fail(
        "DCC_VERSION_UNAVAILABLE",
        "Corona adapter did not report a product version",
        dcc,
        compatibilityMode,
        plan,
        process,
      );
    }
    const evidence = buildEvidence(script, outputPath, observedDccVersion);
    if (!evidence) {
      return fail(
        "RENDERER_REALIZATION_EVIDENCE_INVALID",
        "Corona realization evidence did not validate",
        dcc,
        compatibilityMode,
        plan,
        process,
      );
    }
    return { status: "PASS", error: null, dcc, compatibilityMode, process, plan, evidence };
  } catch (error) {
    return fail(
      "CORONA_RENDER_FAILED",
      error instanceof Error ? error.message : String(error),
      dcc,
      compatibilityMode,
      plan,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
