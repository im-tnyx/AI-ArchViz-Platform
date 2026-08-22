/**
 * Autodesk-documented non-interactive batch flags. 3dsmaxbatch.exe itself is
 * the supported headless launcher; `-silent` is a 3dsmax.exe flag and must
 * not be passed to the batch executable.
 */
export function threeDsMaxBatchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}
