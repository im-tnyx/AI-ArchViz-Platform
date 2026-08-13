export const workerErrorCodes = [
  "CONFIG_INVALID",
  "SCHEMA_INVALID",
  "HASH_MISMATCH",
  "DCC_NOT_FOUND",
  "DCC_VERSION_UNSUPPORTED",
  "DCC_BATCH_NOT_FOUND",
  "DCC_LAUNCH_FAILED",
  "PYTHON_PROBE_FAILED",
  "PYMXS_UNAVAILABLE",
  "PROCESS_TIMEOUT",
  "PROCESS_EXIT_NONZERO",
  "IDENTITY_MISMATCH",
  "CANDIDATE_MISSING",
  "MANIFEST_MISMATCH",
  "REPORT_INVALID",
  "PROMOTION_FAILED",
  "BUILD_FAILED",
  "VERIFICATION_FAILED",
] as const;

export type WorkerErrorCode = (typeof workerErrorCodes)[number];

export class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: WorkerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkerError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}
