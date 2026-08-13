import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverThreeDsMax,
  loadWorkerConfig,
  resolveWithinRoot,
  runControlledProcess,
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
    });
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
    });
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("PROCESS_TIMEOUT");
  });
});
