import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

/*
 * Physical (filesystem) containment, used in addition to the lexical
 * resolveWithinRoot() check. Lexical containment alone cannot see a
 * symbolic link or Windows junction/reparse point inside the root that
 * redirects outside it. These helpers compare the filesystem realpath of
 * the trusted root with the realpath of the target (or of its nearest
 * existing ancestor), so every link type the OS resolves is covered
 * without enumerating reparse tags.
 *
 * Policy: an intermediate link is allowed only if the physical result
 * stays inside the physical root; the FINAL entry must never be a link.
 * Validation runs immediately before the read/write; a local process that
 * swaps a directory for a link between validation and access (TOCTOU) is
 * outside this local-worker trust boundary.
 */

export type PathContainmentFailure =
  | "LEXICAL_ESCAPE"
  | "NOT_FOUND"
  | "NOT_REGULAR_FILE"
  | "BROKEN_LINK_TRAVERSAL"
  | "PHYSICAL_ESCAPE"
  | "UNRESOLVABLE";

export class PathContainmentError extends Error {
  readonly reason: PathContainmentFailure;

  constructor(reason: PathContainmentFailure, message: string) {
    super(message);
    this.name = "PathContainmentError";
    this.reason = reason;
  }
}

function lexicallyWithinRoot(root: string, relativePath: string): string {
  try {
    return resolveWithinRoot(root, relativePath);
  } catch {
    throw new PathContainmentError(
      "LEXICAL_ESCAPE",
      "Path must be non-empty, relative, and lexically inside the root",
    );
  }
}

function isPhysicallyWithin(physicalRoot: string, physicalPath: string): boolean {
  const relationship = relative(physicalRoot, physicalPath);
  return (
    relationship === "" ||
    (relationship !== ".." && !relationship.startsWith(`..${sep}`) && !isAbsolute(relationship))
  );
}

function realpathOrFail(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    throw new PathContainmentError("UNRESOLVABLE", "Path cannot be resolved on the filesystem");
  }
}

function entryOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new PathContainmentError("UNRESOLVABLE", "Path cannot be inspected on the filesystem");
  }
}

/** True when an existing component between root and target is a link. */
function routeTraversesLink(root: string, target: string): boolean {
  let current = resolve(root);
  const segments = relative(current, target).split(sep).slice(0, -1);
  for (const segment of segments) {
    current = join(current, segment);
    const entry = entryOrNull(current);
    if (!entry) return false;
    if (entry.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Physical form of a possibly nonexistent path: the realpath of its nearest
 * existing ancestor plus the not-yet-existing tail (which no link can
 * redirect, because it does not exist).
 */
function physicalPathOf(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    if (entryOrNull(current)) {
      return tail.length === 0 ? realpathOrFail(current) : join(realpathOrFail(current), ...tail);
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new PathContainmentError("UNRESOLVABLE", "No existing ancestor for path");
    }
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * Resolves an existing regular file that is inside `root` both lexically and
 * physically. Returns the physical (realpath) location to read from.
 */
export function resolveExistingFileWithinRoot(root: string, relativePath: string): string {
  const lexicalPath = lexicallyWithinRoot(root, relativePath);
  const entry = entryOrNull(lexicalPath);
  if (!entry) {
    if (routeTraversesLink(root, lexicalPath)) {
      throw new PathContainmentError(
        "BROKEN_LINK_TRAVERSAL",
        "Path traverses a link whose target does not resolve",
      );
    }
    throw new PathContainmentError("NOT_FOUND", "File does not exist");
  }
  if (!entry.isFile()) {
    // A final symbolic link/junction, directory, or device is never followed.
    throw new PathContainmentError("NOT_REGULAR_FILE", "Path must name a regular file");
  }
  const physicalRoot = realpathOrFail(resolve(root));
  const physicalPath = realpathOrFail(lexicalPath);
  if (!isPhysicallyWithin(physicalRoot, physicalPath)) {
    throw new PathContainmentError(
      "PHYSICAL_ESCAPE",
      "File resolves outside the root through a link or junction",
    );
  }
  return physicalPath;
}

/**
 * Resolves a write destination (which normally does not exist yet) that is
 * inside `root` both lexically and physically: every existing ancestor is
 * resolved on the filesystem and must stay inside the physical root. An
 * existing final entry must be a regular file (never a link). Returns the
 * physical destination to write to; missing directories may then be created.
 */
export function resolveOutputPathWithinRoot(root: string, relativePath: string): string {
  const lexicalPath = lexicallyWithinRoot(root, relativePath);
  const existing = entryOrNull(lexicalPath);
  if (existing && !existing.isFile()) {
    throw new PathContainmentError(
      "NOT_REGULAR_FILE",
      "Existing output entry is not a regular file",
    );
  }
  const physicalRoot = physicalPathOf(root);
  const physicalPath = physicalPathOf(lexicalPath);
  if (physicalPath === physicalRoot || !isPhysicallyWithin(physicalRoot, physicalPath)) {
    throw new PathContainmentError(
      "PHYSICAL_ESCAPE",
      "Output resolves outside the root through a link or junction",
    );
  }
  return physicalPath;
}
