import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type RenderEvidence,
  validateRenderEvidence,
  validateRenderJob,
} from "@ai-archviz/worker-contracts";
import { isDccExecutionAuthorized } from "./dcc-execution-guard.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";
import { writeDeterministicJson } from "./workspace.js";

export const coronaBaselineResolution = { width: 320, height: 240 } as const;
export const coronaBaselinePassLimit = 4;
export const coronaBaselineCameraId = "camera_corona_baseline";
export const coronaBaselineMaterialTargetId = "asset_corona_baseline_subject";
export const coronaBaselineLightId = "light_corona_baseline";

export interface CoronaBaselineConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  processTimeoutMs: number;
  threeDsMaxInstallationPath: string | null;
  allowCompatibilityVersionForSpike: boolean;
  allowDccExecution: boolean;
}

export interface CoronaRendererClassMetadata {
  className: string;
  normalizedName: string;
}

export type CoronaRendererSelection =
  | { status: "AVAILABLE"; className: string }
  | { status: "CORONA_NOT_FOUND"; candidates: string[] }
  | { status: "CORONA_RENDERER_AMBIGUOUS"; candidates: string[] };

export interface CoronaBaselineResult {
  status: "PASS" | "FAILED" | "BLOCKED";
  error: { code: string; message: string } | null;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  process: ControlledProcessResult | null;
  evidence: RenderEvidence | null;
}

interface ScriptResult {
  status: "PASS" | "FAILED";
  failureCode?: string;
  message?: string;
  renderer?: { className?: string; version?: string | null };
  dcc?: { version?: string; compatibilityMode?: boolean };
  camera?: { logicalId?: string; className?: string };
  material?: { className?: string; baseColorRgb?: number[]; targetLogicalId?: string };
  light?: { logicalId?: string; className?: string; strategy?: string };
  termination?: { type?: string; value?: number };
  resolution?: { width?: number; height?: number };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseScriptResult(value: unknown): ScriptResult | null {
  const record = asRecord(value);
  if (!record || (record.status !== "PASS" && record.status !== "FAILED")) return null;
  const parsed: ScriptResult = { status: record.status };
  if (typeof record.failureCode === "string") parsed.failureCode = record.failureCode;
  if (typeof record.message === "string") parsed.message = record.message;
  const renderer = asRecord(record.renderer);
  if (renderer)
    parsed.renderer = {
      ...(typeof renderer.className === "string" ? { className: renderer.className } : {}),
      ...(typeof renderer.version === "string" || renderer.version === null
        ? { version: renderer.version }
        : {}),
    };
  const dcc = asRecord(record.dcc);
  if (dcc)
    parsed.dcc = {
      ...(typeof dcc.version === "string" ? { version: dcc.version } : {}),
      ...(typeof dcc.compatibilityMode === "boolean"
        ? { compatibilityMode: dcc.compatibilityMode }
        : {}),
    };
  const camera = asRecord(record.camera);
  if (camera)
    parsed.camera = {
      ...(typeof camera.logicalId === "string" ? { logicalId: camera.logicalId } : {}),
      ...(typeof camera.className === "string" ? { className: camera.className } : {}),
    };
  const material = asRecord(record.material);
  if (material)
    parsed.material = {
      ...(typeof material.className === "string" ? { className: material.className } : {}),
      ...(Array.isArray(material.baseColorRgb) ? { baseColorRgb: material.baseColorRgb } : {}),
      ...(typeof material.targetLogicalId === "string"
        ? { targetLogicalId: material.targetLogicalId }
        : {}),
    };
  const light = asRecord(record.light);
  if (light)
    parsed.light = {
      ...(typeof light.logicalId === "string" ? { logicalId: light.logicalId } : {}),
      ...(typeof light.className === "string" ? { className: light.className } : {}),
      ...(typeof light.strategy === "string" ? { strategy: light.strategy } : {}),
    };
  const termination = asRecord(record.termination);
  if (termination)
    parsed.termination = {
      ...(typeof termination.type === "string" ? { type: termination.type } : {}),
      ...(typeof termination.value === "number" ? { value: termination.value } : {}),
    };
  const resolution = asRecord(record.resolution);
  if (resolution)
    parsed.resolution = {
      ...(typeof resolution.width === "number" ? { width: resolution.width } : {}),
      ...(typeof resolution.height === "number" ? { height: resolution.height } : {}),
    };
  return parsed;
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function isPng(path: string, expected: { width: number; height: number }): boolean {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size <= 0) return false;
  const bytes = readFileSync(path);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((value, index) => bytes[index] !== value)) return false;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width === expected.width && height === expected.height;
}

function batchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}

function failure(
  code: string,
  message: string,
  dcc: ThreeDsMaxDiscoveryResult | null,
  compatibilityMode: boolean,
  process: ControlledProcessResult | null = null,
): CoronaBaselineResult {
  return {
    status: "FAILED",
    error: { code, message },
    dcc,
    compatibilityMode,
    process,
    evidence: null,
  };
}

/** Normalizes runtime-provided class metadata without treating an array position as identity. */
export function normalizeCoronaRendererClassMetadata(
  value: unknown,
): CoronaRendererClassMetadata | null {
  if (typeof value !== "string") return null;
  const className = value.trim().replace(/^#/u, "");
  if (!className) return null;
  return {
    className,
    normalizedName: className.toLowerCase().replace(/[^a-z0-9]/gu, ""),
  };
}

/**
 * RendererClass APIs provide installed classes in a machine-specific order.
 * Corona candidates are selected only by normalized runtime class metadata;
 * more than one candidate fails closed rather than choosing the first item.
 */
export function selectCoronaRendererClass(values: readonly unknown[]): CoronaRendererSelection {
  const candidates = values
    .map(normalizeCoronaRendererClassMetadata)
    .filter((metadata): metadata is CoronaRendererClassMetadata => metadata !== null)
    .filter((metadata) => metadata.normalizedName.includes("corona"))
    .map((metadata) => metadata.className)
    .sort((left, right) => left.localeCompare(right));
  if (candidates.length === 0) return { status: "CORONA_NOT_FOUND", candidates };
  if (candidates.length > 1) return { status: "CORONA_RENDERER_AMBIGUOUS", candidates };
  return { status: "AVAILABLE", className: candidates[0] as string };
}

export function isWorkerControlledRenderOutput(workspaceRoot: string, outputPath: string): boolean {
  return (
    resolve(outputPath) === resolve(workspaceRoot, "render", "baseline.png") &&
    !outputPath.includes("..")
  );
}

export function isFiniteCoronaBaselinePolicy(job: unknown): boolean {
  const validation = validateRenderJob(job);
  if (!validation.ok) return false;
  const renderJob = validation.value as Record<string, unknown>;
  const resolution = asRecord(renderJob.resolution);
  return (
    renderJob.engine === "corona" &&
    renderJob.mode === "preview" &&
    resolution?.width === coronaBaselineResolution.width &&
    resolution.height === coronaBaselineResolution.height
  );
}

function buildEvidence(
  script: ScriptResult,
  outputPath: string,
  observedDccVersion: string,
): RenderEvidence | null {
  const renderer = script.renderer;
  const dcc = script.dcc;
  const camera = script.camera;
  const material = script.material;
  const light = script.light;
  const termination = script.termination;
  const resolution = script.resolution;
  const baseColorRgb = material?.baseColorRgb;
  const evidence: RenderEvidence = {
    renderEvidenceVersion: "0.1.0",
    renderer: {
      engine: "corona",
      className: stringField(renderer as Record<string, unknown> | undefined, "className"),
      version: renderer?.version ?? null,
    },
    dcc: {
      product: "3ds_max",
      version: observedDccVersion,
      compatibilityMode: dcc?.compatibilityMode === true,
    },
    camera: {
      logicalId: stringField(camera as Record<string, unknown> | undefined, "logicalId"),
      className: stringField(camera as Record<string, unknown> | undefined, "className"),
    },
    material: {
      className: stringField(material as Record<string, unknown> | undefined, "className"),
      baseColorRgb,
      targetLogicalId: stringField(
        material as Record<string, unknown> | undefined,
        "targetLogicalId",
      ),
    },
    light: {
      logicalId: stringField(light as Record<string, unknown> | undefined, "logicalId"),
      className: stringField(light as Record<string, unknown> | undefined, "className"),
      strategy: stringField(light as Record<string, unknown> | undefined, "strategy"),
    },
    resolution: {
      width: numberField(resolution as Record<string, unknown> | undefined, "width"),
      height: numberField(resolution as Record<string, unknown> | undefined, "height"),
    },
    termination: {
      type: stringField(termination as Record<string, unknown> | undefined, "type"),
      value: numberField(termination as Record<string, unknown> | undefined, "value"),
    },
    output: {
      format: "png",
      byteLength: statSync(outputPath).size,
      sha256: sha256File(outputPath),
    },
    status: "PASS",
  };
  return validateRenderEvidence(evidence).ok ? evidence : null;
}

function exactDccVersionFromProcess(
  script: ScriptResult,
  process: ControlledProcessResult,
): string | null {
  const productVersion = process.stdout.match(
    /Product version:\s+3ds Max\s+(20\d{2}(?:\.\d+)?)/iu,
  )?.[1];
  return (
    productVersion ?? stringField(script.dcc as Record<string, unknown> | undefined, "version")
  );
}

export async function renderCoronaBaseline({
  config,
  job,
  authorizeDccExecution,
}: {
  config: CoronaBaselineConfig;
  job: unknown;
  authorizeDccExecution: boolean;
}): Promise<CoronaBaselineResult> {
  if (!isFiniteCoronaBaselinePolicy(job)) {
    return {
      status: "BLOCKED",
      error: {
        code: "RENDER_JOB_INVALID",
        message: "Render job violates fixed Corona baseline policy",
      },
      dcc: null,
      compatibilityMode: false,
      process: null,
      evidence: null,
    };
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
        message: "Corona baseline requires allowDccExecution=true and DCC authorization",
      },
      dcc: null,
      compatibilityMode: false,
      process: null,
      evidence: null,
    };
  }

  const dcc = await discoverThreeDsMax({ installationOverride: config.threeDsMaxInstallationPath });
  if (dcc.status === "NOT_FOUND" || !dcc.batchExecutablePath) {
    return failure("DCC_NOT_FOUND", "3ds Max Batch is unavailable", dcc, false);
  }
  const compatibilityMode = dcc.version !== "2026";
  if (compatibilityMode && !config.allowCompatibilityVersionForSpike) {
    return failure("DCC_VERSION_UNSUPPORTED", "3ds Max compatibility mode is disabled", dcc, true);
  }

  mkdirSync(config.workspaceRoot, { recursive: true });
  const workspace = mkdtempSync(join(config.workspaceRoot, "corona-baseline-"));
  const renderDirectory = join(workspace, "render");
  const outputPath = join(renderDirectory, "baseline.png");
  const resultPath = join(workspace, "render-result.json");
  const jobPath = join(workspace, "render-job.json");
  mkdirSync(renderDirectory, { recursive: true });
  writeDeterministicJson(jobPath, job);

  try {
    if (!isWorkerControlledRenderOutput(workspace, outputPath)) {
      return failure(
        "RENDER_OUTPUT_PATH_INVALID",
        "Render output path escaped worker control",
        dcc,
        compatibilityMode,
      );
    }
    const controlledProcess = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(
        resolve(config.repositoryRoot, "tools/3ds-max/python/render_corona_baseline.py"),
      ),
      cwd: dcc.installationPath ?? config.repositoryRoot,
      timeoutMs: config.processTimeoutMs,
      env: {
        ...process.env,
        AI_ARCHVIZ_CORONA_RENDER_JOB_PATH: jobPath,
        AI_ARCHVIZ_CORONA_RENDER_OUTPUT_PATH: outputPath,
        AI_ARCHVIZ_CORONA_RENDER_RESULT_PATH: resultPath,
      },
      outputEncoding: "utf16le",
    });
    if (controlledProcess.errorCode === "PROCESS_TIMEOUT") {
      return failure(
        "PROCESS_TIMEOUT",
        "Corona baseline process exceeded the worker timeout",
        dcc,
        compatibilityMode,
        controlledProcess,
      );
    }
    if (!existsSync(resultPath)) {
      return failure(
        controlledProcess.errorCode ?? "CORONA_RENDER_FAILED",
        "Corona runner produced no result",
        dcc,
        compatibilityMode,
        controlledProcess,
      );
    }
    const script = parseScriptResult(JSON.parse(readFileSync(resultPath, "utf8")));
    if (!script) {
      return failure(
        "CORONA_RENDER_RESULT_INVALID",
        "Corona runner result is malformed",
        dcc,
        compatibilityMode,
        controlledProcess,
      );
    }
    if (script.status !== "PASS") {
      return failure(
        script.failureCode ?? controlledProcess.errorCode ?? "CORONA_RENDER_FAILED",
        script.message ?? "Corona render did not complete",
        dcc,
        compatibilityMode,
        controlledProcess,
      );
    }
    if (controlledProcess.errorCode !== null || !isPng(outputPath, coronaBaselineResolution)) {
      return failure(
        controlledProcess.errorCode ?? "RENDER_OUTPUT_INVALID",
        "Corona output is not the required non-empty 320x240 PNG",
        dcc,
        compatibilityMode,
        controlledProcess,
      );
    }
    const observedDccVersion = exactDccVersionFromProcess(script, controlledProcess);
    if (!observedDccVersion) {
      return failure(
        "DCC_VERSION_UNAVAILABLE",
        "Corona runner did not report a 3ds Max product version",
        dcc,
        compatibilityMode,
        controlledProcess,
      );
    }
    const evidence = buildEvidence(script, outputPath, observedDccVersion);
    if (!evidence) {
      return failure(
        "RENDER_EVIDENCE_INVALID",
        "Normalized render evidence did not validate",
        dcc,
        compatibilityMode,
        controlledProcess,
      );
    }
    return {
      status: "PASS",
      error: null,
      dcc,
      compatibilityMode,
      process: controlledProcess,
      evidence,
    };
  } catch (error) {
    return failure(
      "CORONA_RENDER_FAILED",
      error instanceof Error ? error.message : String(error),
      dcc,
      compatibilityMode,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
