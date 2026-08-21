import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import { canonicalize } from "json-canonicalize";

export interface ContractValidationError {
  instancePath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ContractValidationError[] };

export interface JobEnvelope extends Record<string, unknown> {
  jobEnvelopeVersion: string;
  jobId: string;
  idempotencyKey: string;
  requestHash: string;
  projectId: string;
  sceneId: string;
  jobType: string;
  baseRevisionId: string | null;
  requestedRevisionId: string;
  inputs: {
    sceneSpecPath: string;
    sceneSpecHash: string;
    expectedManifestPath: string;
    expectedManifestHash: string;
  };
  workerRequirements: {
    os: string;
    dcc: string;
    renderer: string;
  };
  policy: {
    mode: string;
    timeoutSeconds: number;
    retryPolicy: string;
  };
}

export type SceneManifest = Record<string, unknown>;
export type ExecutionReport = Record<string, unknown>;
export type AssetArtifact = Record<string, unknown>;
export type AssetInspectionEvidence = Record<string, unknown>;
export type AssetInspectionJob = Record<string, unknown>;
export type RenderEvidence = Record<string, unknown>;
export type RenderJob = Record<string, unknown>;
export type CoronaExecutionPlan = Record<string, unknown>;
export type RendererRealizationEvidence = Record<string, unknown>;
export type GoldenCoronaPreviewPlan = Record<string, unknown>;
export type GoldenCoronaPreviewEvidence = Record<string, unknown>;

const schemaDirectory = new URL("../schema/", import.meta.url);

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(name, schemaDirectory), "utf8")) as Record<
    string,
    unknown
  >;
}

export const jobEnvelopeSchema = readSchema("job-envelope-v0.1.schema.json");
export const sceneManifestSchema = readSchema("scene-manifest-v0.1.schema.json");
export const executionReportSchema = readSchema("execution-report-v0.1.schema.json");
export const assetArtifactSchema = readSchema("asset-artifact-v0.1.schema.json");
export const assetInspectionSchema = readSchema("asset-inspection-v0.1.schema.json");
export const assetInspectionJobSchema = readSchema("asset-inspection-job-v0.1.schema.json");
export const renderEvidenceSchema = readSchema("render-evidence-v0.1.schema.json");
export const renderJobSchema = readSchema("render-job-v0.1.schema.json");
export const renderJobV02Schema = readSchema("render-job-v0.2.schema.json");
export const coronaExecutionPlanSchema = readSchema("corona-execution-plan-v0.1.schema.json");
export const rendererRealizationEvidenceSchema = readSchema(
  "renderer-realization-evidence-v0.1.schema.json",
);
export const goldenCoronaPreviewPlanSchema = readSchema(
  "golden-corona-preview-plan-v0.1.schema.json",
);
export const goldenCoronaPreviewEvidenceSchema = readSchema(
  "golden-corona-preview-evidence-v0.1.schema.json",
);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // The normative schemas use `properties` inside conditional branches without
  // repeating the parent object's type. That is valid JSON Schema 2020-12.
  strictTypes: false,
  validateFormats: true,
});
addFormatsModule.default.default(ajv);

const jobEnvelopeValidator = ajv.compile(jobEnvelopeSchema) as ValidateFunction<JobEnvelope>;
const sceneManifestValidator = ajv.compile(sceneManifestSchema) as ValidateFunction<SceneManifest>;
const executionReportValidator = ajv.compile(
  executionReportSchema,
) as ValidateFunction<ExecutionReport>;
const assetArtifactValidator = ajv.compile(assetArtifactSchema) as ValidateFunction<AssetArtifact>;
const assetInspectionValidator = ajv.compile(
  assetInspectionSchema,
) as ValidateFunction<AssetInspectionEvidence>;
const assetInspectionJobValidator = ajv.compile(
  assetInspectionJobSchema,
) as ValidateFunction<AssetInspectionJob>;
const renderEvidenceValidator = ajv.compile(
  renderEvidenceSchema,
) as ValidateFunction<RenderEvidence>;
const renderJobValidator = ajv.compile(renderJobSchema) as ValidateFunction<RenderJob>;
const renderJobV02Validator = ajv.compile(renderJobV02Schema) as ValidateFunction<RenderJob>;
const coronaExecutionPlanValidator = ajv.compile(
  coronaExecutionPlanSchema,
) as ValidateFunction<CoronaExecutionPlan>;
const rendererRealizationEvidenceValidator = ajv.compile(
  rendererRealizationEvidenceSchema,
) as ValidateFunction<RendererRealizationEvidence>;
const goldenCoronaPreviewPlanValidator = ajv.compile(
  goldenCoronaPreviewPlanSchema,
) as ValidateFunction<GoldenCoronaPreviewPlan>;
const goldenCoronaPreviewEvidenceValidator = ajv.compile(
  goldenCoronaPreviewEvidenceSchema,
) as ValidateFunction<GoldenCoronaPreviewEvidence>;

function normalizeErrors(errors: ErrorObject[] | null | undefined): ContractValidationError[] {
  return (errors ?? [])
    .map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? "Schema validation failed",
      params: error.params as Record<string, unknown>,
    }))
    .sort((left, right) => {
      const leftKey = `${left.instancePath}\u0000${left.keyword}\u0000${left.message}`;
      const rightKey = `${right.instancePath}\u0000${right.keyword}\u0000${right.message}`;
      return leftKey.localeCompare(rightKey);
    });
}

function runValidation<T>(validator: ValidateFunction<T>, value: unknown): ValidationResult<T> {
  if (validator(value)) {
    return { ok: true, value };
  }
  return { ok: false, errors: normalizeErrors(validator.errors) };
}

export function validateJobEnvelope(value: unknown): ValidationResult<JobEnvelope> {
  return runValidation(jobEnvelopeValidator, value);
}

export function validateSceneManifest(value: unknown): ValidationResult<SceneManifest> {
  return runValidation(sceneManifestValidator, value);
}

export function validateExecutionReport(value: unknown): ValidationResult<ExecutionReport> {
  return runValidation(executionReportValidator, value);
}

export function validateAssetArtifact(value: unknown): ValidationResult<AssetArtifact> {
  return runValidation(assetArtifactValidator, value);
}

export function validateAssetInspection(value: unknown): ValidationResult<AssetInspectionEvidence> {
  return runValidation(assetInspectionValidator, value);
}

export function validateAssetInspectionJob(value: unknown): ValidationResult<AssetInspectionJob> {
  return runValidation(assetInspectionJobValidator, value);
}

export function validateRenderEvidence(value: unknown): ValidationResult<RenderEvidence> {
  return runValidation(renderEvidenceValidator, value);
}

export function validateRenderJob(value: unknown): ValidationResult<RenderJob> {
  return runValidation(renderJobValidator, value);
}

export function validateRenderJobV02(value: unknown): ValidationResult<RenderJob> {
  return runValidation(renderJobV02Validator, value);
}

export function validateCoronaExecutionPlan(value: unknown): ValidationResult<CoronaExecutionPlan> {
  return runValidation(coronaExecutionPlanValidator, value);
}

export function validateRendererRealizationEvidence(
  value: unknown,
): ValidationResult<RendererRealizationEvidence> {
  return runValidation(rendererRealizationEvidenceValidator, value);
}

export function validateGoldenCoronaPreviewPlan(
  value: unknown,
): ValidationResult<GoldenCoronaPreviewPlan> {
  return runValidation(goldenCoronaPreviewPlanValidator, value);
}

export function validateGoldenCoronaPreviewEvidence(
  value: unknown,
): ValidationResult<GoldenCoronaPreviewEvidence> {
  return runValidation(goldenCoronaPreviewEvidenceValidator, value);
}

export function canonicalizeJson(value: unknown): string {
  return canonicalize(value);
}

export function semanticJsonHash(value: unknown): string {
  const digest = createHash("sha256").update(canonicalizeJson(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

export interface RequestHashProjection {
  baseRevisionId: string | null;
  expectedManifestHash: string;
  jobType: string;
  projectId: string;
  requestedRevisionId: string;
  sceneId: string;
  sceneSpecHash: string;
  workerRequirements: JobEnvelope["workerRequirements"];
}

export function createRequestHashProjection(job: JobEnvelope): RequestHashProjection {
  return {
    baseRevisionId: job.baseRevisionId,
    expectedManifestHash: job.inputs.expectedManifestHash,
    jobType: job.jobType,
    projectId: job.projectId,
    requestedRevisionId: job.requestedRevisionId,
    sceneId: job.sceneId,
    sceneSpecHash: job.inputs.sceneSpecHash,
    workerRequirements: job.workerRequirements,
  };
}

export function calculateRequestHash(job: JobEnvelope): string {
  return semanticJsonHash(createRequestHashProjection(job));
}

export type HashVerificationResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: "HASH_MISMATCH";
      mismatches: Array<{ field: string; expected: string; actual: string }>;
    };

export function verifyJobHashes(
  job: JobEnvelope,
  sceneSpec: unknown,
  expectedManifest: unknown,
): HashVerificationResult {
  const comparisons = [
    {
      field: "inputs.sceneSpecHash",
      expected: job.inputs.sceneSpecHash,
      actual: semanticJsonHash(sceneSpec),
    },
    {
      field: "inputs.expectedManifestHash",
      expected: job.inputs.expectedManifestHash,
      actual: semanticJsonHash(expectedManifest),
    },
    { field: "requestHash", expected: job.requestHash, actual: calculateRequestHash(job) },
  ];
  const mismatches = comparisons.filter((comparison) => comparison.expected !== comparison.actual);
  return mismatches.length === 0
    ? { ok: true }
    : { ok: false, errorCode: "HASH_MISMATCH", mismatches };
}

export type RevisionCheckResult =
  | { ok: true }
  | {
      ok: false;
      errorCode: "STALE_REVISION";
      expectedBaseRevisionId: string | null;
      actualBaseRevisionId: string | null;
    };

export function checkBaseRevision(
  job: JobEnvelope,
  currentVerifiedRevisionId: string | null,
): RevisionCheckResult {
  return job.baseRevisionId === currentVerifiedRevisionId
    ? { ok: true }
    : {
        ok: false,
        errorCode: "STALE_REVISION",
        expectedBaseRevisionId: currentVerifiedRevisionId,
        actualBaseRevisionId: job.baseRevisionId,
      };
}

export function isIdempotencyKeyReuseMismatch(
  existing: { idempotencyKey: string; requestHash: string },
  submitted: { idempotencyKey: string; requestHash: string },
): boolean {
  return (
    existing.idempotencyKey === submitted.idempotencyKey &&
    existing.requestHash !== submitted.requestHash
  );
}
