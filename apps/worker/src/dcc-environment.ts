const windowsDccEnvironmentAllowlist = [
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "Path",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "HOMEDRIVE",
  "HOMEPATH",
  "ALLUSERSPROFILE",
  // Corona shares Chaos's V-Ray USD/DR startup component, which hard-requires
  // this exact variable at render time even when the assigned renderer is
  // Corona, not V-Ray. Proven by regression: removing it reproduces
  // "[V-Ray] Could not read V-Ray environment variable ... Please re-install"
  // and an empty render output in the Corona baseline and adapter suites.
  // Do not broaden this to a VRAY_* wildcard.
  "VRAY_FOR_3DSMAX2025_MAIN",
] as const;

export interface DccChildEnvironmentOptions {
  parentEnvironment?: NodeJS.ProcessEnv | undefined;
  overrides: Record<string, string | undefined>;
}

function findEnvironmentKey(
  environment: NodeJS.ProcessEnv,
  requestedKey: string,
): string | undefined {
  const normalizedKey = requestedKey.toLowerCase();
  return Object.keys(environment).find((key) => key.toLowerCase() === normalizedKey);
}

export function buildDccChildEnvironment({
  parentEnvironment = process.env,
  overrides,
}: DccChildEnvironmentOptions): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const key of windowsDccEnvironmentAllowlist) {
    const actualKey = findEnvironmentKey(parentEnvironment, key);
    const value = actualKey === undefined ? undefined : parentEnvironment[actualKey];
    if (value !== undefined) childEnvironment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) childEnvironment[key] = value;
  }
  return childEnvironment;
}

export { windowsDccEnvironmentAllowlist };
