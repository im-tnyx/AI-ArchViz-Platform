import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type SceneChangeSet,
  validateSceneChangeSet,
  validateSceneSpec,
} from "@ai-archviz/scene-spec";
import {
  type CanonicalCameraStateEvidence,
  type CanonicalMaterialStateEvidence,
  type JobEnvelope,
  semanticJsonHash,
  validateCanonicalCameraStateEvidence,
  validateCanonicalMaterialStateEvidence,
  validateCanonicalRenderStateEvidence,
  validateExecutionReport,
  validateJobEnvelope,
  validateSceneManifest,
  verifyJobHashes,
} from "@ai-archviz/worker-contracts";
import {
  compileGoldenBuildPlan,
  type SemanticTransform,
  type Vector3,
  wallFrame,
} from "./build-plan.js";
import {
  deriveCameraFovDegrees,
  deriveCameraFovRadians,
  deriveLookAtRotationEuler,
  targetDistanceMm,
} from "./camera-policy.js";
import type { WorkerConfig } from "./config.js";
import {
  coronaCanonicalAreaLightWidthMm,
  coronaCanonicalIntensityScale,
  isSupportedCanonicalCoronaLightType,
  sortCanonicalCoronaLights,
} from "./corona-renderer-policy.js";
import { threeDsMaxBatchArguments } from "./dcc-batch.js";
import { buildDccChildEnvironment } from "./dcc-environment.js";
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
import { resolveWithinRoot } from "./paths.js";
import { type ControlledProcessResult, runControlledProcess } from "./process.js";
import {
  createJobWorkspace,
  type JobWorkspace,
  promoteCandidate,
  readJson,
  writeDeterministicJson,
} from "./workspace.js";

const targetDccVersion = "2026";

interface MoveObjectOperation {
  operationId: string;
  type: "MoveObject";
  targetId: string;
  parameters: { transform: SemanticTransform };
}

interface UpdateOpeningOperation {
  operationId: string;
  type: "UpdateOpening";
  targetId: string;
  parameters: { offset: number; width: number; sill: number; height: number };
}

interface AssignMaterialOperation {
  operationId: string;
  type: "AssignMaterial";
  targetId: string;
  parameters: { materialId: string };
}

interface LockPropertyOperation {
  operationId: string;
  type: "LockProperty";
  targetId: string;
  parameters: { propertyPath: LockPropertyPath };
}

interface UnlockPropertyOperation {
  operationId: string;
  type: "UnlockProperty";
  targetId: string;
  parameters: { propertyPath: LockPropertyPath };
}

interface ReplaceAssetOperation {
  operationId: string;
  type: "ReplaceAsset";
  targetId: string;
  parameters: {
    newAssetDefinitionId: string;
    placementPolicy: "preserve_anchor";
  };
}

interface SetRenderIntentOperation {
  operationId: string;
  type: "SetRenderIntent";
  targetId: string;
  parameters: { engine: "corona"; mode: "preview" };
}

interface AddLightOperation {
  operationId: string;
  type: "AddLight";
  targetId: string;
  parameters: {
    light: {
      id: string;
      type: "area";
      transform: SemanticTransform;
      intensity: number;
    };
  };
}

interface MigrateMaterialAppearanceContractOperation {
  operationId: string;
  type: "MigrateMaterialAppearanceContract";
  targetId: string;
  parameters: {
    targetSceneSpecVersion: "0.3.0";
    materials: Array<{ materialId: string; roughness: number; metalness: number }>;
  };
}

interface SetCameraOperation {
  operationId: string;
  type: "SetCamera";
  targetId: string;
  parameters: {
    position: Vector3;
    target: Vector3;
    orientationPolicy: "look_at_target";
    focalLengthMm: number;
    sensorWidthMm: number;
  };
}

type LockPropertyPath = "geometry" | "transform" | "material";
type PropertyLockOperation = LockPropertyOperation | UnlockPropertyOperation;

type SupportedOperation =
  | MoveObjectOperation
  | UpdateOpeningOperation
  | AssignMaterialOperation
  | PropertyLockOperation
  | ReplaceAssetOperation
  | SetRenderIntentOperation
  | AddLightOperation
  | MigrateMaterialAppearanceContractOperation
  | SetCameraOperation;

interface ChangeSetContract extends SceneChangeSet {
  schemaVersion: "0.1.0" | "0.2.0" | "0.3.0";
  changeSetId: string;
  projectId: string;
  sceneId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  operations: [SupportedOperation];
  metadata: { createdAt: string };
}

interface SceneDocument extends Record<string, unknown> {
  sceneSpecVersion: string;
  project: { id: string };
  scene: { id: string; revisionId: string; headRevisionId: string };
  spaces: Array<{
    id: string;
    boundary: Vector3[];
    floorElevation: number;
    ceilingHeight: number;
  }>;
  assets: Array<{
    id: string;
    type: string;
    spaceId: string;
    assetDefinitionId: string;
    transform: SemanticTransform;
    locks: { geometry: boolean; transform: boolean; material: boolean };
  }>;
  assetDefinitions: Array<{
    id: string;
    category: string;
    sourceType: "procedural_proxy" | "external_max";
    dimensions: Vector3;
    pivotPolicy: string;
    allowNonUniformScale: boolean;
  }>;
  geometry: Array<{
    id: string;
    type: string;
    start?: Vector3;
    end?: Vector3;
    height?: number;
    locks: { geometry: boolean; transform: boolean; material: boolean };
  }>;
  openings: Array<{
    id: string;
    type: string;
    hostGeometryId: string;
    offset: number;
    width: number;
    sill: number;
    height: number;
    transform: SemanticTransform;
    locks: { geometry: boolean; transform: boolean; material: boolean };
  }>;
  cameras: Array<{
    id: string;
    spaceId: string;
    transform: SemanticTransform;
    target: Vector3;
    orientationPolicy: "look_at_target";
    focalLengthMm: number;
    sensorWidthMm: number;
  }>;
  materials: Array<{
    id: string;
    name: string;
    baseColorRgb: Vector3;
    roughness?: number;
    metalness?: number;
  }>;
  materialAssignments: Array<{ id: string; targetId: string; materialId: string }>;
  revisions: Array<Record<string, unknown>>;
  render: { engine: "none" | "corona" | "vray"; mode: "build_only" | "preview" | "final" };
  lights?: Array<{
    id: string;
    type: "point" | "directional" | "area";
    transform: SemanticTransform;
    intensity: number;
  }>;
}

interface WallSegmentPlan {
  name: string;
  hostLogicalId: string;
  center: Vector3;
  dimensions: Vector3;
  rotationZ: number;
}

interface MoveMutation {
  operationId: string;
  type: "MoveObject";
  targetId: string;
  transform: SemanticTransform;
}

interface OpeningMutation {
  operationId: string;
  type: "UpdateOpening";
  targetId: string;
  hostLogicalId: string;
  offset: number;
  width: number;
  sill: number;
  height: number;
  transform: SemanticTransform;
  physicalPosition: Vector3;
  wallSegments: WallSegmentPlan[];
}

interface MaterialMutation {
  operationId: string;
  type: "AssignMaterial";
  targetId: string;
  material: { id: string; baseColorRgb: Vector3 };
}

interface LockMutation {
  operationId: string;
  type: "LockProperty" | "UnlockProperty";
  targetId: string;
  propertyPath: LockPropertyPath;
}

interface ReplaceAssetMutation {
  operationId: string;
  type: "ReplaceAsset";
  targetId: string;
  oldAssetDefinitionId: string;
  newAssetDefinition: {
    id: string;
    category: string;
    dimensions: Vector3;
    pivotPolicy: string;
    allowNonUniformScale: boolean;
  };
  placementPolicy: "preserve_anchor";
}

interface SetRenderIntentMutation {
  operationId: string;
  type: "SetRenderIntent";
  targetId: string;
  engine: "corona";
  mode: "preview";
}

interface AddLightMutation {
  operationId: string;
  type: "AddLight";
  targetId: string;
  renderEngine: "corona";
  renderMode: "preview";
  light: {
    id: string;
    type: "area";
    transform: SemanticTransform;
    intensity: number;
  };
}

interface MigrateMaterialAppearanceMutation {
  operationId: string;
  type: "MigrateMaterialAppearanceContract";
  targetId: string;
  targetSceneSpecVersion: "0.3.0";
  materials: Array<{
    materialId: string;
    baseColorRgb: Vector3;
    roughness: number;
    metalness: number;
  }>;
  materialAssignments: Array<{ targetId: string; materialId: string }>;
}

interface SetCameraMutation {
  operationId: string;
  type: "SetCamera";
  targetId: string;
  position: Vector3;
  target: Vector3;
  orientationPolicy: "look_at_target";
  derivedRotationEuler: Vector3;
  focalLengthMm: number;
  sensorWidthMm: number;
  fovRadians: number;
  fovDegrees: number;
}

export interface RevisionMutationPlan {
  revisionPlanVersion: "0.1.0" | "0.2.0" | "0.3.0";
  changeSetId: string;
  projectId: string;
  sceneId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  operation:
    | MoveMutation
    | OpeningMutation
    | MaterialMutation
    | LockMutation
    | ReplaceAssetMutation
    | SetRenderIntentMutation
    | AddLightMutation
    | MigrateMaterialAppearanceMutation
    | SetCameraMutation;
  expectedManagedLogicalIds: string[];
}

export interface SemanticObjectChange {
  logicalId: string;
  changes: Record<string, { before: unknown; after: unknown }>;
}

export interface SemanticRevisionDiff {
  revision: { before: string; after: string };
  changed: SemanticObjectChange[];
  unchanged: string[];
  added: string[];
  removed: string[];
}

interface ReportError {
  code: string;
  message: string;
  retryable: boolean;
}

export type CanonicalRenderStateEvidence = Record<string, unknown>;

interface RevisionExecutionReport {
  reportVersion: "0.1.0";
  jobId: string;
  idempotencyKey: string;
  requestHash: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  status: "SUCCESS" | "FAILED" | "BLOCKED";
  startedAt: string;
  completedAt: string;
  candidatePath: "candidate/project.max" | null;
  verifiedOutputPath: "output/project.max" | null;
  manifestPath: "verification/scene-manifest.json" | null;
  validationResult: { status: "PASS" | "FAIL"; errors: ReportError[] };
  verificationResult: { status: "PASS" | "FAIL" | "NOT_RUN"; errors: ReportError[] };
  error: ReportError | null;
}

export interface RevisionResult {
  workerVersion: "0.1.0";
  status: "SUCCESS" | "FAILED" | "BLOCKED";
  targetVersion: "2026";
  dccVersion: string | null;
  compatibilityMode: boolean;
  dcc: ThreeDsMaxDiscoveryResult | null;
  workspace: string | null;
  mutationProcess: ControlledProcessResult | null;
  verificationProcess: ControlledProcessResult | null;
  renderStateVerificationProcess: ControlledProcessResult | null;
  renderStateEvidence: CanonicalRenderStateEvidence | null;
  materialStateVerificationProcess: ControlledProcessResult | null;
  materialStateEvidence: CanonicalMaterialStateEvidence | null;
  cameraStateVerificationProcess: ControlledProcessResult | null;
  cameraStateEvidence: CanonicalCameraStateEvidence | null;
  comparison: ReturnType<typeof compareSceneManifests> | null;
  semanticDiff: SemanticRevisionDiff | null;
  report: RevisionExecutionReport | null;
  error: ReportError | null;
  replayed: boolean;
  originalJobId: string | null;
  currentJobId: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  verifiedOutputPath: string | null;
  baseArtifactPath: string | null;
  baseArtifactHash: string | null;
}

export class RevisionValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "RevisionValidationError";
  }
}

export interface AssetReplacementCandidateValidation {
  logicalId: string;
  currentAssetDefinitionId: string;
  candidateAssetDefinitionId: string;
  placementPolicy: "preserve_anchor";
}

/**
 * Pure preflight for the future ReplaceAsset operation. It deliberately does
 * not change the SceneSpec or produce a DCC mutation plan.
 */
export function validateAssetReplacementCandidate(
  sceneValue: Record<string, unknown>,
  logicalId: string,
  candidateAssetDefinitionId: string,
): AssetReplacementCandidateValidation {
  const sceneValidation = validateSceneSpec(sceneValue);
  if (!sceneValidation.ok) {
    throw new RevisionValidationError("SCHEMA_INVALID", "SceneSpec is invalid");
  }
  const scene = sceneValidation.value as SceneDocument;
  const assets = scene.assets.filter((asset) => asset.id === logicalId);
  if (assets.length === 0) {
    throw new RevisionValidationError("TARGET_NOT_FOUND", `Asset ${logicalId} was not found`);
  }
  if (assets.length > 1) {
    throw new RevisionValidationError("DUPLICATE_LOGICAL_ID", `Asset ${logicalId} is not unique`);
  }
  const target = assets[0] as SceneDocument["assets"][number];
  if (target.type !== "proxy_asset") {
    throw new RevisionValidationError(
      "TARGET_NOT_MANAGED",
      `Asset ${logicalId} is not a proxy asset`,
    );
  }
  if (target.locks.geometry) {
    throw new RevisionValidationError("GEOMETRY_LOCKED", `Asset ${logicalId} geometry is locked`);
  }
  const currentDefinition = scene.assetDefinitions.find(
    (definition) => definition.id === target.assetDefinitionId,
  );
  if (!currentDefinition) {
    throw new RevisionValidationError(
      "ASSET_DEFINITION_NOT_FOUND",
      `Asset ${logicalId} references missing definition ${target.assetDefinitionId}`,
    );
  }
  const candidateDefinition = scene.assetDefinitions.find(
    (definition) => definition.id === candidateAssetDefinitionId,
  );
  if (!candidateDefinition) {
    throw new RevisionValidationError(
      "ASSET_DEFINITION_NOT_FOUND",
      `Candidate definition ${candidateAssetDefinitionId} was not found`,
    );
  }
  if (candidateDefinition.id === currentDefinition.id) {
    throw new RevisionValidationError(
      "ASSET_DEFINITION_UNCHANGED",
      `Asset ${logicalId} already uses definition ${candidateAssetDefinitionId}`,
    );
  }
  if (
    currentDefinition.sourceType !== "procedural_proxy" ||
    candidateDefinition.sourceType !== "procedural_proxy"
  ) {
    throw new RevisionValidationError(
      "ASSET_EXTERNAL_SOURCE_UNSUPPORTED",
      "ReplaceAsset supports procedural_proxy definitions only in Spike 7A",
    );
  }
  if (candidateDefinition.category !== currentDefinition.category) {
    throw new RevisionValidationError(
      "ASSET_CATEGORY_INCOMPATIBLE",
      `Candidate category ${candidateDefinition.category} does not match ${currentDefinition.category}`,
    );
  }
  if (candidateDefinition.pivotPolicy !== currentDefinition.pivotPolicy) {
    throw new RevisionValidationError(
      "ASSET_PIVOT_INCOMPATIBLE",
      `Candidate pivot ${candidateDefinition.pivotPolicy} does not match ${currentDefinition.pivotPolicy}`,
    );
  }
  validatePlacement(
    scene,
    { ...target, assetDefinitionId: candidateAssetDefinitionId },
    target.transform,
  );
  return {
    logicalId,
    currentAssetDefinitionId: currentDefinition.id,
    candidateAssetDefinitionId,
    placementPolicy: "preserve_anchor",
  };
}

export function planSceneRevision(
  baseValue: Record<string, unknown>,
  changeSetValue: unknown,
): {
  changeSet: ChangeSetContract;
  targetSceneSpec: Record<string, unknown>;
  plan: RevisionMutationPlan;
} {
  const submittedOperations =
    changeSetValue && typeof changeSetValue === "object" && !Array.isArray(changeSetValue)
      ? (changeSetValue as { operations?: unknown }).operations
      : undefined;
  if (
    Array.isArray(submittedOperations) &&
    submittedOperations.some(
      (operation) =>
        operation &&
        typeof operation === "object" &&
        ![
          "MoveObject",
          "UpdateOpening",
          "AssignMaterial",
          "LockProperty",
          "UnlockProperty",
          "ReplaceAsset",
          "SetRenderIntent",
          "AddLight",
          "MigrateMaterialAppearanceContract",
          "SetCamera",
        ].includes(String((operation as { type?: unknown }).type)),
    )
  ) {
    throw new RevisionValidationError(
      "OPERATION_UNSUPPORTED",
      "Revision runner supports MoveObject, UpdateOpening, AssignMaterial, LockProperty, UnlockProperty, ReplaceAsset, SetRenderIntent, AddLight, MigrateMaterialAppearanceContract, and SetCamera only",
    );
  }
  const baseValidation = validateSceneSpec(baseValue);
  if (!baseValidation.ok)
    throw new RevisionValidationError("SCHEMA_INVALID", "Base SceneSpec is invalid");
  const changeValidation = validateSceneChangeSet(changeSetValue);
  if (!changeValidation.ok) {
    throw new RevisionValidationError(
      "SCHEMA_INVALID",
      `SceneChangeSet validation failed: ${JSON.stringify(changeValidation.errors)}`,
    );
  }
  const base = baseValidation.value as SceneDocument;
  const changeSet = changeValidation.value as ChangeSetContract;
  if (changeSet.projectId !== base.project.id) {
    throw new RevisionValidationError("IDENTITY_MISMATCH", "ChangeSet projectId does not match");
  }
  if (changeSet.sceneId !== base.scene.id) {
    throw new RevisionValidationError("IDENTITY_MISMATCH", "ChangeSet sceneId does not match");
  }
  if (changeSet.baseRevisionId !== base.scene.headRevisionId) {
    throw new RevisionValidationError(
      "STALE_REVISION",
      `Expected base ${base.scene.headRevisionId}, received ${changeSet.baseRevisionId}`,
    );
  }
  if (changeSet.targetRevisionId === changeSet.baseRevisionId) {
    throw new RevisionValidationError(
      "REVISION_STATE_MISMATCH",
      "targetRevisionId must differ from baseRevisionId",
    );
  }
  const [operation] = changeSet.operations;
  const targetSceneSpec = structuredClone(baseValue) as SceneDocument;
  targetSceneSpec.scene.revisionId = changeSet.targetRevisionId;
  targetSceneSpec.scene.headRevisionId = changeSet.targetRevisionId;
  let mutation:
    | MoveMutation
    | OpeningMutation
    | MaterialMutation
    | LockMutation
    | ReplaceAssetMutation
    | SetRenderIntentMutation
    | AddLightMutation
    | MigrateMaterialAppearanceMutation
    | SetCameraMutation;
  if (operation?.type === "SetRenderIntent") {
    if (operation.targetId !== base.scene.id) {
      throw new RevisionValidationError(
        "TARGET_NOT_FOUND",
        `Scene target ${operation.targetId} was not found`,
      );
    }
    if (
      base.render.engine === operation.parameters.engine &&
      base.render.mode === operation.parameters.mode
    ) {
      throw new RevisionValidationError(
        "RENDER_INTENT_UNCHANGED",
        "Requested render intent is already canonical",
      );
    }
    targetSceneSpec.render = { engine: "corona", mode: "preview" };
    mutation = {
      operationId: operation.operationId,
      type: "SetRenderIntent",
      targetId: operation.targetId,
      engine: "corona",
      mode: "preview",
    };
  } else if (operation?.type === "AddLight") {
    if (operation.targetId !== base.scene.id) {
      throw new RevisionValidationError(
        "TARGET_NOT_FOUND",
        `Scene target ${operation.targetId} was not found`,
      );
    }
    if (base.render.engine !== "corona" || base.render.mode !== "preview") {
      throw new RevisionValidationError(
        "RENDERER_NOT_CONFIGURED",
        "AddLight requires canonical Corona preview render intent",
      );
    }
    const light = operation.parameters.light;
    const lights = base.lights ?? [];
    if (lights.some((entry) => entry.id === light.id)) {
      throw new RevisionValidationError(
        "LIGHT_ID_ALREADY_EXISTS",
        `Light ${light.id} already exists`,
      );
    }
    if (
      light.type !== "area" ||
      !Number.isFinite(light.intensity) ||
      light.intensity < 0 ||
      !validFiniteVector(light.transform.position) ||
      !validFiniteVector(light.transform.rotationEuler) ||
      !validFiniteVector(light.transform.scale) ||
      !light.transform.scale.every((value, index) => value === [1, 1, 1][index])
    ) {
      throw new RevisionValidationError(
        "LIGHT_INVALID",
        `Light ${light.id} does not satisfy the canonical area-light policy`,
      );
    }
    targetSceneSpec.lights = [
      ...lights.map((entry) => structuredClone(entry)),
      structuredClone(light),
    ].sort((left, right) => left.id.localeCompare(right.id));
    mutation = {
      operationId: operation.operationId,
      type: "AddLight",
      targetId: operation.targetId,
      renderEngine: "corona",
      renderMode: "preview",
      light: structuredClone(light),
    };
  } else if (operation?.type === "MigrateMaterialAppearanceContract") {
    if (operation.targetId !== base.scene.id) {
      throw new RevisionValidationError(
        "TARGET_NOT_FOUND",
        `Scene target ${operation.targetId} was not found`,
      );
    }
    if (base.sceneSpecVersion === "0.3.0") {
      throw new RevisionValidationError(
        "MATERIAL_APPEARANCE_ALREADY_CANONICAL",
        "Base SceneSpec is already v0.3 canonical material appearance",
      );
    }
    if (
      base.sceneSpecVersion !== "0.2.0" ||
      operation.parameters.targetSceneSpecVersion !== "0.3.0"
    ) {
      throw new RevisionValidationError(
        "SCENE_SPEC_VERSION_TRANSITION_UNSUPPORTED",
        "Only an explicit v0.2 -> v0.3 material appearance transition is supported",
      );
    }
    const parameterMaterials = operation.parameters.materials;
    const parameterIds = parameterMaterials.map((entry) => entry.materialId);
    const sortedParameterIds = [...parameterIds].sort((left, right) => left.localeCompare(right));
    if (parameterIds.join(" ") !== sortedParameterIds.join(" ")) {
      throw new RevisionValidationError(
        "MATERIAL_APPEARANCE_SET_UNSORTED",
        "Migration materials must be sorted lexicographically by materialId",
      );
    }
    const seenParameterIds = new Set<string>();
    for (const id of parameterIds) {
      if (seenParameterIds.has(id)) {
        throw new RevisionValidationError(
          "MATERIAL_ID_DUPLICATE",
          `Migration parameters reference materialId ${id} more than once`,
        );
      }
      seenParameterIds.add(id);
    }
    const baseMaterialIds = base.materials.map((material) => material.id);
    const baseMaterialIdSet = new Set(baseMaterialIds);
    for (const id of parameterIds) {
      if (!baseMaterialIdSet.has(id)) {
        throw new RevisionValidationError(
          "MATERIAL_NOT_FOUND",
          `Migration references unknown materialId ${id}`,
        );
      }
    }
    for (const id of baseMaterialIds) {
      if (!seenParameterIds.has(id)) {
        throw new RevisionValidationError(
          "MATERIAL_APPEARANCE_SET_INCOMPLETE",
          `Migration is missing an explicit appearance value for materialId ${id}`,
        );
      }
    }
    const lockTargets = lockableTargets(base);
    for (const assignment of base.materialAssignments) {
      const lockTarget = lockTargets.find((entry) => entry.id === assignment.targetId);
      if (lockTarget?.locks.material) {
        throw new RevisionValidationError(
          "MATERIAL_LOCKED",
          `Target ${assignment.targetId} has a locked material and cannot be migrated`,
        );
      }
    }
    const appearanceById = new Map(
      parameterMaterials.map((entry) => [entry.materialId, entry] as const),
    );
    for (const material of targetSceneSpec.materials) {
      const appearance = appearanceById.get(material.id);
      if (!appearance) {
        throw new RevisionValidationError(
          "MATERIAL_APPEARANCE_SET_INCOMPLETE",
          `Migration is missing an explicit appearance value for materialId ${material.id}`,
        );
      }
      material.roughness = appearance.roughness;
      material.metalness = appearance.metalness;
    }
    targetSceneSpec.sceneSpecVersion = "0.3.0";
    mutation = {
      operationId: operation.operationId,
      type: "MigrateMaterialAppearanceContract",
      targetId: operation.targetId,
      targetSceneSpecVersion: "0.3.0",
      materials: sortedParameterIds.map((materialId) => {
        const baseMaterial = base.materials.find((material) => material.id === materialId);
        const appearance = appearanceById.get(materialId);
        if (!baseMaterial || !appearance) {
          throw new RevisionValidationError(
            "MATERIAL_NOT_FOUND",
            `Migration references unknown materialId ${materialId}`,
          );
        }
        return {
          materialId,
          baseColorRgb: structuredClone(baseMaterial.baseColorRgb),
          roughness: appearance.roughness,
          metalness: appearance.metalness,
        };
      }),
      materialAssignments: base.materialAssignments.map((assignment) => ({
        targetId: assignment.targetId,
        materialId: assignment.materialId,
      })),
    };
  } else if (operation?.type === "SetCamera") {
    const cameraMatches = base.cameras.filter((camera) => camera.id === operation.targetId);
    if (cameraMatches.length === 0) {
      throw new RevisionValidationError(
        "CAMERA_NOT_FOUND",
        `Camera ${operation.targetId} was not found`,
      );
    }
    if (cameraMatches.length > 1) {
      throw new RevisionValidationError(
        "CAMERA_ID_AMBIGUOUS",
        `Camera ${operation.targetId} is not unique`,
      );
    }
    const currentCamera = cameraMatches[0] as SceneDocument["cameras"][number];
    const { position, target, orientationPolicy, focalLengthMm, sensorWidthMm } =
      operation.parameters;
    if (position[0] === target[0] && position[1] === target[1] && position[2] === target[2]) {
      throw new RevisionValidationError(
        "CAMERA_POSITION_TARGET_INVALID",
        `Camera ${operation.targetId} position and target must differ`,
      );
    }
    const desiredState = { position, target, orientationPolicy, focalLengthMm, sensorWidthMm };
    const currentState = {
      position: currentCamera.transform.position,
      target: currentCamera.target,
      orientationPolicy: currentCamera.orientationPolicy,
      focalLengthMm: currentCamera.focalLengthMm,
      sensorWidthMm: currentCamera.sensorWidthMm,
    };
    if (isDeepStrictEqual(desiredState, currentState)) {
      throw new RevisionValidationError(
        "CAMERA_STATE_UNCHANGED",
        `Camera ${operation.targetId} already matches the desired SetCamera state`,
      );
    }
    // deriveLookAtRotationEuler only throws when position === target, which
    // the check above already excludes.
    const derivedRotationEuler = deriveLookAtRotationEuler(position, target) as Vector3;
    const targetCamera = targetSceneSpec.cameras.find((camera) => camera.id === operation.targetId);
    if (!targetCamera) {
      throw new RevisionValidationError(
        "CAMERA_NOT_FOUND",
        `Camera ${operation.targetId} was not found`,
      );
    }
    targetCamera.transform = {
      position: structuredClone(position),
      rotationEuler: derivedRotationEuler,
      scale: structuredClone(currentCamera.transform.scale),
    };
    targetCamera.target = structuredClone(target);
    targetCamera.orientationPolicy = orientationPolicy;
    targetCamera.focalLengthMm = focalLengthMm;
    targetCamera.sensorWidthMm = sensorWidthMm;
    mutation = {
      operationId: operation.operationId,
      type: "SetCamera",
      targetId: operation.targetId,
      position: structuredClone(position),
      target: structuredClone(target),
      orientationPolicy,
      derivedRotationEuler,
      focalLengthMm,
      sensorWidthMm,
      fovRadians: deriveCameraFovRadians(focalLengthMm, sensorWidthMm),
      fovDegrees: deriveCameraFovDegrees(focalLengthMm, sensorWidthMm),
    };
  } else if (operation?.type === "MoveObject") {
    const matches = base.assets.filter((asset) => asset.id === operation.targetId);
    if (matches.length === 0) {
      throw new RevisionValidationError(
        "TARGET_NOT_FOUND",
        `Target ${operation.targetId} was not found`,
      );
    }
    if (matches.length > 1) {
      throw new RevisionValidationError(
        "DUPLICATE_LOGICAL_ID",
        `Target ${operation.targetId} is not unique`,
      );
    }
    const target = matches[0] as SceneDocument["assets"][number];
    if (target.type !== "proxy_asset") {
      throw new RevisionValidationError("TARGET_NOT_MANAGED", "MoveObject target is not managed");
    }
    if (target.locks.transform) {
      throw new RevisionValidationError(
        "TRANSFORM_LOCKED",
        `Target ${target.id} transform is locked`,
      );
    }
    validatePlacement(base, target, operation.parameters.transform);
    const targetAsset = targetSceneSpec.assets.find((asset) => asset.id === operation.targetId);
    if (!targetAsset) throw new RevisionValidationError("TARGET_NOT_FOUND", "Target disappeared");
    targetAsset.transform = structuredClone(operation.parameters.transform);
    mutation = {
      operationId: operation.operationId,
      type: "MoveObject",
      targetId: operation.targetId,
      transform: structuredClone(operation.parameters.transform),
    };
  } else if (operation?.type === "UpdateOpening") {
    const matches = base.openings.filter((opening) => opening.id === operation.targetId);
    if (matches.length === 0) {
      throw new RevisionValidationError(
        "TARGET_NOT_FOUND",
        `Opening ${operation.targetId} was not found`,
      );
    }
    if (matches.length > 1) {
      throw new RevisionValidationError(
        "DUPLICATE_LOGICAL_ID",
        `Opening ${operation.targetId} is not unique`,
      );
    }
    const opening = matches[0] as SceneDocument["openings"][number];
    if (opening.locks.geometry) {
      throw new RevisionValidationError(
        "GEOMETRY_LOCKED",
        `Opening ${opening.id} geometry is locked`,
      );
    }
    const hostMatches = base.geometry.filter(
      (entity) => entity.id === opening.hostGeometryId && entity.type === "wall",
    );
    if (hostMatches.length === 0) {
      throw new RevisionValidationError(
        "HOST_NOT_FOUND",
        `Opening host ${opening.hostGeometryId} was not found`,
      );
    }
    if (hostMatches.length > 1) {
      throw new RevisionValidationError(
        "DUPLICATE_LOGICAL_ID",
        `Opening host ${opening.hostGeometryId} is not unique`,
      );
    }
    const host = hostMatches[0] as SceneDocument["geometry"][number];
    if (host.locks.geometry) {
      throw new RevisionValidationError(
        "GEOMETRY_LOCKED",
        `Host wall ${host.id} geometry is locked`,
      );
    }
    if (!host.start || !host.end || host.height === undefined) {
      throw new RevisionValidationError("HOST_INVALID", `Host wall ${host.id} is incomplete`);
    }
    const { length } = wallFrame(host as Parameters<typeof wallFrame>[0]);
    const parameters = operation.parameters;
    if (
      parameters.offset + parameters.width > length ||
      parameters.sill + parameters.height > host.height
    ) {
      throw new RevisionValidationError(
        "OPENING_EXCEEDS_HOST",
        `Opening ${opening.id} exceeds host wall ${host.id}`,
      );
    }
    const targetOpening = targetSceneSpec.openings.find((entry) => entry.id === operation.targetId);
    if (!targetOpening)
      throw new RevisionValidationError("TARGET_NOT_FOUND", "Opening disappeared");
    targetOpening.offset = parameters.offset;
    targetOpening.width = parameters.width;
    targetOpening.sill = parameters.sill;
    targetOpening.height = parameters.height;
    targetOpening.transform.position = [
      parameters.offset,
      targetOpening.transform.position[1],
      parameters.sill,
    ];
    const buildPlan = compileGoldenBuildPlan(targetSceneSpec);
    const marker = buildPlan.openingMarkers.find((entry) => entry.logicalId === operation.targetId);
    if (!marker) throw new RevisionValidationError("TARGET_NOT_FOUND", "Opening marker is missing");
    mutation = {
      operationId: operation.operationId,
      type: "UpdateOpening",
      targetId: operation.targetId,
      hostLogicalId: host.id,
      offset: parameters.offset,
      width: parameters.width,
      sill: parameters.sill,
      height: parameters.height,
      transform: structuredClone(targetOpening.transform),
      physicalPosition: structuredClone(marker.position),
      wallSegments: buildPlan.wallSegments.filter((segment) => segment.hostLogicalId === host.id),
    };
  } else if (operation?.type === "AssignMaterial") {
    const targets = materialTargets(base).filter((target) => target.id === operation.targetId);
    if (targets.length === 0) {
      throw new RevisionValidationError(
        "TARGET_NOT_FOUND",
        `Target ${operation.targetId} was not found`,
      );
    }
    if (targets.length > 1) {
      throw new RevisionValidationError(
        "DUPLICATE_LOGICAL_ID",
        `Target ${operation.targetId} is not unique`,
      );
    }
    const target = targets[0] as MaterialTarget;
    if (!isMaterialAssignable(target.type)) {
      throw new RevisionValidationError(
        "TARGET_NOT_MANAGED",
        `Target ${target.id} does not support material assignment`,
      );
    }
    if (target.locks.material) {
      throw new RevisionValidationError(
        "MATERIAL_LOCKED",
        `Target ${target.id} material is locked`,
      );
    }
    const materials = base.materials.filter(
      (material) => material.id === operation.parameters.materialId,
    );
    if (materials.length === 0) {
      throw new RevisionValidationError(
        "MATERIAL_NOT_FOUND",
        `Material ${operation.parameters.materialId} was not found`,
      );
    }
    if (materials.length > 1) {
      throw new RevisionValidationError(
        "DUPLICATE_MATERIAL_ID",
        `Material ${operation.parameters.materialId} is not unique`,
      );
    }
    const assignments = base.materialAssignments.filter(
      (assignment) => assignment.targetId === operation.targetId,
    );
    if (assignments.length === 0) {
      throw new RevisionValidationError(
        "MATERIAL_ASSIGNMENT_NOT_FOUND",
        `Target ${operation.targetId} has no canonical material assignment`,
      );
    }
    if (assignments.length > 1) {
      throw new RevisionValidationError(
        "DUPLICATE_MATERIAL_ASSIGNMENT",
        `Target ${operation.targetId} has multiple material assignments`,
      );
    }
    const currentAssignment = assignments[0] as SceneDocument["materialAssignments"][number];
    if (currentAssignment.materialId === operation.parameters.materialId) {
      throw new RevisionValidationError(
        "MATERIAL_ALREADY_ASSIGNED",
        `Target ${operation.targetId} already has material ${operation.parameters.materialId}`,
      );
    }
    const targetAssignment = targetSceneSpec.materialAssignments.find(
      (assignment) => assignment.id === currentAssignment.id,
    );
    if (!targetAssignment) {
      throw new RevisionValidationError(
        "MATERIAL_ASSIGNMENT_NOT_FOUND",
        `Material assignment for ${operation.targetId} disappeared`,
      );
    }
    targetAssignment.materialId = operation.parameters.materialId;
    const material = materials[0] as SceneDocument["materials"][number];
    mutation = {
      operationId: operation.operationId,
      type: "AssignMaterial",
      targetId: operation.targetId,
      material: {
        id: material.id,
        baseColorRgb: normalizedMaterialColor(material.baseColorRgb),
      },
    };
    try {
      compileGoldenBuildPlan(targetSceneSpec);
    } catch (error) {
      throw new RevisionValidationError(
        "SCHEMA_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (operation?.type === "ReplaceAsset") {
    const candidate = validateAssetReplacementCandidate(
      base,
      operation.targetId,
      operation.parameters.newAssetDefinitionId,
    );
    const targetAsset = targetSceneSpec.assets.find((asset) => asset.id === operation.targetId);
    if (!targetAsset) throw new RevisionValidationError("TARGET_NOT_FOUND", "Asset disappeared");
    targetAsset.assetDefinitionId = candidate.candidateAssetDefinitionId;
    const newAssetDefinition = base.assetDefinitions.find(
      (definition) => definition.id === candidate.candidateAssetDefinitionId,
    );
    if (!newAssetDefinition) {
      throw new RevisionValidationError(
        "ASSET_DEFINITION_NOT_FOUND",
        `Candidate definition ${candidate.candidateAssetDefinitionId} disappeared`,
      );
    }
    mutation = {
      operationId: operation.operationId,
      type: "ReplaceAsset",
      targetId: operation.targetId,
      oldAssetDefinitionId: candidate.currentAssetDefinitionId,
      newAssetDefinition: {
        id: newAssetDefinition.id,
        category: newAssetDefinition.category,
        dimensions: structuredClone(newAssetDefinition.dimensions),
        pivotPolicy: newAssetDefinition.pivotPolicy,
        allowNonUniformScale: newAssetDefinition.allowNonUniformScale,
      },
      placementPolicy: operation.parameters.placementPolicy,
    };
    try {
      compileGoldenBuildPlan(targetSceneSpec);
    } catch (error) {
      throw new RevisionValidationError(
        "SCHEMA_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (operation?.type === "LockProperty" || operation?.type === "UnlockProperty") {
    mutation = planPropertyLockMutation(base, targetSceneSpec, operation);
    try {
      compileGoldenBuildPlan(targetSceneSpec);
    } catch (error) {
      throw new RevisionValidationError(
        "SCHEMA_INVALID",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    throw new RevisionValidationError("OPERATION_UNSUPPORTED", "Operation is unsupported");
  }
  targetSceneSpec.revisions.push({
    revisionId: changeSet.targetRevisionId,
    parentRevisionId: changeSet.baseRevisionId,
    status: "committed",
    createdAt: changeSet.metadata.createdAt,
  });
  const targetValidation = validateSceneSpec(targetSceneSpec);
  if (!targetValidation.ok) {
    throw new RevisionValidationError(
      "SCHEMA_INVALID",
      `Revised SceneSpec is invalid: ${JSON.stringify(targetValidation.errors)}`,
    );
  }
  validateCanonicalCoronaRenderState(targetSceneSpec);
  return {
    changeSet,
    targetSceneSpec,
    plan: {
      revisionPlanVersion:
        mutation.type === "SetCamera"
          ? "0.3.0"
          : mutation.type === "MigrateMaterialAppearanceContract"
            ? "0.2.0"
            : "0.1.0",
      changeSetId: changeSet.changeSetId,
      projectId: changeSet.projectId,
      sceneId: changeSet.sceneId,
      baseRevisionId: changeSet.baseRevisionId,
      targetRevisionId: changeSet.targetRevisionId,
      operation: mutation,
      expectedManagedLogicalIds: managedLogicalIds(base),
    },
  };
}

interface MaterialTarget {
  id: string;
  type: string;
  locks: { material: boolean };
}

interface LockableTarget {
  id: string;
  locks: Record<LockPropertyPath, boolean>;
}

function materialTargets(scene: SceneDocument): MaterialTarget[] {
  return [...scene.geometry, ...scene.assets].map((entry) => ({
    id: entry.id,
    type: entry.type,
    locks: { material: entry.locks.material },
  }));
}

function lockableTargets(scene: SceneDocument): LockableTarget[] {
  return [...scene.geometry, ...scene.openings, ...scene.assets].map((entry) => ({
    id: entry.id,
    locks: entry.locks,
  }));
}

function planPropertyLockMutation(
  base: SceneDocument,
  targetSceneSpec: SceneDocument,
  operation: PropertyLockOperation,
): LockMutation {
  const allMatches = managedLogicalIds(base).filter((id) => id === operation.targetId);
  if (allMatches.length === 0) {
    throw new RevisionValidationError(
      "TARGET_NOT_FOUND",
      `Target ${operation.targetId} was not found`,
    );
  }
  if (allMatches.length > 1) {
    throw new RevisionValidationError(
      "DUPLICATE_LOGICAL_ID",
      `Target ${operation.targetId} is not unique`,
    );
  }
  const targets = lockableTargets(base).filter((target) => target.id === operation.targetId);
  const target = targets[0];
  if (targets.length !== 1 || !target || !(operation.parameters.propertyPath in target.locks)) {
    throw new RevisionValidationError(
      "PROPERTY_LOCK_UNSUPPORTED",
      `Target ${operation.targetId} does not expose ${operation.parameters.propertyPath} lock`,
    );
  }
  const desiredLockedState = operation.type === "LockProperty";
  if (target.locks[operation.parameters.propertyPath] === desiredLockedState) {
    throw new RevisionValidationError(
      desiredLockedState ? "PROPERTY_ALREADY_LOCKED" : "PROPERTY_ALREADY_UNLOCKED",
      `Target ${operation.targetId} ${operation.parameters.propertyPath} is already ${
        desiredLockedState ? "locked" : "unlocked"
      }`,
    );
  }
  const targetLock = lockableTargets(targetSceneSpec).find(
    (entry) => entry.id === operation.targetId,
  );
  if (!targetLock) {
    throw new RevisionValidationError("TARGET_NOT_FOUND", "Lock target disappeared");
  }
  targetLock.locks[operation.parameters.propertyPath] = desiredLockedState;
  return {
    operationId: operation.operationId,
    type: operation.type,
    targetId: operation.targetId,
    propertyPath: operation.parameters.propertyPath,
  };
}

function isMaterialAssignable(type: string): boolean {
  return ["wall", "floor", "ceiling", "proxy_asset"].includes(type);
}

function normalizedMaterialColor(color: Vector3): Vector3 {
  return color.map((channel) => Math.round(channel * 255) / 255) as Vector3;
}

function validFiniteVector(value: Vector3): boolean {
  return value.length === 3 && value.every((entry) => Number.isFinite(entry));
}

function validatePlacement(
  scene: SceneDocument,
  target: SceneDocument["assets"][number],
  transform: SemanticTransform,
): void {
  const space = scene.spaces.find((entry) => entry.id === target.spaceId);
  if (!space) throw new RevisionValidationError("SPACE_NOT_FOUND", "Target space was not found");
  const definition = scene.assetDefinitions.find((entry) => entry.id === target.assetDefinitionId);
  if (!definition) {
    throw new RevisionValidationError(
      "ASSET_DEFINITION_NOT_FOUND",
      `Target ${target.id} references missing definition ${target.assetDefinitionId}`,
    );
  }
  if (
    !definition.allowNonUniformScale &&
    (transform.scale[0] !== transform.scale[1] || transform.scale[1] !== transform.scale[2])
  ) {
    throw new RevisionValidationError(
      "NON_UNIFORM_SCALE_NOT_ALLOWED",
      `Target ${target.id} does not allow non-uniform scale`,
    );
  }
  const width = definition.dimensions[0] * transform.scale[0];
  const depth = definition.dimensions[1] * transform.scale[1];
  const height = definition.dimensions[2] * transform.scale[2];
  const angle = (transform.rotationEuler[2] * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const offsets: Array<[number, number]> = [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [width / 2, depth / 2],
    [-width / 2, depth / 2],
  ];
  const corners: Array<[number, number]> = offsets.map(([x, y]) => [
    transform.position[0] + x * cos - y * sin,
    transform.position[1] + x * sin + y * cos,
  ]);
  if (!corners.every((corner) => pointInPolygonOrBoundary(corner, space.boundary))) {
    throw new RevisionValidationError(
      "OBJECT_OUTSIDE_SPACE",
      `Target ${target.id} would cross the room boundary`,
    );
  }
  const bottom = transform.position[2];
  const top = bottom + height;
  if (bottom < space.floorElevation || top > space.floorElevation + space.ceilingHeight) {
    throw new RevisionValidationError(
      "OBJECT_OUTSIDE_SPACE",
      `Target ${target.id} exceeds the room vertical bounds`,
    );
  }
}

function pointInPolygonOrBoundary(point: [number, number], boundary: Vector3[]): boolean {
  let inside = false;
  for (let index = 0, previous = boundary.length - 1; index < boundary.length; previous = index++) {
    const [xi, yi] = boundary[index] as Vector3;
    const [xj, yj] = boundary[previous] as Vector3;
    const cross = (point[0] - xi) * (yj - yi) - (point[1] - yi) * (xj - xi);
    const onSegment =
      Math.abs(cross) <= 1e-9 &&
      point[0] >= Math.min(xi, xj) &&
      point[0] <= Math.max(xi, xj) &&
      point[1] >= Math.min(yi, yj) &&
      point[1] <= Math.max(yi, yj);
    if (onSegment) return true;
    const intersects =
      yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function managedLogicalIds(scene: SceneDocument): string[] {
  const collections = [
    scene.geometry as Array<{ id: string }>,
    scene.openings as Array<{ id: string }>,
    scene.assets,
    scene.cameras as Array<{ id: string }>,
  ];
  return collections.flatMap((entries) => entries.map((entry) => entry.id)).sort();
}

export function diffSemanticManifests(
  beforeValue: Record<string, unknown>,
  afterValue: Record<string, unknown>,
): SemanticRevisionDiff {
  const before = beforeValue as {
    revisionId: string;
    nodes: Array<Record<string, unknown>>;
    cameras: Array<Record<string, unknown>>;
  };
  const after = afterValue as typeof before;
  const beforeById = new Map(
    [...before.nodes, ...before.cameras].map((entry) => [String(entry.logicalId), entry]),
  );
  const afterById = new Map(
    [...after.nodes, ...after.cameras].map((entry) => [String(entry.logicalId), entry]),
  );
  const added = [...afterById.keys()].filter((id) => !beforeById.has(id)).sort();
  const removed = [...beforeById.keys()].filter((id) => !afterById.has(id)).sort();
  const changed: SemanticObjectChange[] = [];
  const unchanged: string[] = [];
  for (const id of [...beforeById.keys()].filter((entry) => afterById.has(entry)).sort()) {
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    collectFieldChanges(beforeById.get(id), afterById.get(id), "", changes);
    if (Object.keys(changes).length === 0) unchanged.push(id);
    else changed.push({ logicalId: id, changes });
  }
  return {
    revision: { before: before.revisionId, after: after.revisionId },
    changed,
    unchanged,
    added,
    removed,
  };
}

function collectFieldChanges(
  before: unknown,
  after: unknown,
  path: string,
  changes: Record<string, { before: unknown; after: unknown }>,
): void {
  if (
    path === "embeddedMetadata.AIArchViz.RevisionId" ||
    path === "embeddedMetadata.AIArchViz.AssetDefinitionId"
  )
    return;
  if (isDeepStrictEqual(before, after)) return;
  if (path === "locks") {
    const beforeLocks = normalizedLockState(before);
    const afterLocks = normalizedLockState(after);
    for (const propertyPath of ["geometry", "transform", "material"] as const) {
      collectFieldChanges(
        beforeLocks[propertyPath],
        afterLocks[propertyPath],
        `${path}.${propertyPath}`,
        changes,
      );
    }
    return;
  }
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    for (const key of [...keys].sort()) {
      collectFieldChanges(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        changes,
      );
    }
    return;
  }
  changes[path] = { before, after };
}

function normalizedLockState(value: unknown): Record<LockPropertyPath, boolean> {
  const locks =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    geometry: locks.geometry === true,
    transform: locks.transform === true,
    material: locks.material === true,
  };
}

export function assertGoldenRevisionDiff(diff: SemanticRevisionDiff): void {
  const [change] = diff.changed;
  if (
    diff.revision.before !== "rev_golden_0001" ||
    diff.revision.after !== "rev_golden_0002" ||
    diff.changed.length !== 1 ||
    change?.logicalId !== "asset_living_coffee_table_main" ||
    Object.keys(change.changes).join() !== "transform.position" ||
    diff.added.length !== 0 ||
    diff.removed.length !== 0 ||
    diff.unchanged.length !== 13
  ) {
    throw new RevisionValidationError(
      "UNEXPECTED_SEMANTIC_DIFF",
      `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
    );
  }
}

export function assertRevisionDiff(diff: SemanticRevisionDiff, changeSet: ChangeSetContract): void {
  const [operation] = changeSet.operations;
  if (operation?.type === "MoveObject") {
    const [change] = diff.changed;
    if (
      diff.revision.before !== changeSet.baseRevisionId ||
      diff.revision.after !== changeSet.targetRevisionId ||
      diff.changed.length !== 1 ||
      change?.logicalId !== operation.targetId ||
      Object.keys(change.changes).sort().join() !== "transform.position" ||
      diff.added.length !== 0 ||
      diff.removed.length !== 0 ||
      diff.unchanged.length !== 13
    ) {
      throw new RevisionValidationError(
        "UNEXPECTED_SEMANTIC_DIFF",
        `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
      );
    }
    return;
  }
  if (
    operation?.type === "SetRenderIntent" ||
    operation?.type === "AddLight" ||
    operation?.type === "MigrateMaterialAppearanceContract"
  ) {
    // Material appearance (roughness/metalness) lives on SceneSpec's top-level
    // `materials` array, not on any per-node manifest entry, so this migration
    // produces zero semantic node/camera diff, exactly like SetRenderIntent
    // and AddLight before it.
    if (
      diff.revision.before !== changeSet.baseRevisionId ||
      diff.revision.after !== changeSet.targetRevisionId ||
      diff.changed.length !== 0 ||
      diff.added.length !== 0 ||
      diff.removed.length !== 0 ||
      diff.unchanged.length !== 14
    ) {
      throw new RevisionValidationError(
        "UNEXPECTED_SEMANTIC_DIFF",
        `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
      );
    }
    return;
  }
  const [change] = diff.changed;
  const changedFields = Object.keys(change?.changes ?? {}).sort();
  if (operation?.type === "AssignMaterial") {
    if (
      diff.revision.before !== changeSet.baseRevisionId ||
      diff.revision.after !== changeSet.targetRevisionId ||
      diff.changed.length !== 1 ||
      change?.logicalId !== operation.targetId ||
      changedFields.join() !== "materialBaseColorRgb,materialId" ||
      diff.added.length !== 0 ||
      diff.removed.length !== 0 ||
      diff.unchanged.length !== 13
    ) {
      throw new RevisionValidationError(
        "UNEXPECTED_SEMANTIC_DIFF",
        `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
      );
    }
    return;
  }
  if (operation?.type === "SetCamera") {
    // A SetCamera mutation may touch any combination of these leaf fields
    // depending on which parameters actually changed; the Golden fixture
    // deliberately exercises only focalLengthMm (see Spike 8I scope), but
    // the operation itself is a general absolute-camera-state contract.
    const allowedCameraFields = new Set([
      "focalLengthMm",
      "sensorWidthMm",
      "target",
      "transform.position",
      "transform.rotationEuler",
    ]);
    if (
      diff.revision.before !== changeSet.baseRevisionId ||
      diff.revision.after !== changeSet.targetRevisionId ||
      diff.changed.length !== 1 ||
      change?.logicalId !== operation.targetId ||
      changedFields.length === 0 ||
      !changedFields.every((field) => allowedCameraFields.has(field)) ||
      diff.added.length !== 0 ||
      diff.removed.length !== 0 ||
      diff.unchanged.length !== 13
    ) {
      throw new RevisionValidationError(
        "UNEXPECTED_SEMANTIC_DIFF",
        `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
      );
    }
    return;
  }
  if (operation?.type === "ReplaceAsset") {
    if (
      diff.revision.before !== changeSet.baseRevisionId ||
      diff.revision.after !== changeSet.targetRevisionId ||
      diff.changed.length !== 1 ||
      change?.logicalId !== operation.targetId ||
      changedFields.join() !== "assetDefinitionId,dimensions" ||
      change?.changes.assetDefinitionId?.after !== operation.parameters.newAssetDefinitionId ||
      !Array.isArray(change?.changes.dimensions?.after) ||
      change.changes.dimensions.after.length !== 3 ||
      !change.changes.dimensions.after.every(
        (dimension) => typeof dimension === "number" && Number.isFinite(dimension) && dimension > 0,
      ) ||
      diff.added.length !== 0 ||
      diff.removed.length !== 0 ||
      diff.unchanged.length !== 13
    ) {
      throw new RevisionValidationError(
        "UNEXPECTED_SEMANTIC_DIFF",
        `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
      );
    }
    return;
  }
  if (operation?.type === "LockProperty" || operation?.type === "UnlockProperty") {
    const expectedLockChange =
      operation.type === "LockProperty"
        ? { before: false, after: true }
        : { before: true, after: false };
    if (
      diff.revision.before !== changeSet.baseRevisionId ||
      diff.revision.after !== changeSet.targetRevisionId ||
      diff.changed.length !== 1 ||
      change?.logicalId !== operation.targetId ||
      changedFields.join() !== `locks.${operation.parameters.propertyPath}` ||
      !isDeepStrictEqual(
        change?.changes[`locks.${operation.parameters.propertyPath}`],
        expectedLockChange,
      ) ||
      diff.added.length !== 0 ||
      diff.removed.length !== 0 ||
      diff.unchanged.length !== 13
    ) {
      throw new RevisionValidationError(
        "UNEXPECTED_SEMANTIC_DIFF",
        `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
      );
    }
    return;
  }
  if (
    operation?.type !== "UpdateOpening" ||
    diff.revision.before !== changeSet.baseRevisionId ||
    diff.revision.after !== changeSet.targetRevisionId ||
    diff.changed.length !== 1 ||
    change?.logicalId !== operation.targetId ||
    changedFields.join() !== "sill,transform.position" ||
    diff.added.length !== 0 ||
    diff.removed.length !== 0 ||
    diff.unchanged.length !== 13
  ) {
    throw new RevisionValidationError(
      "UNEXPECTED_SEMANTIC_DIFF",
      `Revision changed unexpected semantic state: ${JSON.stringify(diff)}`,
    );
  }
}

function sourcePath(repositoryRoot: string, declaredByPath: string, declaredPath: string): string {
  return resolveWithinRoot(
    repositoryRoot,
    relative(repositoryRoot, resolve(dirname(declaredByPath), basename(declaredPath))),
  );
}

function rawFileHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function validateCanonicalCoronaRenderState(scene: SceneDocument): void {
  if (scene.render.engine !== "corona" || scene.render.mode !== "preview") return;
  for (const light of scene.lights ?? []) {
    if (!isSupportedCanonicalCoronaLightType(light.type)) {
      throw new RevisionValidationError(
        "RENDERER_LIGHT_TYPE_UNSUPPORTED",
        `Canonical Corona preview supports area lights only: ${light.id}`,
      );
    }
  }
}

export function canonicalRenderStateExpectation(
  scene: Record<string, unknown>,
): Record<string, unknown> | null {
  const value = scene as unknown as SceneDocument;
  if (value.render.engine !== "corona" || value.render.mode !== "preview") return null;
  const lights = value.lights ?? [];
  validateCanonicalCoronaRenderState(value);
  return {
    renderStateVersion: "0.1.0",
    sceneId: value.scene.id,
    revisionId: value.scene.revisionId,
    render: { engine: "corona", mode: "preview", actualRendererClass: "Corona" },
    lights: sortCanonicalCoronaLights(lights).map((light) => ({
      logicalId: light.id,
      type: "area",
      actualClass: "CoronaLight",
      position: [...light.transform.position],
      rotationEuler: [...light.transform.rotationEuler],
      canonicalIntensity: light.intensity,
      mappedIntensity: light.intensity * coronaCanonicalIntensityScale,
      widthMm: coronaCanonicalAreaLightWidthMm,
    })),
    status: "PASS",
  };
}

/**
 * Sticky like `canonicalRenderStateExpectation`: once a revision reaches
 * SceneSpec v0.3, every later revision built on it is expected to keep
 * passing canonical material-state verification, not just the revision that
 * performed the migration.
 */
export function canonicalMaterialStateExpectation(
  scene: Record<string, unknown>,
): Record<string, unknown> | null {
  const value = scene as unknown as SceneDocument;
  if (value.sceneSpecVersion !== "0.3.0") return null;
  const materials = [...value.materials].sort((left, right) => left.id.localeCompare(right.id));
  const assignments = [...value.materialAssignments].sort((left, right) =>
    left.targetId.localeCompare(right.targetId),
  );
  return {
    materialStateVersion: "0.1.0",
    projectId: value.project.id,
    sceneId: value.scene.id,
    revisionId: value.scene.revisionId,
    sceneSpecVersion: "0.3.0",
    materials: materials.map((material) => {
      const roughness = material.roughness;
      const metalness = material.metalness;
      if (roughness === undefined || metalness === undefined) {
        throw new RevisionValidationError(
          "MATERIAL_APPEARANCE_SET_INCOMPLETE",
          `SceneSpec v0.3 material ${material.id} is missing canonical appearance`,
        );
      }
      return {
        materialId: material.id,
        actualClass: "_CoronaPhysicalMtl",
        canonicalBaseColorRgb: [...material.baseColorRgb],
        observedBaseColorRgb: [...material.baseColorRgb],
        canonicalRoughness: roughness,
        observedRoughness: roughness,
        canonicalMetalness: metalness,
        observedMetalness: metalness,
        materialInstanceName: `AVZ_MATERIAL_${material.id}`,
      };
    }),
    materialAssignments: assignments.map((assignment) => ({
      targetId: assignment.targetId,
      materialId: assignment.materialId,
      materialInstanceName: `AVZ_MATERIAL_${assignment.materialId}`,
    })),
    deduplication: { sameIdSharedInstance: true, differentIdDistinctInstances: true },
    status: "PASS",
  };
}

/**
 * Computes the canonical camera-state evidence for every camera in `scene`.
 * Unlike `canonicalRenderStateExpectation`/`canonicalMaterialStateExpectation`,
 * this is not internally gated by scene state: cameras exist unconditionally
 * from rev1, so there is no scene-level flag comparable to `render.engine`
 * or `sceneSpecVersion` that would let it self-activate "once true, always
 * true" without inventing a new SceneSpec field. Callers gate its use by
 * operation type (`SetCamera` only) instead, so promoting a MoveObject or
 * MigrateMaterialAppearanceContract revision never requires a camera-state
 * fixture that never existed for it.
 */
export function canonicalCameraStateExpectation(
  scene: Record<string, unknown>,
): Record<string, unknown> | null {
  const value = scene as unknown as SceneDocument;
  if (!Array.isArray(value.cameras) || value.cameras.length === 0) return null;
  const cameras = [...value.cameras].sort((left, right) => left.id.localeCompare(right.id));
  return {
    cameraStateVersion: "0.1.0",
    projectId: value.project.id,
    sceneId: value.scene.id,
    revisionId: value.scene.revisionId,
    sceneSpecVersion: value.sceneSpecVersion,
    cameras: cameras.map((camera) => {
      const fovRadians = deriveCameraFovRadians(camera.focalLengthMm, camera.sensorWidthMm);
      const fovDegrees = deriveCameraFovDegrees(camera.focalLengthMm, camera.sensorWidthMm);
      return {
        logicalId: camera.id,
        actualClass: "Freecamera",
        canonicalPosition: [...camera.transform.position],
        observedPosition: [...camera.transform.position],
        canonicalTarget: [...camera.target],
        observedTarget: [...camera.target],
        orientationPolicy: camera.orientationPolicy,
        canonicalRotationEuler: [...camera.transform.rotationEuler],
        observedRotationEuler: [...camera.transform.rotationEuler],
        focalLengthMm: camera.focalLengthMm,
        sensorWidthMm: camera.sensorWidthMm,
        expectedFovRadians: fovRadians,
        expectedFovDegrees: fovDegrees,
        observedFovRadians: fovRadians,
        observedFovDegrees: fovDegrees,
        targetDistanceMm: targetDistanceMm(camera.transform.position, camera.target),
      };
    }),
    status: "PASS",
  };
}

function findVerifiedBaseArtifact(
  config: WorkerConfig,
  identity: { projectId: string; sceneId: string; revisionId: string },
  expectedManifest: Record<string, unknown>,
): { artifactPath: string; artifactHash: string } {
  const directory = resolve(config.workspaceRoot, "idempotency");
  if (!existsSync(directory)) {
    throw new RevisionValidationError(
      "BASE_ARTIFACT_NOT_VERIFIED",
      `No durable evidence exists for ${identity.revisionId}`,
    );
  }
  const matches: Array<{ artifactPath: string; artifactHash: string }> = [];
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    let key: string | null = null;
    try {
      const candidate = readJson(resolve(directory, name)) as { idempotencyKey?: unknown };
      key = typeof candidate.idempotencyKey === "string" ? candidate.idempotencyKey : null;
      if (!key) continue;
      const record = readLedger(config.workspaceRoot, key);
      if (
        record?.status !== "SUCCESS" ||
        !record.successfulJobId ||
        !record.reportPath ||
        !record.verifiedOutputPath ||
        !record.manifestPath ||
        !record.verifiedOutputHash ||
        !record.manifestHash
      ) {
        continue;
      }
      const reportPath = resolveWithinRoot(config.workspaceRoot, record.reportPath);
      const artifactPath = resolveWithinRoot(config.workspaceRoot, record.verifiedOutputPath);
      const manifestPath = resolveWithinRoot(config.workspaceRoot, record.manifestPath);
      if (!existsSync(reportPath) || !existsSync(artifactPath) || !existsSync(manifestPath))
        continue;
      const report = validateExecutionReport(readJson(reportPath));
      const manifest = readJson(manifestPath) as Record<string, unknown>;
      if (
        !report.ok ||
        report.value.status !== "SUCCESS" ||
        report.value.jobId !== record.successfulJobId ||
        report.value.requestHash !== record.requestHash ||
        report.value.projectId !== identity.projectId ||
        report.value.sceneId !== identity.sceneId ||
        report.value.revisionId !== identity.revisionId ||
        !validateSceneManifest(manifest).ok ||
        record.verifiedOutputHash !== rawFileHash(artifactPath) ||
        record.manifestHash !== semanticJsonHash(manifest) ||
        record.manifestHash !== semanticJsonHash(expectedManifest)
      ) {
        continue;
      }
      matches.push({ artifactPath, artifactHash: record.verifiedOutputHash });
    } catch {
      if (key) continue;
    }
  }
  const unique = new Map(matches.map((entry) => [entry.artifactPath, entry]));
  if (unique.size !== 1) {
    throw new RevisionValidationError(
      unique.size === 0 ? "BASE_ARTIFACT_NOT_VERIFIED" : "BASE_ARTIFACT_AMBIGUOUS",
      `Expected exactly one verified ${identity.revisionId} artifact, found ${unique.size}`,
    );
  }
  return [...unique.values()][0] as { artifactPath: string; artifactHash: string };
}

function makeError(code: string, message: string, retryable = false): ReportError {
  return { code, message, retryable };
}

function noExecution(
  jobId: string,
  error: ReportError,
  identity: { idempotencyKey?: string; requestHash?: string } = {},
): RevisionResult {
  return {
    workerVersion: "0.1.0",
    status: "BLOCKED",
    targetVersion: targetDccVersion,
    dccVersion: null,
    compatibilityMode: false,
    dcc: null,
    workspace: null,
    mutationProcess: null,
    verificationProcess: null,
    renderStateVerificationProcess: null,
    renderStateEvidence: null,
    materialStateVerificationProcess: null,
    materialStateEvidence: null,
    cameraStateVerificationProcess: null,
    cameraStateEvidence: null,
    comparison: null,
    semanticDiff: null,
    report: null,
    error,
    replayed: false,
    originalJobId: null,
    currentJobId: jobId,
    idempotencyKey: identity.idempotencyKey ?? null,
    requestHash: identity.requestHash ?? null,
    verifiedOutputPath: null,
    baseArtifactPath: null,
    baseArtifactHash: null,
  };
}

interface RevisionContext {
  startedAt: string;
  jobId: string;
  idempotencyKey: string;
  requestHash: string;
  changeSet: ChangeSetContract;
  workspace: JobWorkspace;
  activeLedger: IdempotencyLedgerRecord;
  dcc: ThreeDsMaxDiscoveryResult | null;
  compatibilityMode: boolean;
  mutationProcess: ControlledProcessResult | null;
  verificationProcess: ControlledProcessResult | null;
  renderStateVerificationProcess: ControlledProcessResult | null;
  renderStateEvidence: CanonicalRenderStateEvidence | null;
  materialStateVerificationProcess: ControlledProcessResult | null;
  materialStateEvidence: CanonicalMaterialStateEvidence | null;
  cameraStateVerificationProcess: ControlledProcessResult | null;
  cameraStateEvidence: CanonicalCameraStateEvidence | null;
  comparison: ReturnType<typeof compareSceneManifests> | null;
  semanticDiff: SemanticRevisionDiff | null;
  baseArtifactPath: string;
  baseArtifactHash: string;
}

function reportFor(
  context: RevisionContext,
  status: RevisionExecutionReport["status"],
  error: ReportError | null,
  verificationStatus: "PASS" | "FAIL" | "NOT_RUN",
): RevisionExecutionReport {
  const report: RevisionExecutionReport = {
    reportVersion: "0.1.0",
    jobId: context.jobId,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash,
    projectId: context.changeSet.projectId,
    sceneId: context.changeSet.sceneId,
    revisionId: context.changeSet.targetRevisionId,
    status,
    startedAt: context.startedAt,
    completedAt: new Date().toISOString(),
    candidatePath: existsSync(context.workspace.candidatePath) ? "candidate/project.max" : null,
    verifiedOutputPath:
      status === "SUCCESS" && existsSync(context.workspace.outputPath)
        ? "output/project.max"
        : null,
    manifestPath: existsSync(context.workspace.manifestPath)
      ? "verification/scene-manifest.json"
      : null,
    validationResult: { status: "PASS", errors: [] },
    verificationResult: {
      status: verificationStatus,
      errors: verificationStatus === "FAIL" && error ? [error] : [],
    },
    error,
  };
  const validation = validateExecutionReport(report);
  if (!validation.ok)
    throw new Error(`Revision report contract failed: ${JSON.stringify(validation.errors)}`);
  writeDeterministicJson(
    status === "SUCCESS"
      ? context.workspace.executionReportPath
      : context.workspace.failureReportPath,
    report,
  );
  return report;
}

function resultFor(context: RevisionContext, report: RevisionExecutionReport): RevisionResult {
  return {
    workerVersion: "0.1.0",
    status: report.status,
    targetVersion: targetDccVersion,
    dccVersion: context.dcc?.version ?? null,
    compatibilityMode: context.compatibilityMode,
    dcc: context.dcc,
    workspace: context.workspace.root,
    mutationProcess: context.mutationProcess,
    verificationProcess: context.verificationProcess,
    renderStateVerificationProcess: context.renderStateVerificationProcess,
    renderStateEvidence: context.renderStateEvidence,
    materialStateVerificationProcess: context.materialStateVerificationProcess,
    materialStateEvidence: context.materialStateEvidence,
    cameraStateVerificationProcess: context.cameraStateVerificationProcess,
    cameraStateEvidence: context.cameraStateEvidence,
    comparison: context.comparison,
    semanticDiff: context.semanticDiff,
    report,
    error: report.error,
    replayed: false,
    originalJobId: context.jobId,
    currentJobId: context.jobId,
    idempotencyKey: context.idempotencyKey,
    requestHash: context.requestHash,
    verifiedOutputPath: report.status === "SUCCESS" ? context.workspace.outputPath : null,
    baseArtifactPath: context.baseArtifactPath,
    baseArtifactHash: context.baseArtifactHash,
  };
}

function persistRevisionLedger(
  config: WorkerConfig,
  context: RevisionContext,
  report: RevisionExecutionReport,
): void {
  const success = report.status === "SUCCESS";
  const now = new Date().toISOString();
  writeLedgerAtomic(config.workspaceRoot, {
    ...context.activeLedger,
    status: success ? "SUCCESS" : report.error?.retryable ? "FAILED_RETRYABLE" : "FAILED_FINAL",
    successfulJobId: success ? context.jobId : null,
    retryable: success ? false : (report.error?.retryable ?? false),
    errorCode: report.error?.code ?? null,
    completedAt: now,
    updatedAt: now,
    reportPath: relative(
      config.workspaceRoot,
      success ? context.workspace.executionReportPath : context.workspace.failureReportPath,
    ),
    verifiedOutputPath: success
      ? relative(config.workspaceRoot, context.workspace.outputPath)
      : null,
    manifestPath: success ? relative(config.workspaceRoot, context.workspace.manifestPath) : null,
    verifiedOutputHash: success ? rawFileHash(context.workspace.outputPath) : null,
    manifestHash: success ? semanticJsonHash(readJson(context.workspace.manifestPath)) : null,
    dccVersion: context.dcc?.version ?? null,
    compatibilityMode: context.compatibilityMode,
  });
}

function failRevision(
  config: WorkerConfig,
  context: RevisionContext,
  code: string,
  message: string,
  retryable = false,
  verificationFailed = false,
): RevisionResult {
  const error = makeError(code, message, retryable);
  const report = reportFor(context, "FAILED", error, verificationFailed ? "FAIL" : "NOT_RUN");
  persistRevisionLedger(config, context, report);
  return resultFor(context, report);
}

export async function applySceneChangeSet(
  config: WorkerConfig,
  suppliedBaseJobPath: string,
  suppliedChangeSetPath: string,
  options: { jobId?: string; authorizeDccExecution?: boolean } = {},
): Promise<RevisionResult> {
  const defaultJobId = "job_revision_preflight";
  if (
    !isDccExecutionAuthorized({
      allowDccExecution: config.allowDccExecution,
      authorizeDccExecution: options.authorizeDccExecution === true,
    })
  ) {
    return noExecution(
      defaultJobId,
      makeError(
        "DCC_EXECUTION_DISABLED",
        "DCC execution requires allowDccExecution=true and explicit call-site authorization",
      ),
    );
  }
  let prepared: {
    baseJob: JobEnvelope;
    baseScene: Record<string, unknown>;
    baseManifest: Record<string, unknown>;
    targetScene: Record<string, unknown>;
    expectedManifest: Record<string, unknown>;
    tolerances: ManifestTolerances;
    changeSet: ChangeSetContract;
    plan: RevisionMutationPlan;
    expectedRenderState: Record<string, unknown> | null;
    expectedMaterialState: Record<string, unknown> | null;
    expectedCameraState: Record<string, unknown> | null;
    baseArtifactPath: string;
    baseArtifactHash: string;
  };
  try {
    const baseJobPath = resolveWithinRoot(
      config.repositoryRoot,
      relative(config.repositoryRoot, resolve(config.repositoryRoot, suppliedBaseJobPath)),
    );
    const changeSetPath = resolveWithinRoot(
      config.repositoryRoot,
      relative(config.repositoryRoot, resolve(config.repositoryRoot, suppliedChangeSetPath)),
    );
    const baseJobValidation = validateJobEnvelope(readJson(baseJobPath));
    if (!baseJobValidation.ok)
      throw new RevisionValidationError("SCHEMA_INVALID", "Base job is invalid");
    const baseJob = baseJobValidation.value;
    const initialScene = readJson(
      sourcePath(config.repositoryRoot, baseJobPath, baseJob.inputs.sceneSpecPath),
    ) as Record<string, unknown>;
    const initialManifest = readJson(
      sourcePath(config.repositoryRoot, baseJobPath, baseJob.inputs.expectedManifestPath),
    ) as Record<string, unknown>;
    const hashes = verifyJobHashes(baseJob, initialScene, initialManifest);
    if (!hashes.ok)
      throw new RevisionValidationError("HASH_MISMATCH", JSON.stringify(hashes.mismatches));
    const submittedChangeSet = readJson(changeSetPath) as { baseRevisionId?: unknown };
    const submittedValidation = validateSceneChangeSet(submittedChangeSet);
    if (!submittedValidation.ok) {
      throw new RevisionValidationError(
        "SCHEMA_INVALID",
        `SceneChangeSet validation failed: ${JSON.stringify(submittedValidation.errors)}`,
      );
    }
    const fixtureRoot = dirname(dirname(changeSetPath));
    const requestedBaseRevision = String(submittedValidation.value.baseRevisionId);
    const baseRevisionRoot = resolveWithinRoot(
      config.repositoryRoot,
      relative(config.repositoryRoot, resolve(fixtureRoot, "revisions", requestedBaseRevision)),
    );
    const baseScene =
      requestedBaseRevision === baseJob.requestedRevisionId
        ? initialScene
        : (readJson(resolve(baseRevisionRoot, "scene-spec.json")) as Record<string, unknown>);
    const baseManifest =
      requestedBaseRevision === baseJob.requestedRevisionId
        ? initialManifest
        : (readJson(resolve(baseRevisionRoot, "expected-scene-manifest.json")) as Record<
            string,
            unknown
          >);
    if (!validateSceneSpec(baseScene).ok || !validateSceneManifest(baseManifest).ok) {
      throw new RevisionValidationError("SCHEMA_INVALID", "Base revision fixture is invalid");
    }
    const planned = planSceneRevision(baseScene, submittedChangeSet);
    const revisionRoot = resolve(
      dirname(dirname(changeSetPath)),
      "revisions",
      planned.changeSet.targetRevisionId,
    );
    const targetScene = readJson(resolve(revisionRoot, "scene-spec.json")) as Record<
      string,
      unknown
    >;
    const expectedManifest = readJson(
      resolve(revisionRoot, "expected-scene-manifest.json"),
    ) as Record<string, unknown>;
    if (!validateSceneSpec(targetScene).ok || !validateSceneManifest(expectedManifest).ok) {
      throw new RevisionValidationError("SCHEMA_INVALID", "Expected revision fixture is invalid");
    }
    if (!isDeepStrictEqual(planned.targetSceneSpec, targetScene)) {
      throw new RevisionValidationError(
        "EXPECTED_STATE_MISMATCH",
        `Computed target SceneSpec differs from the committed ${planned.changeSet.targetRevisionId} fixture`,
      );
    }
    const verifiedBase = findVerifiedBaseArtifact(
      config,
      {
        projectId: planned.changeSet.projectId,
        sceneId: planned.changeSet.sceneId,
        revisionId: planned.changeSet.baseRevisionId,
      },
      baseManifest,
    );
    prepared = {
      baseJob,
      baseScene,
      baseManifest,
      targetScene,
      expectedManifest,
      tolerances: readJson(
        resolve(dirname(baseJobPath), "fixture-manifest.json"),
      ) as ManifestTolerances,
      changeSet: planned.changeSet,
      plan: planned.plan,
      expectedRenderState: canonicalRenderStateExpectation(targetScene),
      expectedMaterialState: canonicalMaterialStateExpectation(targetScene),
      expectedCameraState:
        planned.plan.operation.type === "SetCamera"
          ? canonicalCameraStateExpectation(targetScene)
          : null,
      baseArtifactPath: verifiedBase.artifactPath,
      baseArtifactHash: verifiedBase.artifactHash,
    };
  } catch (error) {
    const validationError =
      error instanceof RevisionValidationError
        ? error
        : new RevisionValidationError(
            "REVISION_PRECHECK_FAILED",
            error instanceof Error ? error.message : String(error),
          );
    return noExecution(defaultJobId, makeError(validationError.code, validationError.message));
  }

  const idempotencyKey = `revision.${prepared.changeSet.changeSetId}`;
  const requestHash = semanticJsonHash({
    baseArtifactHash: prepared.baseArtifactHash,
    baseRevisionId: prepared.changeSet.baseRevisionId,
    baseSceneSpecHash: semanticJsonHash(prepared.baseScene),
    changeSetHash: semanticJsonHash(prepared.changeSet),
    expectedManifestHash: semanticJsonHash(prepared.expectedManifest),
    expectedSceneSpecHash: semanticJsonHash(prepared.targetScene),
    projectId: prepared.changeSet.projectId,
    sceneId: prepared.changeSet.sceneId,
    targetRevisionId: prepared.changeSet.targetRevisionId,
    workerRequirements: {
      os: "windows",
      dcc: "3ds_max",
      renderer:
        prepared.changeSet.operations[0]?.type === "SetRenderIntent" ||
        prepared.changeSet.operations[0]?.type === "AddLight"
          ? "corona"
          : "none",
    },
  });
  const jobId = options.jobId ?? `job_${prepared.changeSet.changeSetId}`;
  if (!/^[a-z][a-z0-9_]{2,127}$/u.test(jobId)) {
    return noExecution(jobId, makeError("JOB_ID_INVALID", "Revision jobId is invalid"), {
      idempotencyKey,
      requestHash,
    });
  }
  let idempotencyLock: ReturnType<typeof acquireExecutionLock> | null = null;
  let sceneLock: ReturnType<typeof acquireExecutionLock> | null = null;
  let executionContext: RevisionContext | null = null;
  try {
    idempotencyLock = acquireExecutionLock(
      config.workspaceRoot,
      "idempotency",
      idempotencyKey,
      jobId,
    );
    const previous = readLedger(config.workspaceRoot, idempotencyKey);
    const decision = evaluateLedger(previous, { idempotencyKey, requestHash });
    if (decision === "IDEMPOTENCY_KEY_REUSE_MISMATCH") {
      return noExecution(
        jobId,
        makeError("IDEMPOTENCY_KEY_REUSE_MISMATCH", "Revision key is bound to another request"),
        { idempotencyKey, requestHash },
      );
    }
    if (decision === "REPLAY_SUCCESS" && previous) {
      return replayRevision(config, previous, jobId, prepared.baseManifest, prepared.changeSet);
    }
    if (decision === "REPLAY_FAILURE" && previous) {
      return noExecution(
        jobId,
        makeError(previous.errorCode ?? "FAILED_FINAL", "Stored revision failure replayed"),
        { idempotencyKey, requestHash },
      );
    }
    sceneLock = acquireExecutionLock(
      config.workspaceRoot,
      "scene",
      `${prepared.changeSet.projectId}\u0000${prepared.changeSet.sceneId}`,
      jobId,
    );
    const activeLedger = startLedgerAttempt(previous, { idempotencyKey, requestHash, jobId });
    writeLedgerAtomic(config.workspaceRoot, activeLedger);
    const workspace = createJobWorkspace(config.workspaceRoot, jobId);
    const context: RevisionContext = {
      startedAt: new Date().toISOString(),
      jobId,
      idempotencyKey,
      requestHash,
      changeSet: prepared.changeSet,
      workspace,
      activeLedger,
      dcc: null,
      compatibilityMode: false,
      mutationProcess: null,
      verificationProcess: null,
      renderStateVerificationProcess: null,
      renderStateEvidence: null,
      materialStateVerificationProcess: null,
      materialStateEvidence: null,
      cameraStateVerificationProcess: null,
      cameraStateEvidence: null,
      comparison: null,
      semanticDiff: null,
      baseArtifactPath: prepared.baseArtifactPath,
      baseArtifactHash: prepared.baseArtifactHash,
    };
    executionContext = context;
    writeDeterministicJson(workspace.sceneSpecPath, prepared.baseScene);
    writeDeterministicJson(workspace.targetSceneSpecPath, prepared.targetScene);
    writeDeterministicJson(workspace.expectedManifestPath, prepared.expectedManifest);
    if (prepared.expectedMaterialState) {
      writeDeterministicJson(workspace.expectedMaterialStatePath, prepared.expectedMaterialState);
    }
    if (prepared.expectedCameraState) {
      writeDeterministicJson(workspace.expectedCameraStatePath, prepared.expectedCameraState);
    }
    if (prepared.expectedRenderState) {
      writeDeterministicJson(workspace.expectedRenderStatePath, prepared.expectedRenderState);
    }
    writeDeterministicJson(workspace.changeSetPath, prepared.changeSet);
    writeDeterministicJson(workspace.revisionPlanPath, prepared.plan);
    copyFileSync(prepared.baseArtifactPath, workspace.baseScenePath);
    if (rawFileHash(workspace.baseScenePath) !== prepared.baseArtifactHash) {
      return failRevision(
        config,
        context,
        "BASE_ARTIFACT_COPY_MISMATCH",
        "Base checkpoint hash changed",
      );
    }
    context.dcc = await discoverThreeDsMax({
      installationOverride: config.threeDsMaxInstallationPath,
    });
    if (context.dcc.status === "NOT_FOUND" || !context.dcc.batchExecutablePath) {
      return failRevision(config, context, "DCC_NOT_FOUND", "3ds Max Batch is unavailable");
    }
    if (context.dcc.status === "UNSUPPORTED") {
      if (!(config.allowCompatibilityVersionForSpike && context.dcc.version === "2025")) {
        return failRevision(
          config,
          context,
          "DCC_VERSION_UNSUPPORTED",
          `Detected ${context.dcc.version ?? "unknown"}; target is 2026`,
        );
      }
      context.compatibilityMode = true;
    }
    const timeoutMs = Math.min(
      config.processTimeoutMs,
      prepared.baseJob.policy.timeoutSeconds * 1_000,
    );
    context.mutationProcess = await runControlledProcess({
      executable: context.dcc.batchExecutablePath,
      args: threeDsMaxBatchArguments(
        resolve(config.repositoryRoot, "tools/3ds-max/python/apply_change_set.py"),
      ),
      cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
      timeoutMs,
      env: buildDccChildEnvironment({
        overrides: {
          AI_ARCHVIZ_BASE_SCENE_PATH: workspace.baseScenePath,
          AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
          AI_ARCHVIZ_REVISION_PLAN_PATH: workspace.revisionPlanPath,
          AI_ARCHVIZ_MUTATION_RESULT_PATH: workspace.mutationResultPath,
          AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE:
            process.env.AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE,
          AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE:
            process.env.AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE,
          ...(prepared.expectedRenderState ||
          prepared.expectedMaterialState ||
          prepared.expectedCameraState
            ? { AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1" }
            : {}),
        },
      }),
      outputEncoding: "utf16le",
    });
    if (context.mutationProcess.errorCode) {
      const retryable = ["PROCESS_TIMEOUT", "DCC_LAUNCH_FAILED"].includes(
        context.mutationProcess.errorCode,
      );
      return failRevision(
        config,
        context,
        context.mutationProcess.errorCode,
        "Revision mutation process failed",
        retryable,
      );
    }
    const mutationResult = existsSync(workspace.mutationResultPath)
      ? (readJson(workspace.mutationResultPath) as {
          status?: unknown;
          errorCode?: unknown;
          message?: unknown;
        })
      : null;
    if (mutationResult?.status !== "SUCCESS") {
      return failRevision(
        config,
        context,
        typeof mutationResult?.errorCode === "string"
          ? mutationResult.errorCode
          : "MUTATION_FAILED",
        typeof mutationResult?.message === "string"
          ? mutationResult.message
          : "Mutation result missing",
      );
    }
    if (!existsSync(workspace.candidatePath) || statSync(workspace.candidatePath).size <= 0) {
      return failRevision(config, context, "CANDIDATE_MISSING", "Mutation produced no candidate");
    }
    context.verificationProcess = await runControlledProcess({
      executable: context.dcc.batchExecutablePath,
      args: threeDsMaxBatchArguments(
        resolve(config.repositoryRoot, "tools/3ds-max/python/verify_scene.py"),
      ),
      cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
      timeoutMs,
      env: buildDccChildEnvironment({
        overrides: {
          AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
          AI_ARCHVIZ_MANIFEST_PATH: workspace.manifestPath,
          AI_ARCHVIZ_VERIFY_RESULT_PATH: workspace.verificationResultPath,
        },
      }),
      outputEncoding: "utf16le",
    });
    if (context.verificationProcess.errorCode) {
      return failRevision(
        config,
        context,
        context.verificationProcess.errorCode,
        "Fresh revision verification process failed",
        context.verificationProcess.errorCode === "PROCESS_TIMEOUT",
        true,
      );
    }
    const verificationResult = existsSync(workspace.verificationResultPath)
      ? (readJson(workspace.verificationResultPath) as { status?: unknown; message?: unknown })
      : null;
    if (verificationResult?.status !== "SUCCESS" || !existsSync(workspace.manifestPath)) {
      return failRevision(
        config,
        context,
        "VERIFICATION_FAILED",
        typeof verificationResult?.message === "string"
          ? verificationResult.message
          : "Fresh verification result is missing",
        false,
        true,
      );
    }
    const actualManifest = readJson(workspace.manifestPath) as Record<string, unknown>;
    if (!validateSceneManifest(actualManifest).ok) {
      return failRevision(
        config,
        context,
        "SCHEMA_INVALID",
        "Revision manifest is invalid",
        false,
        true,
      );
    }
    context.comparison = compareSceneManifests(
      prepared.expectedManifest,
      actualManifest,
      prepared.tolerances,
    );
    if (!context.comparison.ok) {
      return failRevision(
        config,
        context,
        "MANIFEST_MISMATCH",
        JSON.stringify(context.comparison.differences),
        false,
        true,
      );
    }
    context.semanticDiff = diffSemanticManifests(prepared.baseManifest, actualManifest);
    assertRevisionDiff(context.semanticDiff, prepared.changeSet);
    if (prepared.expectedRenderState) {
      context.renderStateVerificationProcess = await runControlledProcess({
        executable: context.dcc.batchExecutablePath,
        args: threeDsMaxBatchArguments(
          resolve(config.repositoryRoot, "tools/3ds-max/python/verify_canonical_render_state.py"),
        ),
        cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
        timeoutMs,
        env: buildDccChildEnvironment({
          overrides: {
            AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
            AI_ARCHVIZ_EXPECTED_RENDER_STATE_PATH: workspace.expectedRenderStatePath,
            AI_ARCHVIZ_RENDER_STATE_PATH: workspace.renderStatePath,
            AI_ARCHVIZ_RENDER_STATE_RESULT_PATH: workspace.renderStateResultPath,
            AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
          },
        }),
        outputEncoding: "utf16le",
      });
      if (context.renderStateVerificationProcess.errorCode) {
        return failRevision(
          config,
          context,
          context.renderStateVerificationProcess.errorCode,
          "Fresh canonical render-state verification process failed",
          context.renderStateVerificationProcess.errorCode === "PROCESS_TIMEOUT",
          true,
        );
      }
      if (!existsSync(workspace.renderStatePath) || !existsSync(workspace.renderStateResultPath)) {
        return failRevision(
          config,
          context,
          "RENDER_STATE_VERIFICATION_FAILED",
          "Canonical render-state evidence is missing",
          false,
          true,
        );
      }
      const renderStateEvidence = readJson(workspace.renderStatePath) as Record<string, unknown>;
      const renderStateValidation = validateCanonicalRenderStateEvidence(renderStateEvidence);
      if (!renderStateValidation.ok) {
        return failRevision(
          config,
          context,
          "RENDER_STATE_EVIDENCE_INVALID",
          JSON.stringify(renderStateValidation.errors),
          false,
          true,
        );
      }
      if (!isDeepStrictEqual(renderStateEvidence, prepared.expectedRenderState)) {
        return failRevision(
          config,
          context,
          "RENDER_STATE_MISMATCH",
          `Expected ${JSON.stringify(prepared.expectedRenderState)}, received ${JSON.stringify(renderStateEvidence)}`,
          false,
          true,
        );
      }
      context.renderStateEvidence = renderStateEvidence;
    }
    if (prepared.expectedMaterialState) {
      context.materialStateVerificationProcess = await runControlledProcess({
        executable: context.dcc.batchExecutablePath,
        args: threeDsMaxBatchArguments(
          resolve(config.repositoryRoot, "tools/3ds-max/python/verify_canonical_material_state.py"),
        ),
        cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
        timeoutMs,
        env: buildDccChildEnvironment({
          overrides: {
            AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
            AI_ARCHVIZ_EXPECTED_MATERIAL_STATE_PATH: workspace.expectedMaterialStatePath,
            AI_ARCHVIZ_MATERIAL_STATE_PATH: workspace.materialStatePath,
            AI_ARCHVIZ_MATERIAL_STATE_RESULT_PATH: workspace.materialStateResultPath,
            AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE:
              process.env.AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE,
            AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
          },
        }),
        outputEncoding: "utf16le",
      });
      if (context.materialStateVerificationProcess.errorCode) {
        return failRevision(
          config,
          context,
          context.materialStateVerificationProcess.errorCode,
          "Fresh canonical material-state verification process failed",
          context.materialStateVerificationProcess.errorCode === "PROCESS_TIMEOUT",
          true,
        );
      }
      if (!existsSync(workspace.materialStatePath)) {
        const materialStateResult = existsSync(workspace.materialStateResultPath)
          ? (readJson(workspace.materialStateResultPath) as {
              status?: unknown;
              errorCode?: unknown;
              message?: unknown;
            })
          : null;
        return failRevision(
          config,
          context,
          typeof materialStateResult?.errorCode === "string"
            ? materialStateResult.errorCode
            : "MATERIAL_STATE_VERIFICATION_FAILED",
          typeof materialStateResult?.message === "string"
            ? materialStateResult.message
            : "Canonical material-state evidence is missing",
          false,
          true,
        );
      }
      if (!existsSync(workspace.materialStateResultPath)) {
        return failRevision(
          config,
          context,
          "MATERIAL_STATE_VERIFICATION_FAILED",
          "Canonical material-state verification result is missing",
          false,
          true,
        );
      }
      const materialStateEvidence = readJson(workspace.materialStatePath) as Record<
        string,
        unknown
      >;
      const materialStateValidation = validateCanonicalMaterialStateEvidence(materialStateEvidence);
      if (!materialStateValidation.ok) {
        return failRevision(
          config,
          context,
          "MATERIAL_STATE_EVIDENCE_INVALID",
          JSON.stringify(materialStateValidation.errors),
          false,
          true,
        );
      }
      if (!isDeepStrictEqual(materialStateEvidence, prepared.expectedMaterialState)) {
        return failRevision(
          config,
          context,
          "MATERIAL_STATE_MISMATCH",
          `Expected ${JSON.stringify(prepared.expectedMaterialState)}, received ${JSON.stringify(materialStateEvidence)}`,
          false,
          true,
        );
      }
      context.materialStateEvidence = materialStateEvidence;
    }
    if (prepared.expectedCameraState) {
      context.cameraStateVerificationProcess = await runControlledProcess({
        executable: context.dcc.batchExecutablePath,
        args: threeDsMaxBatchArguments(
          resolve(config.repositoryRoot, "tools/3ds-max/python/verify_canonical_camera_state.py"),
        ),
        cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
        timeoutMs,
        env: buildDccChildEnvironment({
          overrides: {
            AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
            AI_ARCHVIZ_EXPECTED_CAMERA_STATE_PATH: workspace.expectedCameraStatePath,
            AI_ARCHVIZ_CAMERA_STATE_PATH: workspace.cameraStatePath,
            AI_ARCHVIZ_CAMERA_STATE_RESULT_PATH: workspace.cameraStateResultPath,
            AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE:
              process.env.AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE,
            AI_ARCHVIZ_REQUIRE_SAFE_SCENE: "1",
          },
        }),
        outputEncoding: "utf16le",
      });
      if (context.cameraStateVerificationProcess.errorCode) {
        return failRevision(
          config,
          context,
          context.cameraStateVerificationProcess.errorCode,
          "Fresh canonical camera-state verification process failed",
          context.cameraStateVerificationProcess.errorCode === "PROCESS_TIMEOUT",
          true,
        );
      }
      if (!existsSync(workspace.cameraStatePath)) {
        const cameraStateResult = existsSync(workspace.cameraStateResultPath)
          ? (readJson(workspace.cameraStateResultPath) as {
              status?: unknown;
              errorCode?: unknown;
              message?: unknown;
            })
          : null;
        return failRevision(
          config,
          context,
          typeof cameraStateResult?.errorCode === "string"
            ? cameraStateResult.errorCode
            : "CAMERA_STATE_VERIFICATION_FAILED",
          typeof cameraStateResult?.message === "string"
            ? cameraStateResult.message
            : "Canonical camera-state evidence is missing",
          false,
          true,
        );
      }
      if (!existsSync(workspace.cameraStateResultPath)) {
        return failRevision(
          config,
          context,
          "CAMERA_STATE_VERIFICATION_FAILED",
          "Canonical camera-state verification result is missing",
          false,
          true,
        );
      }
      const cameraStateEvidence = readJson(workspace.cameraStatePath) as Record<string, unknown>;
      const cameraStateValidation = validateCanonicalCameraStateEvidence(cameraStateEvidence);
      if (!cameraStateValidation.ok) {
        return failRevision(
          config,
          context,
          "CAMERA_STATE_EVIDENCE_INVALID",
          JSON.stringify(cameraStateValidation.errors),
          false,
          true,
        );
      }
      if (!isDeepStrictEqual(cameraStateEvidence, prepared.expectedCameraState)) {
        return failRevision(
          config,
          context,
          "CAMERA_STATE_MISMATCH",
          `Expected ${JSON.stringify(prepared.expectedCameraState)}, received ${JSON.stringify(cameraStateEvidence)}`,
          false,
          true,
        );
      }
      context.cameraStateEvidence = cameraStateEvidence;
    }
    if (rawFileHash(prepared.baseArtifactPath) !== prepared.baseArtifactHash) {
      return failRevision(
        config,
        context,
        "BASE_ARTIFACT_CHANGED",
        `${prepared.changeSet.baseRevisionId} source artifact changed`,
      );
    }
    promoteCandidate(workspace.candidatePath, workspace.outputPath);
    const report = reportFor(context, "SUCCESS", null, "PASS");
    persistRevisionLedger(config, context, report);
    return resultFor(context, report);
  } catch (error) {
    if (error instanceof ExecutionLockedError) {
      return noExecution(jobId, makeError(error.code, error.message, true), {
        idempotencyKey,
        requestHash,
      });
    }
    if (executionContext) {
      return failRevision(
        config,
        executionContext,
        error instanceof RevisionValidationError ? error.code : "REVISION_EXECUTION_FAILED",
        error instanceof Error ? error.message : String(error),
        error instanceof RevisionValidationError ? error.retryable : true,
      );
    }
    return noExecution(
      jobId,
      makeError(
        error instanceof RevisionValidationError ? error.code : "REVISION_EXECUTION_FAILED",
        error instanceof Error ? error.message : String(error),
      ),
      { idempotencyKey, requestHash },
    );
  } finally {
    sceneLock?.release();
    idempotencyLock?.release();
  }
}

function replayRevision(
  config: WorkerConfig,
  record: IdempotencyLedgerRecord,
  currentJobId: string,
  baseManifest: Record<string, unknown>,
  changeSet: ChangeSetContract,
): RevisionResult {
  if (!record.reportPath || !record.verifiedOutputPath || !record.manifestPath) {
    return noExecution(
      currentJobId,
      makeError("RECOVERY_REQUIRED", "Revision replay paths missing"),
      {
        idempotencyKey: record.idempotencyKey,
        requestHash: record.requestHash,
      },
    );
  }
  const reportPath = resolveWithinRoot(config.workspaceRoot, record.reportPath);
  const outputPath = resolveWithinRoot(config.workspaceRoot, record.verifiedOutputPath);
  const manifestPath = resolveWithinRoot(config.workspaceRoot, record.manifestPath);
  if (!existsSync(reportPath) || !existsSync(outputPath) || !existsSync(manifestPath)) {
    return noExecution(
      currentJobId,
      makeError("RECOVERY_REQUIRED", "Revision replay artifact missing"),
      {
        idempotencyKey: record.idempotencyKey,
        requestHash: record.requestHash,
      },
    );
  }
  const reportValidation = validateExecutionReport(readJson(reportPath));
  const manifest = readJson(manifestPath) as Record<string, unknown>;
  if (
    !reportValidation.ok ||
    reportValidation.value.status !== "SUCCESS" ||
    reportValidation.value.jobId !== record.successfulJobId ||
    record.verifiedOutputHash !== rawFileHash(outputPath) ||
    record.manifestHash !== semanticJsonHash(manifest)
  ) {
    return noExecution(
      currentJobId,
      makeError("RECOVERY_REQUIRED", "Revision replay evidence invalid"),
      {
        idempotencyKey: record.idempotencyKey,
        requestHash: record.requestHash,
      },
    );
  }
  if (currentJobId !== record.successfulJobId && !record.replayJobIds.includes(currentJobId)) {
    writeLedgerAtomic(config.workspaceRoot, {
      ...record,
      replayJobIds: [...record.replayJobIds, currentJobId],
      latestJobId: currentJobId,
      updatedAt: new Date().toISOString(),
    });
  }
  const report = reportValidation.value as unknown as RevisionExecutionReport;
  const semanticDiff = diffSemanticManifests(baseManifest, manifest);
  assertRevisionDiff(semanticDiff, changeSet);
  let renderStateEvidence: CanonicalRenderStateEvidence | null = null;
  if (
    changeSet.operations[0]?.type === "SetRenderIntent" ||
    changeSet.operations[0]?.type === "AddLight" ||
    changeSet.operations[0]?.type === "MigrateMaterialAppearanceContract" ||
    changeSet.operations[0]?.type === "SetCamera"
  ) {
    const renderStatePath = resolve(dirname(manifestPath), "canonical-render-state.json");
    if (!existsSync(renderStatePath)) {
      return noExecution(
        currentJobId,
        makeError("RECOVERY_REQUIRED", "Canonical render-state replay evidence missing"),
        { idempotencyKey: record.idempotencyKey, requestHash: record.requestHash },
      );
    }
    const candidateEvidence = readJson(renderStatePath) as Record<string, unknown>;
    if (!validateCanonicalRenderStateEvidence(candidateEvidence).ok) {
      return noExecution(
        currentJobId,
        makeError("RECOVERY_REQUIRED", "Canonical render-state replay evidence invalid"),
        { idempotencyKey: record.idempotencyKey, requestHash: record.requestHash },
      );
    }
    renderStateEvidence = candidateEvidence;
  }
  let materialStateEvidence: CanonicalMaterialStateEvidence | null = null;
  if (
    changeSet.operations[0]?.type === "MigrateMaterialAppearanceContract" ||
    changeSet.operations[0]?.type === "SetCamera"
  ) {
    const materialStatePath = resolve(dirname(manifestPath), "canonical-material-state.json");
    if (!existsSync(materialStatePath)) {
      return noExecution(
        currentJobId,
        makeError("RECOVERY_REQUIRED", "Canonical material-state replay evidence missing"),
        { idempotencyKey: record.idempotencyKey, requestHash: record.requestHash },
      );
    }
    const candidateMaterialEvidence = readJson(materialStatePath) as Record<string, unknown>;
    if (!validateCanonicalMaterialStateEvidence(candidateMaterialEvidence).ok) {
      return noExecution(
        currentJobId,
        makeError("RECOVERY_REQUIRED", "Canonical material-state replay evidence invalid"),
        { idempotencyKey: record.idempotencyKey, requestHash: record.requestHash },
      );
    }
    materialStateEvidence = candidateMaterialEvidence;
  }
  let cameraStateEvidence: CanonicalCameraStateEvidence | null = null;
  if (changeSet.operations[0]?.type === "SetCamera") {
    const cameraStatePath = resolve(dirname(manifestPath), "canonical-camera-state.json");
    if (!existsSync(cameraStatePath)) {
      return noExecution(
        currentJobId,
        makeError("RECOVERY_REQUIRED", "Canonical camera-state replay evidence missing"),
        { idempotencyKey: record.idempotencyKey, requestHash: record.requestHash },
      );
    }
    const candidateCameraEvidence = readJson(cameraStatePath) as Record<string, unknown>;
    if (!validateCanonicalCameraStateEvidence(candidateCameraEvidence).ok) {
      return noExecution(
        currentJobId,
        makeError("RECOVERY_REQUIRED", "Canonical camera-state replay evidence invalid"),
        { idempotencyKey: record.idempotencyKey, requestHash: record.requestHash },
      );
    }
    cameraStateEvidence = candidateCameraEvidence;
  }
  return {
    workerVersion: "0.1.0",
    status: "SUCCESS",
    targetVersion: targetDccVersion,
    dccVersion: record.dccVersion,
    compatibilityMode: record.compatibilityMode,
    dcc: null,
    workspace: dirname(dirname(outputPath)),
    mutationProcess: null,
    verificationProcess: null,
    renderStateVerificationProcess: null,
    renderStateEvidence,
    materialStateVerificationProcess: null,
    materialStateEvidence,
    cameraStateVerificationProcess: null,
    cameraStateEvidence,
    comparison: null,
    semanticDiff,
    report,
    error: null,
    replayed: true,
    originalJobId: record.successfulJobId ?? record.originalJobId,
    currentJobId,
    idempotencyKey: record.idempotencyKey,
    requestHash: record.requestHash,
    verifiedOutputPath: outputPath,
    baseArtifactPath: null,
    baseArtifactHash: null,
  };
}
