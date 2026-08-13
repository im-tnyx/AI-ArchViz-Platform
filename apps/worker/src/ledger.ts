import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type LedgerStatus = "IN_PROGRESS" | "SUCCESS" | "FAILED_RETRYABLE" | "FAILED_FINAL";

export interface IdempotencyLedgerRecord {
  ledgerVersion: "0.1.0";
  idempotencyKey: string;
  requestHash: string;
  originalJobId: string;
  successfulJobId: string | null;
  latestJobId: string;
  replayJobIds: string[];
  status: LedgerStatus;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  retryable: boolean | null;
  errorCode: string | null;
  reportPath: string | null;
  verifiedOutputPath: string | null;
  manifestPath: string | null;
  verifiedOutputHash: string | null;
  manifestHash: string | null;
  dccVersion: string | null;
  compatibilityMode: boolean;
}

export type LedgerDecision =
  | "EXECUTE"
  | "RECOVER_AND_EXECUTE"
  | "REPLAY_SUCCESS"
  | "REPLAY_FAILURE"
  | "IDEMPOTENCY_KEY_REUSE_MISMATCH";

export function safeKeyHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function ledgerPath(workspaceRoot: string, idempotencyKey: string): string {
  return join(workspaceRoot, "idempotency", `${safeKeyHash(idempotencyKey)}.json`);
}

export function readLedger(
  workspaceRoot: string,
  idempotencyKey: string,
): IdempotencyLedgerRecord | null {
  const path = ledgerPath(workspaceRoot, idempotencyKey);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    assertLedgerRecord(value, idempotencyKey);
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.startsWith("IDEMPOTENCY_LEDGER_CORRUPT")
        ? message
        : `IDEMPOTENCY_LEDGER_CORRUPT: ${message}`,
    );
  }
}

export function evaluateLedger(
  record: IdempotencyLedgerRecord | null,
  submission: { idempotencyKey: string; requestHash: string },
): LedgerDecision {
  if (!record) return "EXECUTE";
  if (
    record.idempotencyKey !== submission.idempotencyKey ||
    record.requestHash !== submission.requestHash
  ) {
    return "IDEMPOTENCY_KEY_REUSE_MISMATCH";
  }
  if (record.status === "SUCCESS") return "REPLAY_SUCCESS";
  if (record.status === "FAILED_FINAL") return "REPLAY_FAILURE";
  if (record.status === "IN_PROGRESS") return "RECOVER_AND_EXECUTE";
  return "EXECUTE";
}

export function startLedgerAttempt(
  previous: IdempotencyLedgerRecord | null,
  submission: { idempotencyKey: string; requestHash: string; jobId: string },
  now = new Date().toISOString(),
): IdempotencyLedgerRecord {
  if (previous && evaluateLedger(previous, submission) === "IDEMPOTENCY_KEY_REUSE_MISMATCH") {
    throw new Error("IDEMPOTENCY_KEY_REUSE_MISMATCH");
  }
  return {
    ledgerVersion: "0.1.0",
    idempotencyKey: submission.idempotencyKey,
    requestHash: submission.requestHash,
    originalJobId: previous?.originalJobId ?? submission.jobId,
    successfulJobId: previous?.successfulJobId ?? null,
    latestJobId: submission.jobId,
    replayJobIds: previous?.replayJobIds ?? [],
    status: "IN_PROGRESS",
    attemptCount: (previous?.attemptCount ?? 0) + 1,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    completedAt: null,
    retryable: null,
    errorCode: null,
    reportPath: null,
    verifiedOutputPath: null,
    manifestPath: null,
    verifiedOutputHash: null,
    manifestHash: null,
    dccVersion: null,
    compatibilityMode: false,
  };
}

export function writeLedgerAtomic(workspaceRoot: string, record: IdempotencyLedgerRecord): void {
  const path = ledgerPath(workspaceRoot, record.idempotencyKey);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${safeKeyHash(`${record.updatedAt}:${Math.random()}`)}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx");
    writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function assertLedgerRecord(
  value: unknown,
  expectedIdempotencyKey: string,
): asserts value is IdempotencyLedgerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IDEMPOTENCY_LEDGER_CORRUPT: record must be an object");
  }
  const record = value as Partial<IdempotencyLedgerRecord>;
  const statuses: LedgerStatus[] = ["IN_PROGRESS", "SUCCESS", "FAILED_RETRYABLE", "FAILED_FINAL"];
  if (
    record.ledgerVersion !== "0.1.0" ||
    record.idempotencyKey !== expectedIdempotencyKey ||
    typeof record.requestHash !== "string" ||
    typeof record.originalJobId !== "string" ||
    (record.successfulJobId !== null && typeof record.successfulJobId !== "string") ||
    typeof record.latestJobId !== "string" ||
    !Array.isArray(record.replayJobIds) ||
    !record.replayJobIds.every((entry) => typeof entry === "string") ||
    !statuses.includes(record.status as LedgerStatus) ||
    !Number.isInteger(record.attemptCount) ||
    Number(record.attemptCount) < 1
  ) {
    throw new Error("IDEMPOTENCY_LEDGER_CORRUPT: record fields are invalid");
  }
}
