import { isAbsolute, relative, resolve } from "node:path";
import { WorkerError } from "./errors.js";

export function resolveWithinRoot(root: string, relativePath: string): string {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new WorkerError("CONFIG_INVALID", "Path must be non-empty and repository-relative");
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const relationship = relative(resolvedRoot, resolvedPath);
  if (relationship === "" || (!relationship.startsWith("..") && !isAbsolute(relationship))) {
    return resolvedPath;
  }

  throw new WorkerError("CONFIG_INVALID", "Path escapes the approved repository root", {
    relativePath,
  });
}
