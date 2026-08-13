import type { WorkerConfig } from "./config.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";

export interface WorkerHealthResult {
  workerVersion: "0.1.0";
  platform: NodeJS.Platform;
  status: "SUCCESS" | "DEGRADED";
  workspaceReady: true;
  dcc: ThreeDsMaxDiscoveryResult & { pythonProbe: "NOT_RUN" };
}

export async function inspectWorkerHealth(config: WorkerConfig): Promise<WorkerHealthResult> {
  const discovery = await discoverThreeDsMax({
    installationOverride: config.threeDsMaxInstallationPath,
  });
  return {
    workerVersion: "0.1.0",
    platform: process.platform,
    status: discovery.status === "SUPPORTED" ? "SUCCESS" : "DEGRADED",
    workspaceReady: true,
    dcc: { ...discovery, pythonProbe: "NOT_RUN" },
  };
}
