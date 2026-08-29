import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type CoronaMaterialAppearanceEvidence,
  validateCoronaExecutionPlanV02,
  validateCoronaMaterialAppearanceEvidence,
} from "@ai-archviz/worker-contracts";
import {
  CoronaAdapterCompileError,
  type CoronaExecutionPlanV02,
  CoronaRendererAdapter,
} from "./corona-renderer-adapter.js";
import { buildDccChildEnvironment } from "./dcc-environment.js";
import { isDccExecutionAuthorized } from "./dcc-execution-guard.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";
import { writeDeterministicJson } from "./workspace.js";

export interface CoronaMaterialAppearanceExecutionConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  processTimeoutMs: number;
  threeDsMaxInstallationPath: string | null;
  allowCompatibilityVersionForSpike: boolean;
  allowDccExecution: boolean;
}

export interface CoronaMaterialAppearanceExecutionResult {
  status: "PASS" | "FAILED" | "BLOCKED";
  error: { code: string; message: string } | null;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  process: ControlledProcessResult | null;
  plan: CoronaExecutionPlanV02 | null;
  evidence: CoronaMaterialAppearanceEvidence | null;
}

interface ScriptResult {
  status: "PASS" | "FAILED";
  failureCode?: string;
  message?: string;
  renderer?: Record<string, unknown>;
  dcc?: Record<string, unknown>;
  safeScene?: Record<string, unknown>;
  materials?: unknown;
  materialAssignments?: unknown;
  deduplication?: Record<string, unknown>;
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
    ...(asRecord(record.safeScene)
      ? { safeScene: asRecord(record.safeScene) as Record<string, unknown> }
      : {}),
    ...(record.materials !== undefined ? { materials: record.materials } : {}),
    ...(record.materialAssignments !== undefined
      ? { materialAssignments: record.materialAssignments }
      : {}),
    ...(asRecord(record.deduplication)
      ? { deduplication: asRecord(record.deduplication) as Record<string, unknown> }
      : {}),
  };
}

function batchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}

function fail(
  code: string,
  message: string,
  dcc: ThreeDsMaxDiscoveryResult | null,
  compatibilityMode: boolean,
  plan: CoronaExecutionPlanV02 | null,
  process: ControlledProcessResult | null = null,
): CoronaMaterialAppearanceExecutionResult {
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
  return (
    process.stdout.match(/Product version:\s+3ds Max\s+(20\d{2}(?:\.\d+)?)/iu)?.[1] ??
    stringField(script.dcc?.version)
  );
}

function buildEvidence(
  script: ScriptResult,
  dccVersion: string,
): CoronaMaterialAppearanceEvidence | null {
  const evidence: CoronaMaterialAppearanceEvidence = {
    evidenceVersion: "0.1.0",
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
    safeScene: script.safeScene,
    materials: script.materials,
    materialAssignments: script.materialAssignments,
    deduplication: script.deduplication,
    status: "PASS",
  };
  return validateCoronaMaterialAppearanceEvidence(evidence).ok ? evidence : null;
}

/**
 * Realizes a canonical Corona execution plan v0.2 (SceneSpec v0.3 material
 * appearance) in a fresh Safe-Scene 3ds Max Batch process and observes the
 * actual native Corona Physical Material properties. This is a capability
 * proof: no render call is made and no scene is saved.
 */
export async function executeCoronaMaterialAppearance({
  config,
  sceneSpec,
  renderJob,
  authorizeDccExecution,
  executionEnvironment = process.env,
}: {
  config: CoronaMaterialAppearanceExecutionConfig;
  sceneSpec: Record<string, unknown>;
  renderJob: unknown;
  authorizeDccExecution: boolean;
  executionEnvironment?: NodeJS.ProcessEnv;
}): Promise<CoronaMaterialAppearanceExecutionResult> {
  let plan: CoronaExecutionPlanV02;
  try {
    plan = new CoronaRendererAdapter().compileCanonicalMaterialAppearance(sceneSpec, renderJob);
  } catch (error) {
    const code =
      error instanceof CoronaAdapterCompileError ? error.code : "CORONA_EXECUTION_PLAN_INVALID";
    return fail(code, error instanceof Error ? error.message : String(error), null, false, null);
  }
  if (!validateCoronaExecutionPlanV02(plan).ok) {
    return fail(
      "CORONA_EXECUTION_PLAN_INVALID",
      "Pure Corona adapter produced an invalid trusted plan v0.2",
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
        message: "Corona material appearance requires allowDccExecution=true and DCC authorization",
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
  const workspace = mkdtempSync(join(config.workspaceRoot, "corona-material-appearance-"));
  const planPath = join(workspace, "corona-execution-plan.json");
  const resultPath = join(workspace, "material-appearance-result.json");
  writeDeterministicJson(planPath, plan);

  try {
    const dccProcess = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(
        resolve(config.repositoryRoot, "tools/3ds-max/python/render_corona_material_appearance.py"),
      ),
      cwd: dcc.installationPath ?? config.repositoryRoot,
      timeoutMs: config.processTimeoutMs,
      env: buildDccChildEnvironment({
        parentEnvironment: executionEnvironment,
        overrides: {
          AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE:
            executionEnvironment.AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE,
          AI_ARCHVIZ_MATERIAL_APPEARANCE_PLAN_PATH: planPath,
          AI_ARCHVIZ_MATERIAL_APPEARANCE_RESULT_PATH: resultPath,
        },
      }),
      outputEncoding: "utf16le",
    });
    if (dccProcess.errorCode === "PROCESS_TIMEOUT") {
      return fail(
        "PROCESS_TIMEOUT",
        "Corona material appearance exceeded worker timeout",
        dcc,
        compatibilityMode,
        plan,
        dccProcess,
      );
    }
    if (!existsSync(resultPath)) {
      return fail(
        dccProcess.errorCode ?? "CORONA_RENDER_FAILED",
        "Material appearance runner produced no result",
        dcc,
        compatibilityMode,
        plan,
        dccProcess,
      );
    }
    const script = parseScriptResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (!script) {
      return fail(
        "MATERIAL_APPEARANCE_RUNNER_RESULT_INVALID",
        "Material appearance runner result is malformed",
        dcc,
        compatibilityMode,
        plan,
        dccProcess,
      );
    }
    if (script.status !== "PASS") {
      return fail(
        script.failureCode ?? dccProcess.errorCode ?? "CORONA_RENDER_FAILED",
        script.message ?? "Material appearance runner failed",
        dcc,
        compatibilityMode,
        plan,
        dccProcess,
      );
    }
    if (dccProcess.errorCode !== null) {
      return fail(
        dccProcess.errorCode,
        "Material appearance process exited abnormally",
        dcc,
        compatibilityMode,
        plan,
        dccProcess,
      );
    }
    const dccVersion = exactDccVersion(script, dccProcess);
    if (!dccVersion) {
      return fail(
        "DCC_VERSION_UNAVAILABLE",
        "Material appearance runner did not report a product version",
        dcc,
        compatibilityMode,
        plan,
        dccProcess,
      );
    }
    const evidence = buildEvidence(script, dccVersion);
    if (!evidence) {
      return fail(
        "MATERIAL_APPEARANCE_EVIDENCE_INVALID",
        "Material appearance evidence failed schema validation",
        dcc,
        compatibilityMode,
        plan,
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
      evidence,
    };
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
