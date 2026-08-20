import { createHash } from "node:crypto";
import { createReadStream, lstatSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, win32 } from "node:path";
import {
  type AssetArtifact,
  type AssetInspectionEvidence,
  validateAssetArtifact,
  validateAssetInspection,
} from "@ai-archviz/worker-contracts";
import { WorkerError, type WorkerErrorCode } from "./errors.js";

export type AssetTrustState = "QUARANTINED" | "INSPECTED" | "VERIFIED" | "REJECTED";

export interface AssetArtifactRegistryRecord {
  artifact: AssetArtifact;
  /**
   * Worker-controlled, normalized relative key. This is deliberately not a
   * SceneSpec or manifest field and is never exposed by the eligibility API.
   */
  storageKey: string;
  inspection?: AssetInspectionEvidence;
}

export interface AssetArtifactRegistry {
  records: AssetArtifactRegistryRecord[];
}

export interface ExternalAssetDefinitionReference {
  id: string;
  sourceType: "external_max";
  artifactId: string;
}

export interface EligibleAssetArtifact {
  artifactId: string;
  format: "3ds_max";
  sha256: string;
  byteLength: number;
}

export interface ResolvedVerifiedAssetArtifact extends EligibleAssetArtifact {
  /** Internal worker-only filesystem location. Never serialize into SceneSpec or a manifest. */
  internalPath: string;
}

/**
 * Quarantined bytes which may be opened only by the isolated inspection
 * process. This is intentionally not production eligibility.
 */
export interface ResolvedInspectionAssetArtifact extends EligibleAssetArtifact {
  /** Internal worker-only filesystem location. Never serialize into a job or manifest. */
  internalPath: string;
}

interface NormalizedArtifact extends EligibleAssetArtifact {
  trustState: AssetTrustState;
}

interface NormalizedRegistryRecord {
  artifact: NormalizedArtifact;
  storageKey: string;
}

function fail(code: WorkerErrorCode, message: string): never {
  throw new WorkerError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNormalizedArtifact(value: AssetArtifact): NormalizedArtifact {
  return value as unknown as NormalizedArtifact;
}

function containsControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function assertStorageKey(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || containsControlCharacters(value)) {
    return fail("ASSET_ARTIFACT_PATH_ESCAPE", "Asset storage key is invalid");
  }
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[a-z]:/iu.test(value)
  ) {
    return fail(
      "ASSET_ARTIFACT_PATH_ESCAPE",
      "Asset storage key must be a normalized relative path",
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return fail("ASSET_ARTIFACT_PATH_ESCAPE", "Asset storage key contains a traversal segment");
  }
  if (extname(value) !== ".max") {
    return fail("ASSET_ARTIFACT_TYPE_INVALID", "Asset storage key must name a .max file");
  }
  return value;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relationship = relative(root, candidate);
  return relationship !== "" && !relationship.startsWith("..") && !isAbsolute(relationship);
}

function normalizedRegistry(registry: unknown): Map<string, NormalizedRegistryRecord> {
  if (!isRecord(registry) || !Array.isArray(registry.records)) {
    return fail("ASSET_ARTIFACT_REGISTRY_INVALID", "Asset registry must contain a records array");
  }

  const entries = new Map<string, NormalizedRegistryRecord>();
  for (const record of registry.records) {
    if (!isRecord(record) || !("artifact" in record) || !("storageKey" in record)) {
      return fail("ASSET_ARTIFACT_REGISTRY_INVALID", "Asset registry record is invalid");
    }
    const artifactValidation = validateAssetArtifact(record.artifact);
    if (!artifactValidation.ok) {
      return fail(
        "ASSET_ARTIFACT_REGISTRY_INVALID",
        "Asset registry contains an invalid artifact record",
      );
    }
    const artifact = asNormalizedArtifact(artifactValidation.value);
    if (entries.has(artifact.artifactId)) {
      return fail(
        "ASSET_ARTIFACT_REGISTRY_INVALID",
        "Asset registry contains a duplicate artifact ID",
      );
    }
    const storageKey = assertStorageKey(record.storageKey);
    const inspection = record.inspection;
    if (inspection !== undefined) {
      const inspectionValidation = validateAssetInspection(inspection);
      if (!inspectionValidation.ok) {
        return fail("ASSET_ARTIFACT_INSPECTION_INVALID", "Asset inspection evidence is invalid");
      }
      const validatedInspection = inspectionValidation.value as {
        artifactId: string;
        artifactSha256: string;
        result: "pass" | "fail";
      };
      if (
        validatedInspection.artifactId !== artifact.artifactId ||
        validatedInspection.artifactSha256 !== artifact.sha256
      ) {
        return fail(
          "ASSET_ARTIFACT_INSPECTION_INVALID",
          "Asset inspection evidence does not bind artifact identity",
        );
      }
      if (artifact.trustState === "VERIFIED" && validatedInspection.result !== "pass") {
        return fail(
          "ASSET_ARTIFACT_INSPECTION_INVALID",
          "Verified artifact requires passing inspection evidence",
        );
      }
    }
    if (artifact.trustState === "VERIFIED" && inspection === undefined) {
      return fail(
        "ASSET_ARTIFACT_INSPECTION_INVALID",
        "Verified artifact requires inspection evidence",
      );
    }
    entries.set(artifact.artifactId, { artifact, storageKey });
  }
  return entries;
}

/**
 * Validates registry structure, artifact identity, inspection binding, and
 * storage-key safety without touching the filesystem.
 */
export function validateAssetArtifactRegistry(
  registry: AssetArtifactRegistry,
): ReadonlyMap<string, EligibleAssetArtifact> {
  return new Map(
    [...normalizedRegistry(registry).values()].map((record) => [
      record.artifact.artifactId,
      {
        artifactId: record.artifact.artifactId,
        format: record.artifact.format,
        sha256: record.artifact.sha256,
        byteLength: record.artifact.byteLength,
      },
    ]),
  );
}

/**
 * Pure preflight: only a verified artifact with matching passing inspection
 * evidence becomes eligible. It deliberately returns no storage location.
 */
export function validateAssetArtifactEligibility(
  assetDefinition: ExternalAssetDefinitionReference,
  registry: AssetArtifactRegistry,
): EligibleAssetArtifact {
  if (assetDefinition.sourceType !== "external_max" || assetDefinition.artifactId.length === 0) {
    return fail("ASSET_ARTIFACT_REGISTRY_INVALID", "External asset definition is invalid");
  }
  const record = normalizedRegistry(registry).get(assetDefinition.artifactId);
  if (!record) {
    return fail("ASSET_ARTIFACT_NOT_FOUND", "External asset artifact is not registered");
  }
  if (record.artifact.trustState !== "VERIFIED") {
    return fail("ASSET_ARTIFACT_NOT_VERIFIED", "External asset artifact is not verified");
  }
  return {
    artifactId: record.artifact.artifactId,
    format: record.artifact.format,
    sha256: record.artifact.sha256,
    byteLength: record.artifact.byteLength,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

function canonicalTrustedRoot(trustedAssetRoot: string): string {
  if (!isAbsolute(trustedAssetRoot)) {
    return fail("ASSET_ARTIFACT_PATH_ESCAPE", "Trusted asset root must be absolute");
  }
  try {
    const canonicalRoot = realpathSync(trustedAssetRoot);
    if (!statSync(canonicalRoot).isDirectory()) {
      return fail("ASSET_ARTIFACT_TYPE_INVALID", "Trusted asset root is not a directory");
    }
    return canonicalRoot;
  } catch {
    return fail("ASSET_ARTIFACT_NOT_FOUND", "Trusted asset root is unavailable");
  }
}

function isPassingInspectionEvidenceSafeForPromotion(evidence: AssetInspectionEvidence): boolean {
  if (
    evidence.result !== "pass" ||
    !Array.isArray(evidence.findings) ||
    evidence.findings.length !== 0
  ) {
    return false;
  }
  if (!isRecord(evidence.observations)) return false;
  const observations = evidence.observations;
  if (!isRecord(observations.dependencies) || !isRecord(observations.security)) return false;
  const dependencies = observations.dependencies;
  const security = observations.security;
  return (
    dependencies.missingExternalFiles === 0 &&
    dependencies.missingDLLs === 0 &&
    dependencies.xrefs === 0 &&
    dependencies.externalReferenceCount === 0 &&
    security.safeSceneScriptExecutionEnabled === true &&
    security.settingsLocked === true &&
    security.lockCause === "cmdline" &&
    security.scriptAssetsProtected === true
  );
}

function eligibleArtifact(record: NormalizedRegistryRecord): EligibleAssetArtifact {
  return {
    artifactId: record.artifact.artifactId,
    format: record.artifact.format,
    sha256: record.artifact.sha256,
    byteLength: record.artifact.byteLength,
  };
}

async function resolveExactTrustedArtifact({
  artifactId,
  trustedAssetRoot,
  registry,
  requiredTrustState,
}: {
  artifactId: string;
  trustedAssetRoot: string;
  registry: AssetArtifactRegistry;
  requiredTrustState: AssetTrustState;
}): Promise<ResolvedVerifiedAssetArtifact> {
  const records = normalizedRegistry(registry);
  const record = records.get(artifactId);
  if (!record) {
    return fail("ASSET_ARTIFACT_NOT_FOUND", "External asset artifact is not registered");
  }
  if (record.artifact.trustState !== requiredTrustState) {
    return fail(
      "ASSET_ARTIFACT_NOT_VERIFIED",
      requiredTrustState === "VERIFIED"
        ? "External asset artifact is not verified"
        : "External asset artifact is not quarantined for inspection",
    );
  }
  const eligibility = eligibleArtifact(record);
  const trustedRoot = canonicalTrustedRoot(trustedAssetRoot);
  const candidate = resolve(trustedRoot, ...record.storageKey.split("/"));
  if (!isWithinRoot(trustedRoot, candidate)) {
    return fail("ASSET_ARTIFACT_PATH_ESCAPE", "Asset storage key escapes the trusted root");
  }

  let canonicalCandidate: string;
  try {
    lstatSync(candidate);
  } catch {
    return fail("ASSET_ARTIFACT_NOT_FOUND", "Asset artifact is missing");
  }
  const candidateEntry = lstatSync(candidate);
  if (!candidateEntry.isFile() && !candidateEntry.isSymbolicLink()) {
    return fail("ASSET_ARTIFACT_TYPE_INVALID", "Asset artifact is not a regular file");
  }
  try {
    canonicalCandidate = realpathSync(candidate);
  } catch {
    return fail("ASSET_ARTIFACT_NOT_FOUND", "Asset artifact is missing");
  }
  if (!isWithinRoot(trustedRoot, canonicalCandidate)) {
    return fail("ASSET_ARTIFACT_PATH_ESCAPE", "Asset artifact resolves outside the trusted root");
  }
  if (extname(canonicalCandidate) !== ".max" || !statSync(canonicalCandidate).isFile()) {
    return fail("ASSET_ARTIFACT_TYPE_INVALID", "Asset artifact is not a regular .max file");
  }
  if (statSync(canonicalCandidate).size !== eligibility.byteLength) {
    return fail(
      "ASSET_ARTIFACT_SIZE_MISMATCH",
      "Asset artifact byte length does not match registry",
    );
  }
  if ((await sha256File(canonicalCandidate)) !== eligibility.sha256) {
    return fail("ASSET_ARTIFACT_HASH_MISMATCH", "Asset artifact SHA-256 does not match registry");
  }
  return { ...eligibility, internalPath: canonicalCandidate };
}

/**
 * Resolves only exact, worker-registered QUARANTINED bytes for a dedicated
 * inspection process. It does not make an artifact production-consumable.
 */
export async function resolveArtifactForInspection({
  artifactId,
  trustedAssetRoot,
  registry,
}: {
  artifactId: string;
  trustedAssetRoot: string;
  registry: AssetArtifactRegistry;
}): Promise<ResolvedInspectionAssetArtifact> {
  return resolveExactTrustedArtifact({
    artifactId,
    trustedAssetRoot,
    registry,
    requiredTrustState: "QUARANTINED",
  });
}

/**
 * Pure internal transition. Only a quarantined artifact and matching passing
 * evidence can become VERIFIED; callers must persist the returned artifact
 * and evidence together in their worker-owned registry.
 */
export function promoteArtifactAfterInspection({
  artifact,
  evidence,
}: {
  artifact: AssetArtifact;
  evidence: AssetInspectionEvidence;
}): AssetArtifact {
  const artifactValidation = validateAssetArtifact(artifact);
  if (!artifactValidation.ok) {
    return fail("ASSET_ARTIFACT_REGISTRY_INVALID", "Artifact is invalid for inspection promotion");
  }
  const normalizedArtifact = asNormalizedArtifact(artifactValidation.value);
  if (normalizedArtifact.trustState !== "QUARANTINED") {
    return fail("ASSET_ARTIFACT_NOT_VERIFIED", "Only quarantined artifacts may be promoted");
  }
  const evidenceValidation = validateAssetInspection(evidence);
  if (!evidenceValidation.ok) {
    return fail("ASSET_ARTIFACT_INSPECTION_INVALID", "Inspection evidence is invalid");
  }
  const normalizedEvidence = evidenceValidation.value as AssetInspectionEvidence & {
    artifactId: string;
    artifactSha256: string;
    result: "pass" | "fail";
  };
  if (
    normalizedEvidence.artifactId !== normalizedArtifact.artifactId ||
    normalizedEvidence.artifactSha256 !== normalizedArtifact.sha256 ||
    !isPassingInspectionEvidenceSafeForPromotion(normalizedEvidence)
  ) {
    return fail("ASSET_ARTIFACT_INSPECTION_INVALID", "Inspection evidence cannot promote artifact");
  }
  return { ...artifactValidation.value, trustState: "VERIFIED" };
}

/**
 * Resolves a registry locator only after eligibility has passed. The returned
 * path is an internal worker value; it must not be copied to SceneSpec,
 * manifests, jobs, logs, or DCC-facing plans.
 */
export async function resolveVerifiedAssetArtifact({
  artifactId,
  trustedAssetRoot,
  registry,
}: {
  artifactId: string;
  trustedAssetRoot: string;
  registry: AssetArtifactRegistry;
}): Promise<ResolvedVerifiedAssetArtifact> {
  const eligibility = validateAssetArtifactEligibility(
    { id: "asset_definition_reference", sourceType: "external_max", artifactId },
    registry,
  );
  const resolved = await resolveExactTrustedArtifact({
    artifactId,
    trustedAssetRoot,
    registry,
    requiredTrustState: "VERIFIED",
  });
  return { ...eligibility, internalPath: resolved.internalPath };
}
