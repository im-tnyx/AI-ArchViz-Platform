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
export type CanonicalRenderStateEvidence = Record<string, unknown>;
export type CanonicalCoronaPreviewEvidence = Record<string, unknown>;
export type CanonicalCoronaPreviewEvidenceV02 = Record<string, unknown>;
export type CanonicalCoronaPreviewEvidenceV03 = Record<string, unknown>;
export type CoronaExecutionPlanV02 = Record<string, unknown>;
export type CoronaMaterialAppearanceEvidence = Record<string, unknown>;
export type CanonicalMaterialStateEvidence = Record<string, unknown>;
export type CanonicalCameraStateEvidence = Record<string, unknown>;
export type SpatialValidationEvidence = Record<string, unknown>;
export type CirculationAnalysisEvidence = Record<string, unknown>;
export type CirculationRequirementEvidence = Record<string, unknown>;

/** Identity proof for one cad-document-v0.1 extraction (no path, no entities). */
export interface CadExtractionEvidence {
  evidenceVersion: "0.1.0";
  sourceFormat: "dxf";
  sourceHash: string;
  cadDocumentVersion: "0.1.0";
  cadDocumentHash: string;
  sourceUnits: { insunitsCode: number; name: string; scaleToMillimeters: number };
  canonicalUnits: "millimeters";
  summary: {
    layerCount: number;
    blockCount: number;
    entityCount: number;
    supportedEntityCount: number;
    unsupportedEntityCount: number;
    entityTypeCounts: Record<string, number>;
  };
  status: "PASS";
}

/** Identity proof for one architectural-extraction-v0.1 (the upstream hash chain). */
export interface CadInterpretationEvidence {
  evidenceVersion: "0.1.0";
  interpretationPolicyVersion: "cad-interpretation-policy-v0.1";
  sourceHash: string;
  cadDocumentHash: string;
  profileId: string;
  profileHash: string;
  architecturalExtractionVersion: "0.1.0";
  architecturalExtractionHash: string;
  summary: {
    spaceCount: number;
    wallCount: number;
    openingCount: number;
    doorCount: number;
    windowCount: number;
    sourceEntityCount: number;
    consumedEntityCount: number;
    unconsumedEntityCount: number;
  };
  status: "READY_FOR_REVIEW";
}

/** Identity proof for one architectural-topology-v0.1 (upstream chain + topology hash). */
export interface CadTopologyEvidence {
  evidenceVersion: "0.1.0";
  topologyPolicyVersion: "cad-topology-policy-v0.1";
  interpretationPolicyVersion: "cad-interpretation-policy-v0.1";
  sourceHash: string;
  cadDocumentHash: string;
  profileId: string;
  profileHash: string;
  architecturalExtractionVersion: "0.1.0";
  candidateBasis: "architectural_extraction" | "space_wall_stage";
  architecturalExtractionHash: string | null;
  spaceWallStageHash: string;
  architecturalTopologyVersion: "0.1.0";
  architecturalTopologyHash: string;
  summary: {
    spaceCount: number;
    wallCandidateCount: number;
    sharedBoundaryCount: number;
    adjacencyCount: number;
    singleSpaceOpeningCount: number;
    interiorOpeningCount: number;
    unpairedWallCount: number;
    sharedParticipantWallCount: number;
  };
  status: "READY_FOR_REVIEW";
}

/** Identity proof for one reviewed-partition-model-v0.1 (approval + chain + model hash). */
export interface CadPartitionModelEvidence {
  evidenceVersion: "0.1.0";
  partitionPolicyVersion: "cad-shared-partition-policy-v0.1";
  approvalId: string;
  approvalHash: string;
  sourceHash: string;
  cadDocumentHash: string;
  profileHash: string;
  candidateBasis: "architectural_extraction" | "space_wall_stage";
  architecturalExtractionHash: string | null;
  spaceWallStageHash: string;
  architecturalTopologyHash: string;
  reviewedPartitionModelVersion: "0.1.0";
  reviewedPartitionModelHash: string;
  summary: {
    spaceCount: number;
    sharedPartitionCount: number;
    reviewedInteriorDoorCount: number;
    unsharedOpeningCount: number;
    wallCandidateCount: number;
    sharedWallIntervalCount: number;
    unpairedWallIntervalCount: number;
  };
  status: "APPROVED_FOR_SCENE_CANONICALIZATION";
}

/** Identity proof for one CAD-derived canonical SceneSpec seed (six-hash chain). */
export interface CadSceneSeedEvidence {
  evidenceVersion: "0.1.0";
  canonicalizationPolicyVersion: "cad-scene-seed-policy-v0.1";
  approvalId: string;
  approvalHash: string;
  sourceHash: string;
  cadDocumentHash: string;
  profileHash: string;
  architecturalExtractionHash: string;
  sceneSpecVersion: "0.4.0";
  sceneSpecHash: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  mappingSummary: {
    levelCount: number;
    spaceCount: number;
    wallCount: number;
    surfaceCount: number;
    openingCount: number;
  };
  spatialValidationStatus: "PASS";
  circulationRequirementStatus: "PASS";
  status: "PASS";
}

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
export const canonicalRenderStateSchema = readSchema("canonical-render-state-v0.1.schema.json");
export const canonicalCoronaPreviewEvidenceSchema = readSchema(
  "canonical-corona-preview-evidence-v0.1.schema.json",
);
export const canonicalCoronaPreviewEvidenceV02Schema = readSchema(
  "canonical-corona-preview-evidence-v0.2.schema.json",
);
export const canonicalCoronaPreviewEvidenceV03Schema = readSchema(
  "canonical-corona-preview-evidence-v0.3.schema.json",
);
export const coronaExecutionPlanV02Schema = readSchema("corona-execution-plan-v0.2.schema.json");
export const coronaMaterialAppearanceEvidenceSchema = readSchema(
  "corona-material-appearance-evidence-v0.1.schema.json",
);
export const canonicalMaterialStateSchema = readSchema("canonical-material-state-v0.1.schema.json");
export const canonicalCameraStateSchema = readSchema("canonical-camera-state-v0.1.schema.json");
export const canonicalMaterialStateV02Schema = readSchema(
  "canonical-material-state-v0.2.schema.json",
);
export const canonicalCameraStateV02Schema = readSchema("canonical-camera-state-v0.2.schema.json");
export const spatialValidationEvidenceSchema = readSchema(
  "spatial-validation-evidence-v0.1.schema.json",
);
export const circulationAnalysisEvidenceSchema = readSchema(
  "circulation-analysis-evidence-v0.1.schema.json",
);
export const circulationRequirementEvidenceSchema = readSchema(
  "circulation-requirement-evidence-v0.1.schema.json",
);
export const cadExtractionEvidenceSchema = readSchema("cad-extraction-evidence-v0.1.schema.json");
export const cadInterpretationEvidenceSchema = readSchema(
  "cad-interpretation-evidence-v0.1.schema.json",
);
export const cadSceneSeedEvidenceSchema = readSchema("cad-scene-seed-evidence-v0.1.schema.json");
export const cadTopologyEvidenceSchema = readSchema("cad-topology-evidence-v0.1.schema.json");
export const cadPartitionModelEvidenceSchema = readSchema(
  "cad-partition-model-evidence-v0.1.schema.json",
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
const canonicalRenderStateValidator = ajv.compile(
  canonicalRenderStateSchema,
) as ValidateFunction<CanonicalRenderStateEvidence>;
const canonicalCoronaPreviewEvidenceValidator = ajv.compile(
  canonicalCoronaPreviewEvidenceSchema,
) as ValidateFunction<CanonicalCoronaPreviewEvidence>;
const canonicalCoronaPreviewEvidenceV02Validator = ajv.compile(
  canonicalCoronaPreviewEvidenceV02Schema,
) as ValidateFunction<CanonicalCoronaPreviewEvidenceV02>;
const canonicalCoronaPreviewEvidenceV03Validator = ajv.compile(
  canonicalCoronaPreviewEvidenceV03Schema,
) as ValidateFunction<CanonicalCoronaPreviewEvidenceV03>;
const coronaExecutionPlanV02Validator = ajv.compile(
  coronaExecutionPlanV02Schema,
) as ValidateFunction<CoronaExecutionPlanV02>;
const coronaMaterialAppearanceEvidenceValidator = ajv.compile(
  coronaMaterialAppearanceEvidenceSchema,
) as ValidateFunction<CoronaMaterialAppearanceEvidence>;
const canonicalMaterialStateValidator = ajv.compile(
  canonicalMaterialStateSchema,
) as ValidateFunction<CanonicalMaterialStateEvidence>;
const canonicalCameraStateValidator = ajv.compile(
  canonicalCameraStateSchema,
) as ValidateFunction<CanonicalCameraStateEvidence>;
const canonicalMaterialStateV02Validator = ajv.compile(
  canonicalMaterialStateV02Schema,
) as ValidateFunction<CanonicalMaterialStateEvidence>;
const canonicalCameraStateV02Validator = ajv.compile(
  canonicalCameraStateV02Schema,
) as ValidateFunction<CanonicalCameraStateEvidence>;
const spatialValidationEvidenceValidator = ajv.compile(
  spatialValidationEvidenceSchema,
) as ValidateFunction<SpatialValidationEvidence>;
const circulationAnalysisEvidenceValidator = ajv.compile(
  circulationAnalysisEvidenceSchema,
) as ValidateFunction<CirculationAnalysisEvidence>;
const circulationRequirementEvidenceValidator = ajv.compile(
  circulationRequirementEvidenceSchema,
) as ValidateFunction<CirculationRequirementEvidence>;
const cadExtractionEvidenceValidator = ajv.compile(
  cadExtractionEvidenceSchema,
) as ValidateFunction<CadExtractionEvidence>;
const cadInterpretationEvidenceValidator = ajv.compile(
  cadInterpretationEvidenceSchema,
) as ValidateFunction<CadInterpretationEvidence>;
const cadSceneSeedEvidenceValidator = ajv.compile(
  cadSceneSeedEvidenceSchema,
) as ValidateFunction<CadSceneSeedEvidence>;
const cadTopologyEvidenceValidator = ajv.compile(
  cadTopologyEvidenceSchema,
) as ValidateFunction<CadTopologyEvidence>;
const cadPartitionModelEvidenceValidator = ajv.compile(
  cadPartitionModelEvidenceSchema,
) as ValidateFunction<CadPartitionModelEvidence>;

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

export function validateCanonicalRenderStateEvidence(
  value: unknown,
): ValidationResult<CanonicalRenderStateEvidence> {
  return runValidation(canonicalRenderStateValidator, value);
}

export function validateCanonicalCoronaPreviewEvidence(
  value: unknown,
): ValidationResult<CanonicalCoronaPreviewEvidence> {
  return runValidation(canonicalCoronaPreviewEvidenceValidator, value);
}

export function validateCanonicalCoronaPreviewEvidenceV02(
  value: unknown,
): ValidationResult<CanonicalCoronaPreviewEvidenceV02> {
  return runValidation(canonicalCoronaPreviewEvidenceV02Validator, value);
}

export function validateCanonicalCoronaPreviewEvidenceV03(
  value: unknown,
): ValidationResult<CanonicalCoronaPreviewEvidenceV03> {
  return runValidation(canonicalCoronaPreviewEvidenceV03Validator, value);
}

export function validateCoronaExecutionPlanV02(
  value: unknown,
): ValidationResult<CoronaExecutionPlanV02> {
  return runValidation(coronaExecutionPlanV02Validator, value);
}

export function validateCoronaMaterialAppearanceEvidence(
  value: unknown,
): ValidationResult<CoronaMaterialAppearanceEvidence> {
  return runValidation(coronaMaterialAppearanceEvidenceValidator, value);
}

export function validateCanonicalMaterialStateEvidence(
  value: unknown,
): ValidationResult<CanonicalMaterialStateEvidence> {
  return runValidation(canonicalMaterialStateValidator, value);
}

/** canonical-material-state-v0.2: identical physical fields, bound to SceneSpec v0.4. */
export function validateCanonicalMaterialStateEvidenceV02(
  value: unknown,
): ValidationResult<CanonicalMaterialStateEvidence> {
  return runValidation(canonicalMaterialStateV02Validator, value);
}

/** canonical-camera-state-v0.2: identical physical fields, bound to SceneSpec v0.4. */
export function validateCanonicalCameraStateEvidenceV02(
  value: unknown,
): ValidationResult<CanonicalCameraStateEvidence> {
  return runValidation(canonicalCameraStateV02Validator, value);
}

export function validateCanonicalCameraStateEvidence(
  value: unknown,
): ValidationResult<CanonicalCameraStateEvidence> {
  return runValidation(canonicalCameraStateValidator, value);
}

export function validateSpatialValidationEvidence(
  value: unknown,
): ValidationResult<SpatialValidationEvidence> {
  return runValidation(spatialValidationEvidenceValidator, value);
}

export function validateCirculationAnalysisEvidence(
  value: unknown,
): ValidationResult<CirculationAnalysisEvidence> {
  return runValidation(circulationAnalysisEvidenceValidator, value);
}

export function validateCirculationRequirementEvidence(
  value: unknown,
): ValidationResult<CirculationRequirementEvidence> {
  return runValidation(circulationRequirementEvidenceValidator, value);
}

export function validateCadExtractionEvidence(
  value: unknown,
): ValidationResult<CadExtractionEvidence> {
  return runValidation(cadExtractionEvidenceValidator, value);
}

export function validateCadInterpretationEvidence(
  value: unknown,
): ValidationResult<CadInterpretationEvidence> {
  return runValidation(cadInterpretationEvidenceValidator, value);
}

export function validateCadSceneSeedEvidence(
  value: unknown,
): ValidationResult<CadSceneSeedEvidence> {
  return runValidation(cadSceneSeedEvidenceValidator, value);
}

export function validateCadTopologyEvidence(value: unknown): ValidationResult<CadTopologyEvidence> {
  return runValidation(cadTopologyEvidenceValidator, value);
}

export function validateCadPartitionModelEvidence(
  value: unknown,
): ValidationResult<CadPartitionModelEvidence> {
  return runValidation(cadPartitionModelEvidenceValidator, value);
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
