import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const supportedVersion = "2026";
const registryRoot = "HKLM\\SOFTWARE\\Autodesk\\3dsMax";

export type DccSupportStatus = "SUPPORTED" | "UNSUPPORTED" | "NOT_FOUND";
export type DiscoverySource = "config" | "registry" | "default_path" | "none";

export interface RegistryInstallation {
  registryVersion: string;
  version: string;
  installationPath: string;
}

export interface ThreeDsMaxDiscoveryResult {
  id: "3ds_max";
  status: DccSupportStatus;
  source: DiscoverySource;
  supportedVersion: string;
  version: string | null;
  installationPath: string | null;
  executablePath: string | null;
  batchExecutablePath: string | null;
  executableAvailable: boolean;
  batchExecutableAvailable: boolean;
}

export interface DiscoveryOptions {
  installationOverride?: string | null;
  platform?: NodeJS.Platform;
  registryInstallations?: RegistryInstallation[];
  pathExists?: (path: string) => boolean;
}

function inferVersion(text: string): string | null {
  const year = text.match(/(?:3ds Max\s+|^)(20\d{2})(?:\D|$)/i)?.[1];
  return year ?? null;
}

function registryVersionToYear(version: string): string {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? String(major + 1998) : version;
}

async function queryRegistryValue(key: string, value: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("reg.exe", ["query", key, "/v", value], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const line = stdout
      .split(/\r?\n/u)
      .find((entry) => entry.trimStart().toLowerCase().startsWith(value.toLowerCase()));
    return line?.match(/REG_\w+\s+(.+)$/u)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function readThreeDsMaxRegistry(): Promise<RegistryInstallation[]> {
  if (process.platform !== "win32") return [];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("reg.exe", ["query", registryRoot], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    }));
  } catch {
    return [];
  }

  const versions = Array.from(
    new Set(
      stdout
        .split(/\r?\n/u)
        .map((line) => line.match(/\\3dsMax\\(\d+\.\d+)\s*$/u)?.[1])
        .filter((version): version is string => version !== undefined),
    ),
  );

  const installations = await Promise.all(
    versions.map(async (registryVersion) => {
      const key = `${registryRoot}\\${registryVersion}`;
      const [installationPath, productName] = await Promise.all([
        queryRegistryValue(key, "Installdir"),
        queryRegistryValue(key, "ProductName"),
      ]);
      if (!installationPath) return null;
      return {
        registryVersion,
        version: inferVersion(productName ?? "") ?? registryVersionToYear(registryVersion),
        installationPath,
      };
    }),
  );

  return installations.filter(
    (installation): installation is RegistryInstallation => installation !== null,
  );
}

function inspectInstallation(
  installationPath: string,
  version: string | null,
  source: DiscoverySource,
  pathExists: (path: string) => boolean,
): ThreeDsMaxDiscoveryResult | null {
  const normalizedPath = normalize(installationPath);
  const executablePath = join(normalizedPath, "3dsmax.exe");
  const batchExecutablePath = join(normalizedPath, "3dsmaxbatch.exe");
  const executableAvailable = pathExists(executablePath);
  const batchExecutableAvailable = pathExists(batchExecutablePath);
  if (!executableAvailable && !batchExecutableAvailable) return null;
  const detectedVersion = version ?? inferVersion(normalizedPath);
  return {
    id: "3ds_max",
    status: detectedVersion === supportedVersion ? "SUPPORTED" : "UNSUPPORTED",
    source,
    supportedVersion,
    version: detectedVersion,
    installationPath: normalizedPath,
    executablePath: executableAvailable ? executablePath : null,
    batchExecutablePath: batchExecutableAvailable ? batchExecutablePath : null,
    executableAvailable,
    batchExecutableAvailable,
  };
}

export async function discoverThreeDsMax(
  options: DiscoveryOptions = {},
): Promise<ThreeDsMaxDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? existsSync;
  if (platform !== "win32") return notFound();

  if (options.installationOverride) {
    return (
      inspectInstallation(
        options.installationOverride,
        inferVersion(options.installationOverride),
        "config",
        pathExists,
      ) ?? notFound("config")
    );
  }

  const registryInstallations = options.registryInstallations ?? (await readThreeDsMaxRegistry());
  const registryCandidates = registryInstallations
    .map((installation) =>
      inspectInstallation(
        installation.installationPath,
        installation.version,
        "registry",
        pathExists,
      ),
    )
    .filter((candidate): candidate is ThreeDsMaxDiscoveryResult => candidate !== null);
  const registryMatch = chooseCandidate(registryCandidates);
  if (registryMatch) return registryMatch;

  const defaultCandidates = ["2026", "2025", "2024", "2023", "2022"]
    .map((version) =>
      inspectInstallation(
        `C:\\Program Files\\Autodesk\\3ds Max ${version}`,
        version,
        "default_path",
        pathExists,
      ),
    )
    .filter((candidate): candidate is ThreeDsMaxDiscoveryResult => candidate !== null);
  return chooseCandidate(defaultCandidates) ?? notFound();
}

function chooseCandidate(
  candidates: ThreeDsMaxDiscoveryResult[],
): ThreeDsMaxDiscoveryResult | null {
  return (
    candidates.find((candidate) => candidate.version === supportedVersion) ??
    candidates.sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0))[0] ??
    null
  );
}

function notFound(source: DiscoverySource = "none"): ThreeDsMaxDiscoveryResult {
  return {
    id: "3ds_max",
    status: "NOT_FOUND",
    source,
    supportedVersion,
    version: null,
    installationPath: null,
    executablePath: null,
    batchExecutablePath: null,
    executableAvailable: false,
    batchExecutableAvailable: false,
  };
}
