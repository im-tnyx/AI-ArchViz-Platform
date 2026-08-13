import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { safeKeyHash } from "./ledger.js";

export interface LockOwner {
  pid: number;
  token: string;
  jobId: string;
  scope: string;
  acquiredAt: string;
}

export interface HeldLock {
  path: string;
  owner: LockOwner;
  release(): void;
}

export class ExecutionLockedError extends Error {
  readonly code = "EXECUTION_LOCKED";
  constructor(
    message: string,
    readonly owner: LockOwner | null,
  ) {
    super(message);
    this.name = "ExecutionLockedError";
  }
}

export function acquireExecutionLock(
  workspaceRoot: string,
  namespace: "idempotency" | "scene",
  scope: string,
  jobId: string,
): HeldLock {
  const path = join(workspaceRoot, "locks", namespace, `${safeKeyHash(scope)}.lock`);
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      jobId,
      scope,
      acquiredAt: new Date().toISOString(),
    };
    let descriptor: number | null = null;
    try {
      descriptor = openSync(path, "wx");
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
      closeSync(descriptor);
      descriptor = null;
      return {
        path,
        owner,
        release: () => releaseOwnedLock(path, owner),
      };
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readLockOwner(path);
      if (!existing) {
        throw new ExecutionLockedError(
          "Lock record is corrupt and cannot be recovered safely",
          null,
        );
      }
      if (isProcessAlive(existing.pid)) {
        throw new ExecutionLockedError(
          `Execution is locked by PID ${existing.pid} for job ${existing.jobId}`,
          existing,
        );
      }
      const stalePath = `${path}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(path, stalePath);
        rmSync(stalePath, { force: true });
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new ExecutionLockedError("Could not acquire execution lock after stale recovery", null);
}

function readLockOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(value.pid) &&
      typeof value.token === "string" &&
      typeof value.jobId === "string" &&
      typeof value.scope === "string" &&
      typeof value.acquiredAt === "string"
      ? (value as LockOwner)
      : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseOwnedLock(path: string, owner: LockOwner): void {
  if (!existsSync(path)) return;
  const current = readLockOwner(path);
  if (current?.token === owner.token && current.pid === owner.pid) {
    rmSync(path, { force: true });
  }
}
