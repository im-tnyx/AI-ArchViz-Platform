#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  type JobEnvelope,
  validateJobEnvelope,
  verifyJobHashes,
} from "@ai-archviz/worker-contracts";
import { loadWorkerConfig } from "./config.js";
import { discoverThreeDsMax } from "./discovery.js";
import { WorkerError } from "./errors.js";
import { buildGoldenScene } from "./golden-build.js";
import { inspectWorkerHealth } from "./health.js";
import { readLedger } from "./ledger.js";
import { logStructured } from "./logger.js";
import { runThreeDsMaxProbe } from "./probe.js";
import { applySceneChangeSet } from "./revision.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface CliResult {
  exitCode: number;
  output: unknown;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

async function execute(argv: string[]): Promise<CliResult> {
  const [command, ...args] = argv;
  switch (command) {
    case "health": {
      const config = loadWorkerConfig(repositoryRoot);
      return { exitCode: 0, output: await inspectWorkerHealth(config) };
    }
    case "inspect-3ds-max": {
      const config = loadWorkerConfig(repositoryRoot);
      return {
        exitCode: 0,
        output: await discoverThreeDsMax({
          installationOverride: config.threeDsMaxInstallationPath,
        }),
      };
    }
    case "probe-3ds-max": {
      const config = loadWorkerConfig(repositoryRoot);
      const result = await runThreeDsMaxProbe(config);
      return {
        exitCode: result.pythonProbe?.status === "SUCCESS" ? 0 : 1,
        output: result,
      };
    }
    case "build-scene": {
      const [jobPath] = args;
      if (!jobPath) return usage("build-scene requires a Job Envelope path");
      const config = loadWorkerConfig(repositoryRoot);
      const result = await buildGoldenScene(config, jobPath);
      return { exitCode: result.status === "SUCCESS" ? 0 : 1, output: result };
    }
    case "inspect-ledger": {
      const [idempotencyKey] = args;
      if (!idempotencyKey) return usage("inspect-ledger requires an idempotency key");
      const config = loadWorkerConfig(repositoryRoot);
      const record = readLedger(config.workspaceRoot, idempotencyKey);
      return {
        exitCode: record ? 0 : 1,
        output: record ?? { ok: false, errorCode: "LEDGER_ENTRY_NOT_FOUND" },
      };
    }
    case "apply-change-set": {
      const [baseJobPath, changeSetPath] = args;
      if (!baseJobPath || !changeSetPath) {
        return usage("apply-change-set requires a base Job Envelope and SceneChangeSet path");
      }
      const config = loadWorkerConfig(repositoryRoot);
      const result = await applySceneChangeSet(config, baseJobPath, changeSetPath, {
        ...(process.env.AI_ARCHVIZ_REVISION_JOB_ID
          ? { jobId: process.env.AI_ARCHVIZ_REVISION_JOB_ID }
          : {}),
      });
      return { exitCode: result.status === "SUCCESS" ? 0 : 1, output: result };
    }
    case "validate-scene": {
      const [path] = args;
      if (!path) return usage("validate-scene requires a JSON path");
      const result = validateSceneSpec(readJson(path));
      return {
        exitCode: result.ok ? 0 : 1,
        output: result.ok ? { ok: true, path: resolve(path) } : result,
      };
    }
    case "validate-job": {
      const [path] = args;
      if (!path) return usage("validate-job requires a JSON path");
      const result = validateJobEnvelope(readJson(path));
      return {
        exitCode: result.ok ? 0 : 1,
        output: result.ok ? { ok: true, path: resolve(path) } : result,
      };
    }
    case "verify-hashes": {
      const [jobPath, scenePath, manifestPath] = args;
      if (!jobPath || !scenePath || !manifestPath) {
        return usage("verify-hashes requires job, SceneSpec, and expected-manifest paths");
      }
      const validated = validateJobEnvelope(readJson(jobPath));
      if (!validated.ok) return { exitCode: 1, output: validated };
      const result = verifyJobHashes(
        validated.value as JobEnvelope,
        readJson(scenePath),
        readJson(manifestPath),
      );
      return { exitCode: result.ok ? 0 : 1, output: result };
    }
    default:
      return usage();
  }
}

function usage(error?: string): CliResult {
  return {
    exitCode: 2,
    output: {
      ok: false,
      ...(error ? { error } : {}),
      commands: [
        "health",
        "inspect-3ds-max",
        "probe-3ds-max",
        "build-scene <job-envelope-path>",
        "inspect-ledger <idempotency-key>",
        "apply-change-set <base-job> <scene-change-set>",
        "validate-scene <path>",
        "validate-job <path>",
        "verify-hashes <job> <scene-spec> <expected-manifest>",
      ],
    },
  };
}

try {
  logStructured({ level: "info", component: "worker-cli", event: "command_started" });
  const result = await execute(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  const workerError = error instanceof WorkerError ? error : null;
  const errorCode = workerError?.code ?? "CONFIG_INVALID";
  logStructured({
    level: "error",
    component: "worker-cli",
    event: "command_failed",
    errorCode,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: false,
        errorCode,
        message: error instanceof Error ? error.message : String(error),
        ...(workerError?.details ? { details: workerError.details } : {}),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
