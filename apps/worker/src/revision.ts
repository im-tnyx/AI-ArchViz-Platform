import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type SceneChangeSet,
  validateSceneChangeSet,
  validateSceneSpec,
} from "@ai-archviz/scene-spec";
import {
  type JobEnvelope,
  semanticJsonHash,
  validateExecutionReport,
  validateJobEnvelope,
  validateSceneManifest,
  verifyJobHashes,
} from "@ai-archviz/worker-contracts";
import type { SemanticTransform, Vector3 } from "./build-plan.js";
import type { WorkerConfig } from "./config.js";
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

interface ChangeSetContract extends SceneChangeSet {
  schemaVersion: "0.1.0";
  changeSetId: string;
  projectId: string;
  sceneId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  operations: [MoveObjectOperation];
  metadata: { createdAt: string };
}

interface SceneDocument extends Record<string, unknown> {
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
    dimensions: Vector3;
    allowNonUniformScale: boolean;
    transform: SemanticTransform;
    locks: { transform: boolean };
  }>;
  revisions: Array<Record<string, unknown>>;
}

export interface RevisionMutationPlan {
  revisionPlanVersion: "0.1.0";
  changeSetId: string;
  projectId: string;
  sceneId: string;
  baseRevisionId: string;
  targetRevisionId: string;
  operation: {
    operationId: string;
    type: "MoveObject";
    targetId: string;
    transform: SemanticTransform;
  };
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
        (operation as { type?: unknown }).type !== "MoveObject",
    )
  ) {
    throw new RevisionValidationError("OPERATION_UNSUPPORTED", "Spike 2 supports MoveObject only");
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
  if (operation?.type !== "MoveObject") {
    throw new RevisionValidationError("OPERATION_UNSUPPORTED", "Spike 2 supports MoveObject only");
  }
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

  const targetSceneSpec = structuredClone(baseValue) as SceneDocument;
  targetSceneSpec.scene.revisionId = changeSet.targetRevisionId;
  targetSceneSpec.scene.headRevisionId = changeSet.targetRevisionId;
  const targetAsset = targetSceneSpec.assets.find((asset) => asset.id === operation.targetId);
  if (!targetAsset) throw new RevisionValidationError("TARGET_NOT_FOUND", "Target disappeared");
  targetAsset.transform = structuredClone(operation.parameters.transform);
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
  return {
    changeSet,
    targetSceneSpec,
    plan: {
      revisionPlanVersion: "0.1.0",
      changeSetId: changeSet.changeSetId,
      projectId: changeSet.projectId,
      sceneId: changeSet.sceneId,
      baseRevisionId: changeSet.baseRevisionId,
      targetRevisionId: changeSet.targetRevisionId,
      operation: {
        operationId: operation.operationId,
        type: "MoveObject",
        targetId: operation.targetId,
        transform: structuredClone(operation.parameters.transform),
      },
      expectedManagedLogicalIds: managedLogicalIds(base),
    },
  };
}

function validatePlacement(
  scene: SceneDocument,
  target: SceneDocument["assets"][number],
  transform: SemanticTransform,
): void {
  const space = scene.spaces.find((entry) => entry.id === target.spaceId);
  if (!space) throw new RevisionValidationError("SPACE_NOT_FOUND", "Target space was not found");
  if (
    !target.allowNonUniformScale &&
    (transform.scale[0] !== transform.scale[1] || transform.scale[1] !== transform.scale[2])
  ) {
    throw new RevisionValidationError(
      "NON_UNIFORM_SCALE_NOT_ALLOWED",
      `Target ${target.id} does not allow non-uniform scale`,
    );
  }
  const width = target.dimensions[0] * transform.scale[0];
  const depth = target.dimensions[1] * transform.scale[1];
  const height = target.dimensions[2] * transform.scale[2];
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
  if (path === "embeddedMetadata.AIArchViz.RevisionId") return;
  if (isDeepStrictEqual(before, after)) return;
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

function sourcePath(repositoryRoot: string, declaredByPath: string, declaredPath: string): string {
  return resolveWithinRoot(
    repositoryRoot,
    relative(repositoryRoot, resolve(dirname(declaredByPath), basename(declaredPath))),
  );
}

function rawFileHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
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
  options: { jobId?: string } = {},
): Promise<RevisionResult> {
  const defaultJobId = "job_revision_preflight";
  let prepared: {
    baseJob: JobEnvelope;
    baseScene: Record<string, unknown>;
    baseManifest: Record<string, unknown>;
    targetScene: Record<string, unknown>;
    expectedManifest: Record<string, unknown>;
    tolerances: ManifestTolerances;
    changeSet: ChangeSetContract;
    plan: RevisionMutationPlan;
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
    const baseScene = readJson(
      sourcePath(config.repositoryRoot, baseJobPath, baseJob.inputs.sceneSpecPath),
    ) as Record<string, unknown>;
    const baseManifest = readJson(
      sourcePath(config.repositoryRoot, baseJobPath, baseJob.inputs.expectedManifestPath),
    ) as Record<string, unknown>;
    const hashes = verifyJobHashes(baseJob, baseScene, baseManifest);
    if (!hashes.ok)
      throw new RevisionValidationError("HASH_MISMATCH", JSON.stringify(hashes.mismatches));
    const planned = planSceneRevision(baseScene, readJson(changeSetPath));
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
        "Computed target SceneSpec differs from the committed rev0002 fixture",
      );
    }
    const baseLedger = readLedger(config.workspaceRoot, baseJob.idempotencyKey);
    if (
      baseLedger?.status !== "SUCCESS" ||
      !baseLedger.verifiedOutputPath ||
      !baseLedger.reportPath ||
      !baseLedger.manifestPath
    ) {
      throw new RevisionValidationError(
        "BASE_ARTIFACT_NOT_VERIFIED",
        "Complete verified rev0001 evidence is not present in the durable ledger",
      );
    }
    const baseArtifactPath = resolveWithinRoot(config.workspaceRoot, baseLedger.verifiedOutputPath);
    const baseReportPath = resolveWithinRoot(config.workspaceRoot, baseLedger.reportPath);
    const baseVerifiedManifestPath = resolveWithinRoot(
      config.workspaceRoot,
      baseLedger.manifestPath,
    );
    if (
      !existsSync(baseArtifactPath) ||
      !existsSync(baseReportPath) ||
      !existsSync(baseVerifiedManifestPath)
    ) {
      throw new RevisionValidationError(
        "RECOVERY_REQUIRED",
        "Verified rev0001 evidence is incomplete",
      );
    }
    const baseReportValidation = validateExecutionReport(readJson(baseReportPath));
    const baseVerifiedManifest = readJson(baseVerifiedManifestPath);
    const baseVerifiedManifestValidation = validateSceneManifest(baseVerifiedManifest);
    if (
      !baseReportValidation.ok ||
      baseReportValidation.value.status !== "SUCCESS" ||
      baseReportValidation.value.jobId !== baseLedger.successfulJobId ||
      baseReportValidation.value.requestHash !== baseJob.requestHash ||
      !baseVerifiedManifestValidation.ok ||
      baseLedger.verifiedOutputHash !== rawFileHash(baseArtifactPath) ||
      baseLedger.manifestHash !== semanticJsonHash(baseVerifiedManifest) ||
      baseLedger.manifestHash !== baseJob.inputs.expectedManifestHash
    ) {
      throw new RevisionValidationError(
        "RECOVERY_REQUIRED",
        "Verified rev0001 report, manifest, or artifact evidence is invalid",
      );
    }
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
      baseArtifactPath,
      baseArtifactHash: rawFileHash(baseArtifactPath),
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
    workerRequirements: { os: "windows", dcc: "3ds_max", renderer: "none" },
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
      return replayRevision(config, previous, jobId, prepared.baseManifest);
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
      comparison: null,
      semanticDiff: null,
      baseArtifactPath: prepared.baseArtifactPath,
      baseArtifactHash: prepared.baseArtifactHash,
    };
    executionContext = context;
    writeDeterministicJson(workspace.sceneSpecPath, prepared.baseScene);
    writeDeterministicJson(workspace.targetSceneSpecPath, prepared.targetScene);
    writeDeterministicJson(workspace.expectedManifestPath, prepared.expectedManifest);
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
      args: [resolve(config.repositoryRoot, "tools/3ds-max/python/apply_change_set.py"), "-v", "2"],
      cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
      timeoutMs,
      env: {
        ...process.env,
        AI_ARCHVIZ_BASE_SCENE_PATH: workspace.baseScenePath,
        AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
        AI_ARCHVIZ_REVISION_PLAN_PATH: workspace.revisionPlanPath,
        AI_ARCHVIZ_MUTATION_RESULT_PATH: workspace.mutationResultPath,
      },
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
      args: [resolve(config.repositoryRoot, "tools/3ds-max/python/verify_scene.py"), "-v", "2"],
      cwd: context.dcc.installationPath ?? dirname(context.dcc.batchExecutablePath),
      timeoutMs,
      env: {
        ...process.env,
        AI_ARCHVIZ_CANDIDATE_PATH: workspace.candidatePath,
        AI_ARCHVIZ_MANIFEST_PATH: workspace.manifestPath,
        AI_ARCHVIZ_VERIFY_RESULT_PATH: workspace.verificationResultPath,
      },
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
    assertGoldenRevisionDiff(context.semanticDiff);
    if (rawFileHash(prepared.baseArtifactPath) !== prepared.baseArtifactHash) {
      return failRevision(
        config,
        context,
        "BASE_ARTIFACT_CHANGED",
        "rev0001 source artifact changed",
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
  assertGoldenRevisionDiff(semanticDiff);
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
