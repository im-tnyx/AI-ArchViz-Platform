import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { WorkerError } from "./errors.js";
import { resolveWithinRoot } from "./paths.js";

export interface WorkerConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  processTimeoutMs: number;
  threeDsMaxInstallationPath: string | null;
}

interface ConfigFile {
  workspaceRoot?: unknown;
  processTimeoutMs?: unknown;
  threeDsMaxInstallationPath?: unknown;
}

const allowedKeys = new Set(["workspaceRoot", "processTimeoutMs", "threeDsMaxInstallationPath"]);

export function loadWorkerConfig(
  repositoryRoot: string,
  explicitConfigPath = process.env.AI_ARCHVIZ_WORKER_CONFIG,
): WorkerConfig {
  const defaultPath = resolve(repositoryRoot, "worker.config.json");
  const configPath = explicitConfigPath ? resolve(explicitConfigPath) : defaultPath;
  const mustExist = explicitConfigPath !== undefined;

  let raw: ConfigFile = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new WorkerError("CONFIG_INVALID", "Worker config is not valid JSON", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new WorkerError("CONFIG_INVALID", "Worker config must be a JSON object");
    }
    const parsedRecord = parsed as Record<string, unknown>;
    const unexpected = Object.keys(parsedRecord).filter((key) => !allowedKeys.has(key));
    if (unexpected.length > 0) {
      throw new WorkerError("CONFIG_INVALID", "Worker config contains unknown fields", {
        fields: unexpected.sort(),
      });
    }
    raw = parsedRecord;
  } else if (mustExist) {
    throw new WorkerError("CONFIG_INVALID", "Explicit worker config file does not exist");
  }

  const workspaceRelative = raw.workspaceRoot ?? ".workspace";
  if (typeof workspaceRelative !== "string") {
    throw new WorkerError("CONFIG_INVALID", "workspaceRoot must be a relative string");
  }

  const timeout = raw.processTimeoutMs ?? 120_000;
  if (!Number.isInteger(timeout) || Number(timeout) < 1_000 || Number(timeout) > 3_600_000) {
    throw new WorkerError(
      "CONFIG_INVALID",
      "processTimeoutMs must be an integer between 1000 and 3600000",
    );
  }

  const installation = raw.threeDsMaxInstallationPath ?? null;
  if (installation !== null && (typeof installation !== "string" || !isAbsolute(installation))) {
    throw new WorkerError(
      "CONFIG_INVALID",
      "threeDsMaxInstallationPath must be null or an absolute path",
    );
  }

  return {
    repositoryRoot: resolve(repositoryRoot),
    workspaceRoot: resolveWithinRoot(repositoryRoot, workspaceRelative),
    processTimeoutMs: Number(timeout),
    threeDsMaxInstallationPath: installation,
  };
}
