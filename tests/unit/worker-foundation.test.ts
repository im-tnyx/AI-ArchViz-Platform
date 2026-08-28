import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverThreeDsMax,
  loadWorkerConfig,
  requireDccTestApproval,
  resolveWithinRoot,
  runControlledProcess,
  threeDsMaxBatchArguments,
} from "../../apps/worker/src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("trusted local paths and config", () => {
  it("resolves a repository-relative workspace", () => {
    const root = resolve("C:/approved/repository");
    expect(resolveWithinRoot(root, ".workspace/jobs")).toBe(resolve(root, ".workspace/jobs"));
  });

  it("rejects path traversal and absolute workspace paths", () => {
    const root = resolve("C:/approved/repository");
    expect(() => resolveWithinRoot(root, "../outside")).toThrow(/escapes/u);
    expect(() => resolveWithinRoot(root, resolve("C:/outside"))).toThrow(/repository-relative/u);
  });

  it("loads a strict trusted local config", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "local-worker.json");
    writeFileSync(
      configPath,
      JSON.stringify({ workspaceRoot: ".workspace", processTimeoutMs: 5_000 }),
      "utf8",
    );
    expect(loadWorkerConfig(root, configPath)).toMatchObject({
      repositoryRoot: root,
      workspaceRoot: join(root, ".workspace"),
      processTimeoutMs: 5_000,
      threeDsMaxInstallationPath: null,
      allowCompatibilityVersionForSpike: false,
      allowDccExecution: false,
      trustedAssetRoot: null,
    });
  });

  it("accepts only an absolute trusted external asset root", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-asset-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "local-worker.json");
    writeFileSync(
      configPath,
      JSON.stringify({ trustedAssetRoot: resolve(root, "assets") }),
      "utf8",
    );
    expect(loadWorkerConfig(root, configPath).trustedAssetRoot).toBe(resolve(root, "assets"));

    writeFileSync(configPath, JSON.stringify({ trustedAssetRoot: "assets" }), "utf8");
    expect(() => loadWorkerConfig(root, configPath)).toThrow(/trustedAssetRoot/u);
  });

  it("enables compatibility mode only through explicit trusted config", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-compat-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "local-worker.json");
    writeFileSync(configPath, JSON.stringify({ allowCompatibilityVersionForSpike: true }), "utf8");
    expect(loadWorkerConfig(root, configPath).allowCompatibilityVersionForSpike).toBe(true);
  });

  it("keeps DCC execution disabled until trusted local config opts in", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-dcc-config-"));
    temporaryDirectories.push(root);
    const configPath = join(root, "local-worker.json");
    writeFileSync(configPath, JSON.stringify({ allowDccExecution: true }), "utf8");
    expect(loadWorkerConfig(root, configPath).allowDccExecution).toBe(true);

    writeFileSync(configPath, JSON.stringify({ allowDccExecution: false }), "utf8");
    expect(loadWorkerConfig(root, configPath).allowDccExecution).toBe(false);

    writeFileSync(configPath, JSON.stringify({ allowDccExecution: "yes" }), "utf8");
    expect(() => loadWorkerConfig(root, configPath)).toThrow(/allowDccExecution/u);
  });
});

describe("3ds Max batch arguments", () => {
  it("uses documented dialog and Safe Scene controls without desktop-only flags", () => {
    expect(threeDsMaxBatchArguments("trusted-runner.py")).toEqual([
      "trusted-runner.py",
      "-v",
      "2",
      "-dm",
      "on",
      "-safescene",
      "ON",
    ]);
  });

  it("requires an explicit opt-in before a DCC integration suite can launch", () => {
    expect(() => requireDccTestApproval({})).toThrow(/AI_ARCHVIZ_ALLOW_DCC_TESTS=1/u);
    expect(() => requireDccTestApproval({ AI_ARCHVIZ_ALLOW_DCC_TESTS: "1" })).not.toThrow();
  });
});

describe("3ds Max discovery", () => {
  it("returns deterministic NOT_FOUND without scanning", async () => {
    await expect(
      discoverThreeDsMax({
        platform: "win32",
        registryInstallations: [],
        pathExists: () => false,
      }),
    ).resolves.toMatchObject({
      id: "3ds_max",
      status: "NOT_FOUND",
      source: "none",
      supportedVersion: "2026",
    });
  });

  it("prefers and marks 2026 as supported", async () => {
    const installation = normalize("C:/Program Files/Autodesk/3ds Max 2026");
    await expect(
      discoverThreeDsMax({
        platform: "win32",
        installationOverride: installation,
        pathExists: (path) =>
          path === join(installation, "3dsmax.exe") ||
          path === join(installation, "3dsmaxbatch.exe"),
      }),
    ).resolves.toMatchObject({
      status: "SUPPORTED",
      source: "config",
      version: "2026",
      executableAvailable: true,
      batchExecutableAvailable: true,
    });
  });

  it("reports another discovered version as unsupported", async () => {
    const installation = normalize("C:/Program Files/Autodesk/3ds Max 2025");
    await expect(
      discoverThreeDsMax({
        platform: "win32",
        registryInstallations: [
          { registryVersion: "27.0", version: "2025", installationPath: installation },
        ],
        pathExists: (path) => path.endsWith("3dsmax.exe") || path.endsWith("3dsmaxbatch.exe"),
      }),
    ).resolves.toMatchObject({
      status: "UNSUPPORTED",
      source: "registry",
      version: "2025",
    });
  });
});

describe("controlled process execution", () => {
  it("captures deterministic success output", async () => {
    const result = await runControlledProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('probe-ok')"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {},
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "probe-ok",
      timedOut: false,
      errorCode: null,
    });
  });

  it("decodes UTF-16LE output without embedded null characters", async () => {
    const result = await runControlledProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.from('3ds-max-probe', 'utf16le'))"],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      env: {},
      outputEncoding: "utf16le",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "3ds-max-probe",
      errorCode: null,
    });
  });

  it("times out and terminates only the owned process tree", async () => {
    const result = await runControlledProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 100,
      env: {},
    });
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("PROCESS_TIMEOUT");
  });
});
