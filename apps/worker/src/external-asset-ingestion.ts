import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateSceneChangeSet, validateSceneSpec } from "@ai-archviz/scene-spec";
import { semanticJsonHash, validateSceneManifest } from "@ai-archviz/worker-contracts";
import {
  type AssetArtifactRegistry,
  resolveVerifiedAssetArtifact,
  validateAssetArtifactEligibility,
} from "./asset-trust.js";
import type { WorkerConfig } from "./config.js";
import { isDccExecutionAuthorized } from "./dcc-execution-guard.js";
import { discoverThreeDsMax, type ThreeDsMaxDiscoveryResult } from "./discovery.js";
import {
  evaluateLedger,
  type IdempotencyLedgerRecord,
  readLedger,
  startLedgerAttempt,
  writeLedgerAtomic,
} from "./ledger.js";
import { acquireExecutionLock, ExecutionLockedError } from "./lock.js";
import { compareSceneManifests, type ManifestTolerances } from "./manifest.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";
import {
  createJobWorkspace,
  promoteCandidate,
  readJson,
  writeDeterministicJson,
} from "./workspace.js";

const externalDefinitionSourceType = "external_max";
const lockPropertyNames = ["geometry", "transform", "material"] as const;

export class ExternalAssetIngestionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ExternalAssetIngestionError";
  }
}

export interface TrustedExternalAssetDefinition {
  id: string;
  version: string;
  category: string;
  sourceType: "external_max";
  artifactId: string;
  dimensions: [number, number, number];
  pivotPolicy: string;
  allowNonUniformScale: boolean;
}

export interface TrustedExternalAssetCatalog {
  catalogVersion: "0.1.0";
  definitions: TrustedExternalAssetDefinition[];
}

interface ReplaceAssetOperation {
  operationId: string;
  type: "ReplaceAsset";
  targetId: string;
  parameters: { newAssetDefinitionId: string; placementPolicy: "preserve_anchor" };
}

interface ChangeSetContract {
  changeSetId: string;
  projectId: string;
  sceneId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  metadata: { createdAt: string };
  operations: [ReplaceAssetOperation];
}

export interface ExternalAssetIngestionPlan {
  ingestionPlanVersion: "0.1.0";
  changeSetId: string;
  projectId: string;
  sceneId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  targetId: string;
  currentAssetDefinitionId: string;
  externalAssetDefinition: TrustedExternalAssetDefinition;
  transform: Record<string, unknown>;
  locks: Record<string, boolean>;
  materialId: string;
  expectedManifest: Record<string, unknown>;
}

export interface ExternalAssetIngestionPreflight {
  changeSet: ChangeSetContract;
  targetSceneSpec: Record<string, unknown>;
  expectedManifest: Record<string, unknown>;
  plan: ExternalAssetIngestionPlan;
  artifact: { artifactId: string; sha256: string; byteLength: number; format: "3ds_max" };
}

export interface ExternalAssetIngestionResult {
  status: "SUCCESS" | "FAILED" | "BLOCKED";
  error: { code: string; message: string } | null;
  replayed: boolean;
  idempotencyKey: string | null;
  requestHash: string | null;
  workspace: string | null;
  verifiedOutputPath: string | null;
  baseArtifactHash: string | null;
  sourceArtifactHash: string | null;
  stagedArtifactHash: string | null;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  mutationProcess: ControlledProcessResult | null;
  verificationProcess: ControlledProcessResult | null;
  comparison: ReturnType<typeof compareSceneManifests> | null;
  semanticDiff: ReturnType<typeof diffExternalSemanticManifests> | null;
}

export interface ExternalAssetIngestionInput {
  config: Pick<
    WorkerConfig,
    | "repositoryRoot"
    | "workspaceRoot"
    | "processTimeoutMs"
    | "threeDsMaxInstallationPath"
    | "allowCompatibilityVersionForSpike"
    | "allowDccExecution"
  >;
  jobId: string;
  idempotencyKey: string;
  baseSceneSpec: Record<string, unknown>;
  baseManifest: Record<string, unknown>;
  baseArtifactPath: string;
  changeSet: Record<string, unknown>;
  catalog: TrustedExternalAssetCatalog;
  registry: AssetArtifactRegistry;
  trustedAssetRoot: string;
  tolerances: ManifestTolerances;
  /** Trusted worker/operator capability. This is not a ChangeSet field. */
  authorizeDccExecution: boolean;
  /** Test-only, trusted environment switches for DCC failure coverage. */
  executionEnvironment?: NodeJS.ProcessEnv;
}

function fail(code: string, message: string, retryable = false): never {
  throw new ExternalAssetIngestionError(code, message, retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, code: string, message: string): Record<string, unknown> {
  return isRecord(value) ? value : fail(code, message);
}

function array(value: unknown, code: string, message: string): unknown[] {
  return Array.isArray(value) ? value : fail(code, message);
}

function stringValue(value: unknown, code: string, message: string): string {
  return typeof value === "string" && value.length > 0 ? value : fail(code, message);
}

function numberVector(value: unknown, code: string, message: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return fail(code, message);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** Worker-only staging helper. Neither caller input nor its return value is portable scene data. */
export function stageExactVerifiedArtifact({
  sourcePath,
  destinationPath,
  artifact,
}: {
  sourcePath: string;
  destinationPath: string;
  artifact: { sha256: string; byteLength: number };
}): { sha256: string; byteLength: number } {
  copyFileSync(sourcePath, destinationPath);
  const byteLength = statSync(destinationPath).size;
  const sha256 = sha256File(destinationPath);
  if (byteLength !== artifact.byteLength || sha256 !== artifact.sha256) {
    fail("ASSET_ARTIFACT_HASH_MISMATCH", "Staged artifact bytes do not match VERIFIED source");
  }
  return { sha256, byteLength };
}

function batchArguments(scriptPath: string): string[] {
  return [scriptPath, "-v", "2", "-dm", "on", "-safescene", "ON"];
}

function normalizedLocks(value: unknown): Record<string, boolean> {
  const source = record(value, "SCHEMA_INVALID", "Asset locks are missing");
  return Object.fromEntries(
    lockPropertyNames.map((property) => [property, source[property] === true]),
  );
}

function catalogDefinitions(
  catalog: TrustedExternalAssetCatalog,
): Map<string, TrustedExternalAssetDefinition> {
  if (
    !isRecord(catalog) ||
    catalog.catalogVersion !== "0.1.0" ||
    !Array.isArray(catalog.definitions)
  ) {
    return fail("ASSET_DEFINITION_CATALOG_INVALID", "Trusted asset definition catalog is invalid");
  }
  const definitions = new Map<string, TrustedExternalAssetDefinition>();
  for (const rawDefinition of catalog.definitions) {
    const definition = record(
      rawDefinition,
      "ASSET_DEFINITION_CATALOG_INVALID",
      "Trusted asset definition is invalid",
    );
    const allowed = new Set([
      "id",
      "version",
      "category",
      "sourceType",
      "artifactId",
      "dimensions",
      "pivotPolicy",
      "allowNonUniformScale",
    ]);
    if (Object.keys(definition).some((key) => !allowed.has(key))) {
      return fail(
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Trusted asset definition contains a non-portable field",
      );
    }
    const normalized: TrustedExternalAssetDefinition = {
      id: stringValue(
        definition.id,
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Definition ID is invalid",
      ),
      version: stringValue(
        definition.version,
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Definition version is invalid",
      ),
      category: stringValue(
        definition.category,
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Definition category is invalid",
      ),
      sourceType:
        definition.sourceType === externalDefinitionSourceType
          ? externalDefinitionSourceType
          : fail("ASSET_DEFINITION_CATALOG_INVALID", "Definition must be external_max"),
      artifactId: stringValue(
        definition.artifactId,
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Definition artifact ID is invalid",
      ),
      dimensions: numberVector(
        definition.dimensions,
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Definition dimensions are invalid",
      ),
      pivotPolicy: stringValue(
        definition.pivotPolicy,
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Definition pivot policy is invalid",
      ),
      allowNonUniformScale:
        typeof definition.allowNonUniformScale === "boolean"
          ? definition.allowNonUniformScale
          : fail("ASSET_DEFINITION_CATALOG_INVALID", "Definition scale policy is invalid"),
    };
    if (
      normalized.dimensions.some((dimension) => dimension <= 0) ||
      definitions.has(normalized.id)
    ) {
      return fail(
        "ASSET_DEFINITION_CATALOG_INVALID",
        "Definition IDs and dimensions must be unique and positive",
      );
    }
    definitions.set(normalized.id, normalized);
  }
  return definitions;
}

function changeSetContract(value: Record<string, unknown>): ChangeSetContract {
  const validation = validateSceneChangeSet(value);
  if (!validation.ok) return fail("SCHEMA_INVALID", "SceneChangeSet structural validation failed");
  const changeSet = validation.value as unknown as ChangeSetContract;
  if (changeSet.operations.length !== 1 || changeSet.operations[0]?.type !== "ReplaceAsset") {
    return fail(
      "OPERATION_UNSUPPORTED",
      "External ingestion supports exactly one ReplaceAsset operation",
    );
  }
  return changeSet;
}

function externalDefinitionFor(
  catalog: TrustedExternalAssetCatalog,
  id: string,
): TrustedExternalAssetDefinition {
  const definition = catalogDefinitions(catalog).get(id);
  if (!definition)
    return fail("ASSET_DEFINITION_NOT_FOUND", `External definition ${id} was not found`);
  return structuredClone(definition);
}

function sourceDefinition(
  definitions: Array<Record<string, unknown>>,
  id: string,
): Record<string, unknown> {
  const matches = definitions.filter((definition) => definition.id === id);
  if (matches.length === 0)
    return fail("ASSET_DEFINITION_NOT_FOUND", `Definition ${id} was not found`);
  if (matches.length !== 1)
    return fail("ASSET_DEFINITION_COLLECTION_INVALID", `Definition ${id} is not unique`);
  return matches[0] as Record<string, unknown>;
}

function assetMaterialId(scene: Record<string, unknown>, logicalId: string): string {
  const assignments = array(
    scene.materialAssignments,
    "SCHEMA_INVALID",
    "SceneSpec material assignments are missing",
  ).map((entry) => record(entry, "SCHEMA_INVALID", "Material assignment is invalid"));
  const assignmentsForTarget = assignments.filter((entry) => entry.targetId === logicalId);
  if (assignmentsForTarget.length !== 1) {
    return fail(
      "MATERIAL_ASSIGNMENT_MISMATCH",
      "Target asset must have exactly one canonical material",
    );
  }
  return stringValue(
    assignmentsForTarget[0]?.materialId,
    "MATERIAL_ASSIGNMENT_MISMATCH",
    "Target material ID is invalid",
  );
}

function validateSpatialFit(
  scene: Record<string, unknown>,
  target: Record<string, unknown>,
  definition: TrustedExternalAssetDefinition,
): void {
  const transform = record(target.transform, "SCHEMA_INVALID", "Target transform is invalid");
  const position = numberVector(transform.position, "SCHEMA_INVALID", "Target position is invalid");
  const scale = numberVector(transform.scale, "SCHEMA_INVALID", "Target scale is invalid");
  if (!definition.allowNonUniformScale && !(scale[0] === scale[1] && scale[1] === scale[2])) {
    fail("NON_UNIFORM_SCALE_NOT_ALLOWED", "External definition forbids non-uniform scale");
  }
  const spaceId = stringValue(target.spaceId, "SCHEMA_INVALID", "Target space is invalid");
  const spaces = array(scene.spaces, "SCHEMA_INVALID", "Scene spaces are missing")
    .map((entry) => record(entry, "SCHEMA_INVALID", "Space is invalid"))
    .filter((space) => space.id === spaceId);
  if (spaces.length !== 1) {
    fail("SPACE_NOT_FOUND", `Target space ${spaceId} was not found`);
  }
  const boundary = array(spaces[0]?.boundary, "SCHEMA_INVALID", "Space boundary is invalid").map(
    (point) => numberVector(point, "SCHEMA_INVALID", "Space boundary point is invalid"),
  );
  const minX = Math.min(...boundary.map((point) => point[0]));
  const maxX = Math.max(...boundary.map((point) => point[0]));
  const minY = Math.min(...boundary.map((point) => point[1]));
  const maxY = Math.max(...boundary.map((point) => point[1]));
  const halfWidth = (definition.dimensions[0] * scale[0]) / 2;
  const halfDepth = (definition.dimensions[1] * scale[1]) / 2;
  if (
    position[0] - halfWidth < minX ||
    position[0] + halfWidth > maxX ||
    position[1] - halfDepth < minY ||
    position[1] + halfDepth > maxY
  ) {
    fail("OBJECT_OUTSIDE_SPACE", "External replacement does not fit its target space");
  }
}

export function assertExternalDefinitionAppend(
  baseSceneSpec: Record<string, unknown>,
  targetSceneSpec: Record<string, unknown>,
  trustedDefinition: TrustedExternalAssetDefinition,
): void {
  const baseDefinitions = array(
    baseSceneSpec.assetDefinitions,
    "SCHEMA_INVALID",
    "Base definitions are missing",
  );
  const targetDefinitions = array(
    targetSceneSpec.assetDefinitions,
    "SCHEMA_INVALID",
    "Target definitions are missing",
  );
  if (targetDefinitions.length !== baseDefinitions.length + 1) {
    fail("ASSET_DEFINITION_COLLECTION_INVALID", "Target must append exactly one asset definition");
  }
  for (let index = 0; index < baseDefinitions.length; index += 1) {
    if (!isDeepStrictEqual(targetDefinitions[index], baseDefinitions[index])) {
      fail(
        "ASSET_DEFINITION_COLLECTION_INVALID",
        "Existing asset definition was modified or rebound",
      );
    }
  }
  const appended = targetDefinitions[targetDefinitions.length - 1];
  if (!isDeepStrictEqual(appended, trustedDefinition)) {
    fail(
      "ASSET_DEFINITION_COLLECTION_INVALID",
      "Appended definition does not match trusted catalog",
    );
  }
  const ids = targetDefinitions.map(
    (definition) => record(definition, "SCHEMA_INVALID", "Definition is invalid").id,
  );
  if (new Set(ids).size !== ids.length) {
    fail("ASSET_DEFINITION_COLLECTION_INVALID", "Target asset definition IDs are not unique");
  }
}

function targetManifest(
  baseManifestValue: Record<string, unknown>,
  targetRevisionId: string,
  targetId: string,
  definition: TrustedExternalAssetDefinition,
): Record<string, unknown> {
  const manifest = structuredClone(baseManifestValue);
  manifest.revisionId = targetRevisionId;
  for (const collectionName of ["nodes", "cameras"] as const) {
    const entries = array(manifest[collectionName], "SCHEMA_INVALID", "Base manifest is invalid");
    for (const rawEntry of entries) {
      const entry = record(rawEntry, "SCHEMA_INVALID", "Manifest entry is invalid");
      const metadata = record(
        entry.embeddedMetadata,
        "SCHEMA_INVALID",
        "Manifest metadata is invalid",
      );
      metadata["AIArchViz.RevisionId"] = targetRevisionId;
      if (collectionName === "nodes" && entry.logicalId === targetId) {
        entry.assetDefinitionId = definition.id;
        entry.dimensions = structuredClone(definition.dimensions);
        metadata["AIArchViz.AssetDefinitionId"] = definition.id;
      }
    }
  }
  const validation = validateSceneManifest(manifest);
  if (!validation.ok) fail("SCHEMA_INVALID", "Target external manifest is invalid");
  return manifest;
}

function inspectionSatisfiesDefinition(
  registry: AssetArtifactRegistry,
  definition: TrustedExternalAssetDefinition,
): void {
  const recordValue = registry.records.find(
    (entry) => entry.artifact.artifactId === definition.artifactId,
  );
  if (!recordValue?.inspection) {
    fail(
      "ASSET_ARTIFACT_INSPECTION_INVALID",
      "Verified external artifact has no inspection evidence",
    );
  }
  const inspection = record(
    recordValue.inspection,
    "ASSET_ARTIFACT_INSPECTION_INVALID",
    "Inspection evidence is invalid",
  );
  const observations = record(
    inspection.observations,
    "ASSET_ARTIFACT_INSPECTION_INVALID",
    "Inspection observations are invalid",
  );
  const geometry = record(
    observations.geometry,
    "ASSET_ARTIFACT_INSPECTION_INVALID",
    "Inspection geometry is invalid",
  );
  const scene = record(
    observations.scene,
    "ASSET_ARTIFACT_INSPECTION_INVALID",
    "Inspection scene is invalid",
  );
  const dependencies = record(
    observations.dependencies,
    "ASSET_ARTIFACT_INSPECTION_INVALID",
    "Inspection dependencies are invalid",
  );
  const security = record(
    observations.security,
    "ASSET_ARTIFACT_INSPECTION_INVALID",
    "Inspection security is invalid",
  );
  const actualDimensions = numberVector(
    geometry.dimensionsMm,
    "ASSET_ARTIFACT_INSPECTION_INVALID",
    "Inspection dimensions are invalid",
  );
  const dimensionsMatch = actualDimensions.every(
    (dimension, index) => Math.abs(dimension - (definition.dimensions[index] as number)) <= 0.01,
  );
  if (
    inspection.result !== "pass" ||
    !dimensionsMatch ||
    geometry.floorCenterAnchorCompatible !== true ||
    scene.nodeCount !== 1 ||
    scene.geometryNodeCount !== 1 ||
    scene.cameraCount !== 0 ||
    scene.lightCount !== 0 ||
    dependencies.missingExternalFiles !== 0 ||
    dependencies.missingDLLs !== 0 ||
    dependencies.xrefs !== 0 ||
    dependencies.externalReferenceCount !== 0 ||
    security.safeSceneScriptExecutionEnabled !== true ||
    security.settingsLocked !== true ||
    security.lockCause !== "cmdline" ||
    security.scriptAssetsProtected !== true
  ) {
    fail(
      "ASSET_ARTIFACT_INSPECTION_INVALID",
      "Inspection evidence is not eligible for controlled merge",
    );
  }
}

/**
 * Pure structural planner. It resolves only worker-owned catalog and registry
 * records; it never reads an artifact file or starts a DCC process.
 */
export function preflightExternalAssetIngestion({
  baseSceneSpec,
  baseManifest,
  changeSet,
  catalog,
  registry,
}: Pick<
  ExternalAssetIngestionInput,
  "baseSceneSpec" | "baseManifest" | "changeSet" | "catalog" | "registry"
>): ExternalAssetIngestionPreflight {
  const sceneValidation = validateSceneSpec(baseSceneSpec);
  if (!sceneValidation.ok) fail("SCHEMA_INVALID", "Base SceneSpec is invalid");
  const manifestValidation = validateSceneManifest(baseManifest);
  if (!manifestValidation.ok) fail("SCHEMA_INVALID", "Base semantic manifest is invalid");
  const contract = changeSetContract(changeSet);
  const scene = sceneValidation.value as Record<string, unknown>;
  const sceneIdentity = record(scene.scene, "SCHEMA_INVALID", "Scene identity is invalid");
  const project = record(scene.project, "SCHEMA_INVALID", "Project identity is invalid");
  if (contract.projectId !== project.id || contract.sceneId !== sceneIdentity.id) {
    fail("IDENTITY_MISMATCH", "ChangeSet identity does not match the base SceneSpec");
  }
  if (contract.baseRevisionId !== sceneIdentity.headRevisionId) {
    fail("STALE_REVISION", "ChangeSet base revision is stale");
  }
  if (contract.targetRevisionId === contract.baseRevisionId) {
    fail("REVISION_STATE_MISMATCH", "External replacement must create a new revision");
  }
  const operation = contract.operations[0];
  const assets = array(scene.assets, "SCHEMA_INVALID", "Scene assets are invalid")
    .map((entry) => record(entry, "SCHEMA_INVALID", "Asset is invalid"))
    .filter((asset) => asset.id === operation.targetId);
  if (assets.length === 0) fail("TARGET_NOT_FOUND", "ReplaceAsset target was not found");
  if (assets.length !== 1) fail("DUPLICATE_LOGICAL_ID", "ReplaceAsset target is not unique");
  const target = assets[0] as Record<string, unknown>;
  if (target.type !== "proxy_asset")
    fail("TARGET_NOT_MANAGED", "ReplaceAsset target is not managed");
  const locks = normalizedLocks(target.locks);
  if (locks.geometry) fail("GEOMETRY_LOCKED", "Geometry lock blocks external replacement");
  const definitions = array(
    scene.assetDefinitions,
    "SCHEMA_INVALID",
    "Scene definitions are invalid",
  ).map((entry) => record(entry, "SCHEMA_INVALID", "Asset definition is invalid"));
  const currentDefinitionId = stringValue(
    target.assetDefinitionId,
    "SCHEMA_INVALID",
    "Target definition ID is invalid",
  );
  const currentDefinition = sourceDefinition(definitions, currentDefinitionId);
  if (currentDefinition.sourceType !== "procedural_proxy") {
    fail("ASSET_DEFINITION_STATE_MISMATCH", "Target is not the expected procedural source");
  }
  const definition = externalDefinitionFor(catalog, operation.parameters.newAssetDefinitionId);
  if (definitions.some((entry) => entry.id === definition.id)) {
    fail(
      "ASSET_DEFINITION_COLLECTION_INVALID",
      "External definition must be catalog-appended once",
    );
  }
  if (currentDefinition.category !== definition.category) {
    fail("ASSET_CATEGORY_INCOMPATIBLE", "External definition category does not match target");
  }
  if (currentDefinition.pivotPolicy !== definition.pivotPolicy) {
    fail("ASSET_PIVOT_INCOMPATIBLE", "External definition pivot policy does not match target");
  }
  validateSpatialFit(scene, target, definition);
  let artifact: { artifactId: string; sha256: string; byteLength: number; format: "3ds_max" };
  try {
    artifact = validateAssetArtifactEligibility(definition, registry);
  } catch (error) {
    if (isRecord(error) && typeof error.code === "string") {
      fail(error.code, error instanceof Error ? error.message : "Artifact eligibility failed");
    }
    throw error;
  }
  inspectionSatisfiesDefinition(registry, definition);

  const targetSceneSpec = structuredClone(scene);
  const targetIdentity = record(
    targetSceneSpec.scene,
    "SCHEMA_INVALID",
    "Target scene identity is invalid",
  );
  targetIdentity.revisionId = contract.targetRevisionId;
  targetIdentity.headRevisionId = contract.targetRevisionId;
  const targetAsset = array(targetSceneSpec.assets, "SCHEMA_INVALID", "Target assets are invalid")
    .map((entry) => record(entry, "SCHEMA_INVALID", "Target asset is invalid"))
    .find((asset) => asset.id === operation.targetId);
  if (!targetAsset) fail("TARGET_NOT_FOUND", "Target disappeared during planning");
  targetAsset.assetDefinitionId = definition.id;
  const targetDefinitions = array(
    targetSceneSpec.assetDefinitions,
    "SCHEMA_INVALID",
    "Target definitions are invalid",
  );
  targetDefinitions.push(structuredClone(definition));
  const revisions = array(
    targetSceneSpec.revisions,
    "SCHEMA_INVALID",
    "Target revisions are invalid",
  );
  revisions.push({
    revisionId: contract.targetRevisionId,
    parentRevisionId: contract.baseRevisionId,
    status: "committed",
    createdAt: contract.metadata.createdAt,
  });
  const targetValidation = validateSceneSpec(targetSceneSpec);
  if (!targetValidation.ok) fail("SCHEMA_INVALID", "Target SceneSpec is invalid");
  assertExternalDefinitionAppend(scene, targetSceneSpec, definition);
  const expectedManifest = targetManifest(
    baseManifest,
    contract.targetRevisionId,
    operation.targetId,
    definition,
  );
  const targetManifestEntry = array(
    expectedManifest.nodes,
    "SCHEMA_INVALID",
    "Expected nodes are invalid",
  )
    .map((entry) => record(entry, "SCHEMA_INVALID", "Expected node is invalid"))
    .find((entry) => entry.logicalId === operation.targetId);
  if (!targetManifestEntry) fail("TARGET_NOT_FOUND", "Target manifest node is missing");
  const transform = record(target.transform, "SCHEMA_INVALID", "Target transform is invalid");
  const plan: ExternalAssetIngestionPlan = {
    ingestionPlanVersion: "0.1.0",
    changeSetId: contract.changeSetId,
    projectId: contract.projectId,
    sceneId: contract.sceneId,
    baseRevisionId: contract.baseRevisionId,
    targetRevisionId: contract.targetRevisionId,
    targetId: operation.targetId,
    currentAssetDefinitionId: currentDefinitionId,
    externalAssetDefinition: definition,
    transform: structuredClone(transform),
    locks,
    materialId: assetMaterialId(scene, operation.targetId),
    expectedManifest,
  };
  return { changeSet: contract, targetSceneSpec, expectedManifest, plan, artifact };
}

export function externalIngestionRequestHash(
  preflight: ExternalAssetIngestionPreflight,
  baseArtifactHash: string,
): string {
  return semanticJsonHash({
    contract: "external-asset-ingestion-v0.1",
    baseArtifactHash,
    changeSet: preflight.changeSet,
    targetSceneSpec: preflight.targetSceneSpec,
    expectedManifest: preflight.expectedManifest,
    externalArtifact: preflight.artifact,
  });
}

function noExecution(
  error: { code: string; message: string },
  partial: Partial<ExternalAssetIngestionResult> = {},
): ExternalAssetIngestionResult {
  return {
    status: "BLOCKED",
    error,
    replayed: false,
    idempotencyKey: partial.idempotencyKey ?? null,
    requestHash: partial.requestHash ?? null,
    workspace: null,
    verifiedOutputPath: null,
    baseArtifactHash: partial.baseArtifactHash ?? null,
    sourceArtifactHash: partial.sourceArtifactHash ?? null,
    stagedArtifactHash: partial.stagedArtifactHash ?? null,
    dcc: null,
    compatibilityMode: false,
    mutationProcess: null,
    verificationProcess: null,
    comparison: null,
    semanticDiff: null,
  };
}

function processFailureCode(result: ControlledProcessResult, fallback: string): string {
  return result.errorCode ?? fallback;
}

function resultError(error: unknown): { code: string; message: string } {
  const codedError =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  return {
    // Asset-trust resolution deliberately owns its WorkerError type. Preserve
    // its stable public code here without coupling this adapter to that module's
    // error implementation.
    code: codedError ?? "EXTERNAL_ASSET_INGESTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function updateLedger(
  workspaceRoot: string,
  active: IdempotencyLedgerRecord,
  result: ExternalAssetIngestionResult,
): void {
  const now = new Date().toISOString();
  const success = result.status === "SUCCESS";
  writeLedgerAtomic(workspaceRoot, {
    ...active,
    status: success ? "SUCCESS" : "FAILED_FINAL",
    successfulJobId: success ? active.latestJobId : null,
    retryable: false,
    errorCode: result.error?.code ?? null,
    completedAt: now,
    updatedAt: now,
    reportPath: null,
    verifiedOutputPath:
      success && result.workspace && result.verifiedOutputPath
        ? resolve(result.workspace, "output/project.max")
        : null,
    manifestPath:
      success && result.workspace
        ? resolve(result.workspace, "verification/scene-manifest.json")
        : null,
    verifiedOutputHash:
      success && result.verifiedOutputPath ? sha256File(result.verifiedOutputPath) : null,
    manifestHash:
      success && result.workspace
        ? semanticJsonHash(readJson(resolve(result.workspace, "verification/scene-manifest.json")))
        : null,
    dccVersion: result.dcc?.version ?? null,
    compatibilityMode: result.compatibilityMode,
  });
}

function replayResult(
  record: IdempotencyLedgerRecord,
  idempotencyKey: string,
  requestHash: string,
): ExternalAssetIngestionResult {
  if (!record.verifiedOutputPath || !existsSync(record.verifiedOutputPath)) {
    return noExecution(
      { code: "RECOVERY_REQUIRED", message: "Stored external ingestion output is unavailable" },
      { idempotencyKey, requestHash },
    );
  }
  return {
    status: "SUCCESS",
    error: null,
    replayed: true,
    idempotencyKey,
    requestHash,
    workspace: dirname(dirname(record.verifiedOutputPath)),
    verifiedOutputPath: record.verifiedOutputPath,
    baseArtifactHash: null,
    sourceArtifactHash: null,
    stagedArtifactHash: null,
    dcc: null,
    compatibilityMode: record.compatibilityMode,
    mutationProcess: null,
    verificationProcess: null,
    comparison: null,
    semanticDiff: null,
  };
}

function safeErrorMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && !/[A-Z]:\\|\\\\/iu.test(value) ? value : fallback;
}

export function diffExternalSemanticManifests(
  beforeValue: Record<string, unknown>,
  afterValue: Record<string, unknown>,
): {
  changed: Array<{
    logicalId: string;
    changes: Record<string, { before: unknown; after: unknown }>;
  }>;
  unchanged: string[];
  added: string[];
  removed: string[];
} {
  const index = (value: Record<string, unknown>): Map<string, Record<string, unknown>> => {
    const values = [
      ...array(value.nodes, "SCHEMA_INVALID", "Manifest nodes are missing"),
      ...array(value.cameras, "SCHEMA_INVALID", "Manifest cameras are missing"),
    ];
    return new Map(
      values.map((entry) => {
        const node = record(entry, "SCHEMA_INVALID", "Manifest node is invalid");
        return [
          stringValue(node.logicalId, "SCHEMA_INVALID", "Manifest logical ID is invalid"),
          node,
        ];
      }),
    );
  };
  const before = index(beforeValue);
  const after = index(afterValue);
  const changed: Array<{
    logicalId: string;
    changes: Record<string, { before: unknown; after: unknown }>;
  }> = [];
  const unchanged: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [logicalId, previous] of before) {
    const next = after.get(logicalId);
    if (!next) {
      removed.push(logicalId);
      continue;
    }
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      "assetDefinitionId",
      "dimensions",
      "transform",
      "materialId",
      "locks",
    ] as const) {
      if (!isDeepStrictEqual(previous[field], next[field])) {
        changes[field] = { before: previous[field], after: next[field] };
      }
    }
    if (Object.keys(changes).length === 0) unchanged.push(logicalId);
    else changed.push({ logicalId, changes });
  }
  for (const logicalId of after.keys()) if (!before.has(logicalId)) added.push(logicalId);
  return {
    changed: changed.sort((left, right) => left.logicalId.localeCompare(right.logicalId)),
    unchanged: unchanged.sort(),
    added: added.sort(),
    removed: removed.sort(),
  };
}

/**
 * Controlled production mutation. All artifact checks run before discovery or
 * DCC launch; only the worker-staged copy is sent to the mutation process.
 */
export async function ingestVerifiedExternalMaxAsset(
  input: ExternalAssetIngestionInput,
): Promise<ExternalAssetIngestionResult> {
  let preflight: ExternalAssetIngestionPreflight;
  let baseArtifactHash: string;
  try {
    preflight = preflightExternalAssetIngestion(input);
    if (!existsSync(input.baseArtifactPath) || statSync(input.baseArtifactPath).size <= 0) {
      return noExecution({
        code: "BASE_ARTIFACT_MISSING",
        message: "Verified base artifact is unavailable",
      });
    }
    baseArtifactHash = sha256File(input.baseArtifactPath);
  } catch (error) {
    return noExecution(resultError(error));
  }
  const requestHash = externalIngestionRequestHash(preflight, baseArtifactHash);
  const ledgerPartial = { idempotencyKey: input.idempotencyKey, requestHash, baseArtifactHash };
  if (
    !isDccExecutionAuthorized({
      allowDccExecution: input.config.allowDccExecution,
      authorizeDccExecution: input.authorizeDccExecution,
    })
  ) {
    return noExecution(
      {
        code: "DCC_EXECUTION_DISABLED",
        message: "External ingestion requires allowDccExecution=true and trusted DCC authorization",
      },
      ledgerPartial,
    );
  }
  let source: Awaited<ReturnType<typeof resolveVerifiedAssetArtifact>>;
  try {
    source = await resolveVerifiedAssetArtifact({
      artifactId: preflight.artifact.artifactId,
      trustedAssetRoot: input.trustedAssetRoot,
      registry: input.registry,
    });
  } catch (error) {
    return noExecution(resultError(error), ledgerPartial);
  }
  let idempotencyLock: ReturnType<typeof acquireExecutionLock> | null = null;
  let sceneLock: ReturnType<typeof acquireExecutionLock> | null = null;
  let activeLedger: IdempotencyLedgerRecord | null = null;
  try {
    idempotencyLock = acquireExecutionLock(
      input.config.workspaceRoot,
      "idempotency",
      input.idempotencyKey,
      input.jobId,
    );
    const previous = readLedger(input.config.workspaceRoot, input.idempotencyKey);
    const decision = evaluateLedger(previous, {
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    if (decision === "IDEMPOTENCY_KEY_REUSE_MISMATCH") {
      return noExecution(
        {
          code: "IDEMPOTENCY_KEY_REUSE_MISMATCH",
          message: "Idempotency key is bound to another request",
        },
        ledgerPartial,
      );
    }
    if (decision === "REPLAY_SUCCESS" && previous) {
      return replayResult(previous, input.idempotencyKey, requestHash);
    }
    if (decision === "REPLAY_FAILURE" && previous) {
      return noExecution(
        {
          code: previous.errorCode ?? "FAILED_FINAL",
          message: "Stored external ingestion failure replayed",
        },
        ledgerPartial,
      );
    }
    sceneLock = acquireExecutionLock(
      input.config.workspaceRoot,
      "scene",
      `${preflight.changeSet.projectId}\u0000${preflight.changeSet.sceneId}`,
      input.jobId,
    );
    activeLedger = startLedgerAttempt(previous, {
      idempotencyKey: input.idempotencyKey,
      requestHash,
      jobId: input.jobId,
    });
    writeLedgerAtomic(input.config.workspaceRoot, activeLedger);
    const workspace = createJobWorkspace(input.config.workspaceRoot, input.jobId);
    const stagedAssetPath = resolve(workspace.input, "replacement.max");
    copyFileSync(input.baseArtifactPath, workspace.baseScenePath);
    if (sha256File(workspace.baseScenePath) !== baseArtifactHash) {
      return noExecution(
        {
          code: "BASE_ARTIFACT_COPY_MISMATCH",
          message: "Base checkpoint changed during workspace copy",
        },
        ledgerPartial,
      );
    }
    let stagedArtifactHash: string;
    try {
      stagedArtifactHash = stageExactVerifiedArtifact({
        sourcePath: source.internalPath,
        destinationPath: stagedAssetPath,
        artifact: source,
      }).sha256;
    } catch (error) {
      return noExecution(resultError(error), {
        ...ledgerPartial,
        sourceArtifactHash: source.sha256,
      });
    }
    writeDeterministicJson(workspace.sceneSpecPath, input.baseSceneSpec);
    writeDeterministicJson(workspace.targetSceneSpecPath, preflight.targetSceneSpec);
    writeDeterministicJson(workspace.expectedManifestPath, preflight.expectedManifest);
    writeDeterministicJson(workspace.changeSetPath, preflight.changeSet);
    writeDeterministicJson(workspace.revisionPlanPath, preflight.plan);
    const dcc = await discoverThreeDsMax({
      installationOverride: input.config.threeDsMaxInstallationPath,
    });
    if (dcc.status === "NOT_FOUND" || !dcc.batchExecutablePath) {
      const result = noExecution(
        { code: "DCC_NOT_FOUND", message: "3ds Max Batch is unavailable" },
        ledgerPartial,
      );
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    const compatibilityMode = dcc.status === "UNSUPPORTED";
    if (
      compatibilityMode &&
      !(input.config.allowCompatibilityVersionForSpike && dcc.version === "2025")
    ) {
      const result = noExecution(
        { code: "DCC_VERSION_UNSUPPORTED", message: "Target DCC version is 2026" },
        { ...ledgerPartial, dcc },
      );
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    const timeoutMs = input.config.processTimeoutMs;
    const mutationProcess = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(
        resolve(input.config.repositoryRoot, "tools/3ds-max/python/ingest_external_asset.py"),
      ),
      cwd: dcc.installationPath ?? dirname(dcc.batchExecutablePath),
      timeoutMs,
      env: {
        ...process.env,
        ...input.executionEnvironment,
        AI_ARCHVIZ_EXTERNAL_BASE_SCENE_PATH: workspace.baseScenePath,
        AI_ARCHVIZ_EXTERNAL_STAGED_ASSET_PATH: stagedAssetPath,
        AI_ARCHVIZ_EXTERNAL_CANDIDATE_PATH: workspace.candidatePath,
        AI_ARCHVIZ_EXTERNAL_PLAN_PATH: workspace.revisionPlanPath,
        AI_ARCHVIZ_EXTERNAL_MUTATION_RESULT_PATH: workspace.mutationResultPath,
      },
      outputEncoding: "utf16le",
    });
    const mutationResult = existsSync(workspace.mutationResultPath)
      ? (readJson(workspace.mutationResultPath) as Record<string, unknown>)
      : null;
    if (mutationProcess.errorCode || mutationResult?.status !== "SUCCESS") {
      const result: ExternalAssetIngestionResult = {
        ...noExecution(
          {
            code:
              mutationResult && typeof mutationResult.errorCode === "string"
                ? mutationResult.errorCode
                : processFailureCode(mutationProcess, "EXTERNAL_ASSET_MUTATION_FAILED"),
            message: safeErrorMessage(mutationResult?.message, "External asset mutation failed"),
          },
          { ...ledgerPartial, sourceArtifactHash: source.sha256, stagedArtifactHash },
        ),
        status: "FAILED",
        workspace: workspace.root,
        dcc,
        compatibilityMode,
        mutationProcess,
      };
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    if (!existsSync(workspace.candidatePath) || statSync(workspace.candidatePath).size <= 0) {
      const result: ExternalAssetIngestionResult = {
        ...noExecution(
          { code: "CANDIDATE_MISSING", message: "Mutation produced no candidate" },
          ledgerPartial,
        ),
        status: "FAILED",
        workspace: workspace.root,
        dcc,
        compatibilityMode,
        mutationProcess,
      };
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    const verificationProcess = await runControlledProcess({
      executable: dcc.batchExecutablePath,
      args: batchArguments(
        resolve(input.config.repositoryRoot, "tools/3ds-max/python/verify_scene.py"),
      ),
      cwd: dcc.installationPath ?? dirname(dcc.batchExecutablePath),
      timeoutMs,
      env: {
        ...process.env,
        ...input.executionEnvironment,
        AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
        AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
        AI_ARCHVIZ_MANIFEST_PATH: workspace.manifestPath,
        AI_ARCHVIZ_VERIFY_RESULT_PATH: workspace.verificationResultPath,
      },
      outputEncoding: "utf16le",
    });
    const verificationResult = existsSync(workspace.verificationResultPath)
      ? (readJson(workspace.verificationResultPath) as Record<string, unknown>)
      : null;
    if (
      verificationProcess.errorCode ||
      verificationResult?.status !== "SUCCESS" ||
      !existsSync(workspace.manifestPath)
    ) {
      const result: ExternalAssetIngestionResult = {
        ...noExecution(
          {
            code:
              verificationResult && typeof verificationResult.errorCode === "string"
                ? verificationResult.errorCode
                : processFailureCode(verificationProcess, "EXTERNAL_ASSET_VERIFICATION_FAILED"),
            message: safeErrorMessage(
              verificationResult?.message,
              "Fresh external candidate verification failed",
            ),
          },
          { ...ledgerPartial, sourceArtifactHash: source.sha256, stagedArtifactHash },
        ),
        status: "FAILED",
        workspace: workspace.root,
        dcc,
        compatibilityMode,
        mutationProcess,
        verificationProcess,
      };
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    const actualManifest = readJson(workspace.manifestPath) as Record<string, unknown>;
    if (!validateSceneManifest(actualManifest).ok) {
      const result: ExternalAssetIngestionResult = {
        ...noExecution(
          { code: "SCHEMA_INVALID", message: "Fresh manifest is structurally invalid" },
          ledgerPartial,
        ),
        status: "FAILED",
        workspace: workspace.root,
        dcc,
        compatibilityMode,
        mutationProcess,
        verificationProcess,
      };
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    const comparison = compareSceneManifests(
      preflight.expectedManifest,
      actualManifest,
      input.tolerances,
    );
    if (!comparison.ok) {
      const result: ExternalAssetIngestionResult = {
        ...noExecution(
          { code: "MANIFEST_MISMATCH", message: "Fresh semantic manifest differs from target" },
          ledgerPartial,
        ),
        status: "FAILED",
        workspace: workspace.root,
        dcc,
        compatibilityMode,
        mutationProcess,
        verificationProcess,
        comparison,
      };
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    if (
      sha256File(input.baseArtifactPath) !== baseArtifactHash ||
      sha256File(source.internalPath) !== source.sha256
    ) {
      const result: ExternalAssetIngestionResult = {
        ...noExecution(
          { code: "SOURCE_ARTIFACT_MUTATED", message: "Base or verified source artifact changed" },
          ledgerPartial,
        ),
        status: "FAILED",
        workspace: workspace.root,
        dcc,
        compatibilityMode,
        mutationProcess,
        verificationProcess,
        comparison,
      };
      updateLedger(input.config.workspaceRoot, activeLedger, result);
      return result;
    }
    promoteCandidate(workspace.candidatePath, workspace.outputPath);
    const result: ExternalAssetIngestionResult = {
      status: "SUCCESS",
      error: null,
      replayed: false,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      workspace: workspace.root,
      verifiedOutputPath: workspace.outputPath,
      baseArtifactHash,
      sourceArtifactHash: source.sha256,
      stagedArtifactHash,
      dcc,
      compatibilityMode,
      mutationProcess,
      verificationProcess,
      comparison,
      semanticDiff: diffExternalSemanticManifests(input.baseManifest, actualManifest),
    };
    updateLedger(input.config.workspaceRoot, activeLedger, result);
    return result;
  } catch (error) {
    if (error instanceof ExecutionLockedError)
      return noExecution(resultError(error), ledgerPartial);
    const result: ExternalAssetIngestionResult = {
      ...noExecution(resultError(error), ledgerPartial),
      status: "FAILED",
    };
    if (activeLedger) updateLedger(input.config.workspaceRoot, activeLedger, result);
    return result;
  } finally {
    sceneLock?.release();
    idempotencyLock?.release();
  }
}
