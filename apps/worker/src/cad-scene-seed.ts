import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { CAD_SOURCE_MAX_BYTES } from "@ai-archviz/cad-parser";
import {
  CadSceneSeedError,
  type CadSceneSeedErrorCode,
  createSceneSpecSeedWithHashes,
} from "@ai-archviz/cad-scene-seed";
import type { SceneSpec } from "@ai-archviz/scene-spec";
import { evaluateCirculationRequirements, validateSpatialScene } from "@ai-archviz/spatial-engine";
import {
  type CadSceneSeedEvidence,
  semanticJsonHash,
  validateCadSceneSeedEvidence,
} from "@ai-archviz/worker-contracts";
import {
  PathContainmentError,
  resolveExistingFileWithinRoot,
  resolveOutputPathWithinRoot,
} from "./paths.js";
import { compileSurfaceMesh, SurfaceMeshError } from "./surface-mesh.js";
import { writeDeterministicJson } from "./workspace.js";

/**
 * Technical Spike 10C worker boundary: a human-approved
 * architectural-extraction-v0.1 + cad-scene-seed-approval-v0.1 -> pure
 * canonical SceneSpec v0.4 seed -> 9A spatial validation -> 9C circulation
 * requirement evaluation -> cad-scene-seed-evidence-v0.1. Nothing is written
 * and no DCC can run unless every step passes. No DXF re-parsing, no 10B
 * re-interpretation, no AI, no network; paths never enter hashed artifacts.
 */

export type CadSceneSeedWorkerErrorCode =
  | CadSceneSeedErrorCode
  | "CAD_SCENE_SEED_SPATIAL_INVALID"
  | "CAD_SCENE_SEED_CIRCULATION_UNSATISFIED"
  | "CAD_SCENE_SEED_HASH_MISMATCH"
  | "CAD_SCENE_SEED_EVIDENCE_INVALID"
  | "CAD_SCENE_SEED_BUILD_UNSUPPORTED"
  | "CAD_SCENE_SEED_INPUT_PATH_INVALID"
  | "CAD_SCENE_SEED_INPUT_NOT_FOUND"
  | "CAD_SCENE_SEED_INPUT_JSON_INVALID"
  | "CAD_SCENE_SEED_OUTPUT_PATH_INVALID";

export class CadSceneSeedWorkerError extends Error {
  readonly code: CadSceneSeedWorkerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CadSceneSeedWorkerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CadSceneSeedWorkerError";
    this.code = code;
    this.details = details;
  }
}

export interface CadSceneSeedResult {
  sceneSpec: SceneSpec;
  sceneSpecHash: string;
  approvalHash: string;
  evidence: CadSceneSeedEvidence;
}

/** Pure seed creation + pre-DCC validation over already-loaded objects. */
export function createCadSceneSeed(extraction: unknown, approval: unknown): CadSceneSeedResult {
  let seeded: ReturnType<typeof createSceneSpecSeedWithHashes>;
  try {
    seeded = createSceneSpecSeedWithHashes(extraction, approval);
  } catch (error) {
    if (error instanceof CadSceneSeedError) {
      throw new CadSceneSeedWorkerError(error.code, error.message, { ...error.details });
    }
    throw error;
  }
  const { sceneSpec } = seeded;
  // Recompute with the shared worker-contracts primitive.
  const approvalHash = semanticJsonHash(approval);
  if (
    approvalHash !== seeded.approvalHash ||
    semanticJsonHash(extraction) !== seeded.architecturalExtractionHash
  ) {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_HASH_MISMATCH",
      "Seed hashes disagree with the worker semantic hashes",
    );
  }

  // Approval can never bypass 9A spatial validation.
  const spatial = validateSpatialScene(sceneSpec);
  if (spatial.status !== "PASS") {
    const [first] = spatial.violations;
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_SPATIAL_INVALID",
      `Seed fails spatial-policy-v0.1 (${first?.code ?? "unknown"})`,
      { spatialCode: first?.code ?? null, violations: spatial.violations },
    );
  }
  const circulation = evaluateCirculationRequirements(sceneSpec);
  if (circulation.status !== "PASS") {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_CIRCULATION_UNSATISFIED",
      "Seed does not satisfy its canonical circulation requirements",
    );
  }

  const extension = (sceneSpec.extensions as Record<string, Record<string, string>>)[
    "aiarchviz.cad_seed"
  ] as Record<string, string>;
  const scene = sceneSpec.scene as { id: string; revisionId: string };
  const geometry = sceneSpec.geometry as { type: string }[];
  const evidence: CadSceneSeedEvidence = {
    evidenceVersion: "0.1.0",
    canonicalizationPolicyVersion: "cad-scene-seed-policy-v0.1",
    approvalId: String(extension.approvalId),
    approvalHash,
    sourceHash: String(extension.sourceHash),
    cadDocumentHash: String(extension.cadDocumentHash),
    profileHash: String(extension.profileHash),
    architecturalExtractionHash: String(extension.architecturalExtractionHash),
    sceneSpecVersion: "0.4.0",
    sceneSpecHash: semanticJsonHash(sceneSpec),
    projectId: (sceneSpec.project as { id: string }).id,
    sceneId: scene.id,
    revisionId: scene.revisionId,
    mappingSummary: {
      levelCount: (sceneSpec.levels as unknown[]).length,
      spaceCount: (sceneSpec.spaces as unknown[]).length,
      wallCount: geometry.filter((entry) => entry.type === "wall").length,
      surfaceCount: geometry.filter((entry) => entry.type !== "wall").length,
      openingCount: (sceneSpec.openings as unknown[]).length,
    },
    spatialValidationStatus: "PASS",
    circulationRequirementStatus: "PASS",
    status: "PASS",
  };
  const evidenceResult = validateCadSceneSeedEvidence(evidence);
  if (!evidenceResult.ok) {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_EVIDENCE_INVALID",
      "Seed evidence does not satisfy cad-scene-seed-evidence-v0.1",
      { errors: evidenceResult.errors },
    );
  }
  return { sceneSpec, sceneSpecHash: evidence.sceneSpecHash, approvalHash, evidence };
}

/**
 * Pre-DCC realizability check against the SHARED initial build (build plan
 * v0.2). Every floor/ceiling is compiled with the same `compileSurfaceMesh`
 * the build uses, so translated, non-axis-aligned, and concave simple
 * polygons are accepted; only what v0.2 cannot realize exactly (surface
 * rotation/scale, non-simple or non-coplanar boundaries) is refused before
 * any DCC launch rather than built approximately.
 */
export function assertSeedBuildRealizable(sceneSpec: SceneSpec): void {
  for (const surface of (sceneSpec.geometry as Record<string, unknown>[]).filter(
    (entry) => entry.type === "floor" || entry.type === "ceiling",
  )) {
    try {
      compileSurfaceMesh(surface);
    } catch (error) {
      if (!(error instanceof SurfaceMeshError)) throw error;
      throw new CadSceneSeedWorkerError(
        "CAD_SCENE_SEED_BUILD_UNSUPPORTED",
        `Surface ${String(surface.id)} cannot be realized exactly by the initial build: ${error.message}`,
        { surfaceId: surface.id, reason: error.code },
      );
    }
  }
}

function readJsonInput(root: string, relativePath: string, label: string) {
  if (extname(relativePath).toLowerCase() !== ".json") {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_INPUT_PATH_INVALID",
      `${label} must be a .json file`,
    );
  }
  let physicalPath: string;
  try {
    // Lexical AND physical (realpath) containment; final links never followed.
    physicalPath = resolveExistingFileWithinRoot(root, relativePath);
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadSceneSeedWorkerError(
      error.reason === "NOT_FOUND"
        ? "CAD_SCENE_SEED_INPUT_NOT_FOUND"
        : "CAD_SCENE_SEED_INPUT_PATH_INVALID",
      `${label} path is missing or not contained in the trusted root`,
      { reason: error.reason },
    );
  }
  if (lstatSync(physicalPath).size > CAD_SOURCE_MAX_BYTES) {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_INPUT_PATH_INVALID",
      `${label} exceeds ${CAD_SOURCE_MAX_BYTES} bytes`,
    );
  }
  try {
    return { physicalPath, value: JSON.parse(readFileSync(physicalPath, "utf8")) as unknown };
  } catch {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_INPUT_JSON_INVALID",
      `${label} is not valid JSON`,
    );
  }
}

export interface SeedSceneFromCadFilesOptions {
  repositoryRoot: string;
  /** Root-relative architectural-extraction-v0.1 JSON (the 10B artifact). */
  extractionPath: string;
  /** Root-relative cad-scene-seed-approval-v0.1 JSON. */
  approvalPath: string;
}

export interface CadSceneSeedFiles extends CadSceneSeedResult {
  /** Execution metadata only; never part of any hashed artifact. */
  inputAbsolutePaths: string[];
}

export function seedSceneFromCadFiles(options: SeedSceneFromCadFilesOptions): CadSceneSeedFiles {
  const extraction = readJsonInput(options.repositoryRoot, options.extractionPath, "Extraction");
  const approval = readJsonInput(options.repositoryRoot, options.approvalPath, "Approval");
  return {
    ...createCadSceneSeed(extraction.value, approval.value),
    inputAbsolutePaths: [extraction.physicalPath, approval.physicalPath],
  };
}

export interface CadSceneSeedOutputPaths {
  sceneSpecPath: string;
  evidencePath: string;
}

/** Writes the seed SceneSpec + evidence, contained lexically and physically. */
export function writeCadSceneSeed(
  result: CadSceneSeedFiles,
  outputRoot: string,
  outputPath: string,
): CadSceneSeedOutputPaths {
  const lowered = outputPath.toLowerCase();
  if (!lowered.endsWith(".json") || lowered.endsWith(".evidence.json")) {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_OUTPUT_PATH_INVALID",
      "Output path must end in .json (and not .evidence.json)",
    );
  }
  let sceneSpecPath: string;
  let evidencePath: string;
  try {
    sceneSpecPath = resolveOutputPathWithinRoot(outputRoot, outputPath);
    evidencePath = resolveOutputPathWithinRoot(
      outputRoot,
      `${outputPath.slice(0, -".json".length)}.evidence.json`,
    );
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_OUTPUT_PATH_INVALID",
      "Output path must stay inside the worker output root, lexically and physically",
      { reason: error.reason },
    );
  }
  const inputs = new Set(result.inputAbsolutePaths.map((path) => resolve(path).toLowerCase()));
  if ([sceneSpecPath, evidencePath].some((path) => inputs.has(resolve(path).toLowerCase()))) {
    throw new CadSceneSeedWorkerError(
      "CAD_SCENE_SEED_OUTPUT_PATH_INVALID",
      "Output must not overwrite an input",
    );
  }
  writeDeterministicJson(sceneSpecPath, result.sceneSpec);
  writeDeterministicJson(evidencePath, result.evidence);
  return { sceneSpecPath, evidencePath };
}
