import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type JobEnvelope, semanticJsonHash } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireExecutionLock,
  buildGoldenScene,
  ExecutionLockedError,
  evaluateLedger,
  ledgerPath,
  readLedger,
  safeKeyHash,
  startLedgerAttempt,
  writeLedgerAtomic,
} from "../../apps/worker/src/index.js";

const fixtureRoot = resolve("tests/fixtures/living-room-golden");
const temporaryDirectories: string[] = [];

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));
}

function isolatedRepository(job: JobEnvelope): {
  root: string;
  jobPath: string;
  workspace: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ai-archviz-resilience-"));
  temporaryDirectories.push(root);
  const fixtureDirectory = join(root, "fixture");
  mkdirSync(fixtureDirectory, { recursive: true });
  for (const name of ["scene-spec.json", "expected-scene-manifest.json", "fixture-manifest.json"]) {
    writeFileSync(join(fixtureDirectory, name), JSON.stringify(fixture(name)), "utf8");
  }
  const jobPath = join(fixtureDirectory, "job-envelope.json");
  writeFileSync(jobPath, JSON.stringify(job), "utf8");
  return { root, jobPath, workspace: join(root, ".workspace") };
}

function workerConfig(root: string, workspace: string) {
  return {
    repositoryRoot: root,
    workspaceRoot: workspace,
    processTimeoutMs: 5_000,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: false,
    trustedAssetRoot: null,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("durable idempotency ledger", () => {
  it("uses a hash-derived filename and persists atomic state transitions", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-ledger-"));
    temporaryDirectories.push(root);
    const submission = {
      idempotencyKey: "living-room-golden.build.rev_golden_0001",
      requestHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      jobId: "job_attempt_0001",
    };
    const record = startLedgerAttempt(null, submission, "2026-08-13T00:00:00.000Z");
    writeLedgerAtomic(root, record);
    expect(ledgerPath(root, submission.idempotencyKey)).toBe(
      join(root, "idempotency", `${safeKeyHash(submission.idempotencyKey)}.json`),
    );
    expect(readLedger(root, submission.idempotencyKey)).toEqual(record);
    expect(record).toMatchObject({ status: "IN_PROGRESS", attemptCount: 1 });
    writeLedgerAtomic(root, { ...record, status: "FAILED_RETRYABLE", retryable: true });
    expect(readLedger(root, submission.idempotencyKey)).toMatchObject({
      status: "FAILED_RETRYABLE",
      retryable: true,
    });
    const retry = startLedgerAttempt(
      { ...record, status: "FAILED_RETRYABLE" },
      { ...submission, jobId: "job_attempt_0002" },
    );
    expect(retry).toMatchObject({ status: "IN_PROGRESS", attemptCount: 2 });
  });

  it("classifies retryable, final, and interrupted prior states deterministically", () => {
    const submission = {
      idempotencyKey: "classification-key",
      requestHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      jobId: "job_classification_0001",
    };
    const record = startLedgerAttempt(null, submission);
    expect(evaluateLedger(record, submission)).toBe("RECOVER_AND_EXECUTE");
    expect(evaluateLedger({ ...record, status: "FAILED_RETRYABLE" }, submission)).toBe("EXECUTE");
    expect(evaluateLedger({ ...record, status: "FAILED_FINAL" }, submission)).toBe(
      "REPLAY_FAILURE",
    );
  });

  it("reports malformed durable state as ledger corruption without overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-corrupt-ledger-"));
    temporaryDirectories.push(root);
    const key = "corrupt-ledger-key";
    const path = ledgerPath(root, key);
    mkdirSync(join(root, "idempotency"), { recursive: true });
    writeFileSync(path, "{not-json", "utf8");
    expect(() => readLedger(root, key)).toThrow(/IDEMPOTENCY_LEDGER_CORRUPT/u);
    expect(readFileSync(path, "utf8")).toBe("{not-json");
  });

  it("consumes the frozen key-reuse mismatch fixture", () => {
    const mismatch = fixture("invalid/idempotency-key-reuse-mismatch.json") as {
      existingLedgerEntry: { idempotencyKey: string; requestHash: string; status: "SUCCESS" };
      submittedJob: { idempotencyKey: string; requestHash: string };
      expectedErrorCode: string;
    };
    const existing = {
      ...startLedgerAttempt(null, {
        ...mismatch.existingLedgerEntry,
        jobId: "job_original_0001",
      }),
      status: mismatch.existingLedgerEntry.status,
    };
    expect(evaluateLedger(existing, mismatch.submittedJob)).toBe(mismatch.expectedErrorCode);
  });

  it("replays a verified success across a fresh invocation without DCC launch", async () => {
    const originalJob = fixture("job-envelope.json") as JobEnvelope;
    const currentJob = { ...originalJob, jobId: "job_golden_replay_0002" };
    const { root, jobPath, workspace } = isolatedRepository(currentJob);
    const attemptRoot = join(workspace, originalJob.jobId);
    const outputPath = join(attemptRoot, "output", "project.max");
    const reportPath = join(attemptRoot, "output", "execution-report.json");
    const manifestPath = join(attemptRoot, "verification", "scene-manifest.json");
    mkdirSync(join(attemptRoot, "output"), { recursive: true });
    mkdirSync(join(attemptRoot, "verification"), { recursive: true });
    writeFileSync(outputPath, "verified-max-bytes", "utf8");
    const manifest = fixture("expected-scene-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const report = {
      reportVersion: "0.1.0",
      jobId: originalJob.jobId,
      idempotencyKey: originalJob.idempotencyKey,
      requestHash: originalJob.requestHash,
      projectId: originalJob.projectId,
      sceneId: originalJob.sceneId,
      revisionId: originalJob.requestedRevisionId,
      status: "SUCCESS",
      startedAt: "2026-08-13T00:00:00.000Z",
      completedAt: "2026-08-13T00:01:00.000Z",
      candidatePath: "candidate/project.max",
      verifiedOutputPath: "output/project.max",
      manifestPath: "verification/scene-manifest.json",
      validationResult: { status: "PASS", errors: [] },
      verificationResult: { status: "PASS", errors: [] },
      error: null,
    };
    writeFileSync(reportPath, JSON.stringify(report), "utf8");
    const now = "2026-08-13T00:01:00.000Z";
    writeLedgerAtomic(workspace, {
      ...startLedgerAttempt(null, originalJob, "2026-08-13T00:00:00.000Z"),
      status: "SUCCESS",
      successfulJobId: originalJob.jobId,
      completedAt: now,
      updatedAt: now,
      retryable: false,
      reportPath: join(originalJob.jobId, "output", "execution-report.json"),
      verifiedOutputPath: join(originalJob.jobId, "output", "project.max"),
      manifestPath: join(originalJob.jobId, "verification", "scene-manifest.json"),
      verifiedOutputHash: `sha256:${createHash("sha256").update("verified-max-bytes").digest("hex")}`,
      manifestHash: semanticJsonHash(manifest),
      dccVersion: "2025",
      compatibilityMode: true,
    });
    const result = await buildGoldenScene(workerConfig(root, workspace), jobPath);
    expect(result).toMatchObject({
      status: "SUCCESS",
      replayed: true,
      originalJobId: originalJob.jobId,
      currentJobId: currentJob.jobId,
      buildProcess: null,
      verificationProcess: null,
    });
    expect(readLedger(workspace, originalJob.idempotencyKey)?.replayJobIds).toContain(
      currentJob.jobId,
    );
  });

  it("blocks replay when a successful artifact no longer matches its hash", async () => {
    const job = fixture("job-envelope.json") as JobEnvelope;
    const { root, jobPath, workspace } = isolatedRepository(job);
    const attemptRoot = join(workspace, job.jobId);
    const reportPath = join(attemptRoot, "output", "execution-report.json");
    const outputPath = join(attemptRoot, "output", "project.max");
    const manifestPath = join(attemptRoot, "verification", "scene-manifest.json");
    mkdirSync(join(attemptRoot, "output"), { recursive: true });
    mkdirSync(join(attemptRoot, "verification"), { recursive: true });
    writeFileSync(outputPath, "tampered-max-bytes", "utf8");
    const manifest = fixture("expected-scene-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    writeFileSync(
      reportPath,
      JSON.stringify({
        reportVersion: "0.1.0",
        jobId: job.jobId,
        idempotencyKey: job.idempotencyKey,
        requestHash: job.requestHash,
        projectId: job.projectId,
        sceneId: job.sceneId,
        revisionId: job.requestedRevisionId,
        status: "SUCCESS",
        startedAt: "2026-08-13T00:00:00.000Z",
        completedAt: "2026-08-13T00:01:00.000Z",
        candidatePath: "candidate/project.max",
        verifiedOutputPath: "output/project.max",
        manifestPath: "verification/scene-manifest.json",
        validationResult: { status: "PASS", errors: [] },
        verificationResult: { status: "PASS", errors: [] },
        error: null,
      }),
      "utf8",
    );
    const record = startLedgerAttempt(null, job);
    writeLedgerAtomic(workspace, {
      ...record,
      status: "SUCCESS",
      successfulJobId: job.jobId,
      retryable: false,
      completedAt: record.updatedAt,
      reportPath: join(job.jobId, "output", "execution-report.json"),
      verifiedOutputPath: join(job.jobId, "output", "project.max"),
      manifestPath: join(job.jobId, "verification", "scene-manifest.json"),
      verifiedOutputHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      manifestHash: semanticJsonHash(manifest),
    });
    const result = await buildGoldenScene(workerConfig(root, workspace), jobPath);
    expect(result).toMatchObject({
      status: "BLOCKED",
      error: { code: "RECOVERY_REQUIRED" },
      buildProcess: null,
      verificationProcess: null,
    });
  });
});

describe("local execution locks", () => {
  it("blocks an active owner and never terminates it", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-lock-"));
    temporaryDirectories.push(root);
    const held = acquireExecutionLock(root, "scene", "project\u0000scene", "job_0001");
    expect(() => acquireExecutionLock(root, "scene", "project\u0000scene", "job_0002")).toThrow(
      ExecutionLockedError,
    );
    held.release();
  });

  it("recovers a lock whose recorded PID is no longer alive", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-stale-lock-"));
    temporaryDirectories.push(root);
    const scope = "project\u0000scene";
    const path = join(root, "locks", "scene", `${safeKeyHash(scope)}.lock`);
    mkdirSync(join(root, "locks", "scene"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        pid: 2_147_483_647,
        token: "stale-token",
        jobId: "job_stale_0001",
        scope,
        acquiredAt: "2026-08-13T00:00:00.000Z",
      }),
      "utf8",
    );
    const held = acquireExecutionLock(root, "scene", scope, "job_recovery_0002");
    expect(held.owner.jobId).toBe("job_recovery_0002");
    held.release();
    expect(existsSync(path)).toBe(false);
  });
});

describe("revision safety", () => {
  it("consumes the frozen stale-revision job and blocks before DCC discovery", async () => {
    const stale = fixture("invalid/stale-revision-job.json") as JobEnvelope;
    const { root, jobPath, workspace } = isolatedRepository(stale);
    const result = await buildGoldenScene(workerConfig(root, workspace), jobPath);
    expect(result).toMatchObject({
      status: "FAILED",
      dcc: null,
      buildProcess: null,
      verificationProcess: null,
      report: { error: { code: "STALE_REVISION", retryable: false } },
    });
  });
});
