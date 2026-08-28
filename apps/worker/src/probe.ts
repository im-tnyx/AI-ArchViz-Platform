import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WorkerConfig } from "./config.js";
import { threeDsMaxBatchArguments } from "./dcc-batch.js";
import { buildDccChildEnvironment } from "./dcc-environment.js";
import { isDccExecutionAuthorized } from "./dcc-execution-guard.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";

export interface PythonProbePayload {
  probeVersion: string;
  status: "SUCCESS" | "FAILED";
  dcc: "3ds_max";
  dccVersion: string | null;
  pythonAvailable: boolean;
  pymxsAvailable: boolean;
  unitState: Record<string, unknown> | null;
  errorCode: "PYTHON_PROBE_FAILED" | "PYMXS_UNAVAILABLE" | null;
  message: string | null;
}

export interface ProbeResult {
  workerVersion: "0.1.0";
  platform: NodeJS.Platform;
  status: "SUCCESS" | "UNSUPPORTED" | "FAILED" | "BLOCKED";
  dcc: ThreeDsMaxDiscoveryResult | null;
  pythonProbe: PythonProbePayload | null;
  process: ControlledProcessResult | null;
  errorCode:
    | "DCC_NOT_FOUND"
    | "DCC_BATCH_NOT_FOUND"
    | "DCC_EXECUTION_DISABLED"
    | "DCC_LAUNCH_FAILED"
    | "PYTHON_PROBE_FAILED"
    | "PYMXS_UNAVAILABLE"
    | "PROCESS_TIMEOUT"
    | "PROCESS_EXIT_NONZERO"
    | null;
}

export async function runThreeDsMaxProbe(
  config: WorkerConfig,
  options: { authorizeDccExecution?: boolean } = {},
): Promise<ProbeResult> {
  if (
    !isDccExecutionAuthorized({
      allowDccExecution: config.allowDccExecution,
      authorizeDccExecution: options.authorizeDccExecution === true,
    })
  ) {
    return blocked();
  }
  const dcc = await discoverThreeDsMax({
    installationOverride: config.threeDsMaxInstallationPath,
  });
  if (dcc.status === "NOT_FOUND") return failed(dcc, "DCC_NOT_FOUND");
  if (!dcc.batchExecutablePath || !dcc.batchExecutableAvailable) {
    return failed(dcc, "DCC_BATCH_NOT_FOUND");
  }
  const scriptPath = join(config.repositoryRoot, "tools", "3ds-max", "python", "health_probe.py");
  const probeDirectory = join(config.workspaceRoot, "health", randomUUID());
  const resultPath = join(probeDirectory, "probe-result.json");
  mkdirSync(probeDirectory, { recursive: true });

  const processResult = await runControlledProcess({
    executable: dcc.batchExecutablePath,
    args: threeDsMaxBatchArguments(scriptPath),
    cwd: dcc.installationPath ?? dirname(dcc.batchExecutablePath),
    timeoutMs: config.processTimeoutMs,
    env: buildDccChildEnvironment({
      overrides: { AI_ARCHVIZ_HEALTH_RESULT_PATH: resultPath },
    }),
    outputEncoding: "utf16le",
  });

  if (processResult.errorCode) {
    return {
      workerVersion: "0.1.0",
      platform: process.platform,
      status: "FAILED",
      dcc,
      pythonProbe: null,
      process: processResult,
      errorCode: processResult.errorCode,
    };
  }

  let payload: PythonProbePayload;
  try {
    payload = JSON.parse(readFileSync(resultPath, "utf8")) as PythonProbePayload;
  } catch {
    return {
      workerVersion: "0.1.0",
      platform: process.platform,
      status: "FAILED",
      dcc,
      pythonProbe: null,
      process: processResult,
      errorCode: "PYTHON_PROBE_FAILED",
    };
  }

  const probeSucceeded =
    payload.status === "SUCCESS" && payload.pythonAvailable && payload.pymxsAvailable;
  return {
    workerVersion: "0.1.0",
    platform: process.platform,
    status: probeSucceeded ? (dcc.status === "SUPPORTED" ? "SUCCESS" : "UNSUPPORTED") : "FAILED",
    dcc,
    pythonProbe: payload,
    process: processResult,
    errorCode: probeSucceeded ? null : (payload.errorCode ?? "PYTHON_PROBE_FAILED"),
  };
}

function failed(
  dcc: ThreeDsMaxDiscoveryResult,
  errorCode: "DCC_NOT_FOUND" | "DCC_BATCH_NOT_FOUND",
): ProbeResult {
  return {
    workerVersion: "0.1.0",
    platform: process.platform,
    status: "FAILED",
    dcc,
    pythonProbe: null,
    process: null,
    errorCode,
  };
}

function blocked(): ProbeResult {
  return {
    workerVersion: "0.1.0",
    platform: process.platform,
    status: "BLOCKED",
    dcc: null,
    pythonProbe: null,
    process: null,
    errorCode: "DCC_EXECUTION_DISABLED",
  };
}
