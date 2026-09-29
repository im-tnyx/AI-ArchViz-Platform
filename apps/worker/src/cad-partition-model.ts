import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { deriveSpaceWallStage } from "@ai-archviz/cad-interpreter";
import { CAD_SOURCE_MAX_BYTES } from "@ai-archviz/cad-parser";
import {
  CadPartitionError,
  type CadPartitionErrorCode,
  createReviewedPartitionModel,
  type ReviewedPartitionModel,
  validateReviewedPartitionModel,
} from "@ai-archviz/cad-partition-model";
import {
  type CadPartitionModelEvidence,
  semanticJsonHash,
  validateCadPartitionModelEvidence,
} from "@ai-archviz/worker-contracts";
import {
  PathContainmentError,
  resolveExistingFileWithinRoot,
  resolveOutputPathWithinRoot,
} from "./paths.js";
import { writeDeterministicJson } from "./workspace.js";

/**
 * Technical Spike 10E worker boundary: cad-document-v0.1 +
 * cad-interpretation-profile-v0.1 + architectural-extraction-v0.1 (or null
 * for the space_wall_stage basis) + architectural-topology-v0.1 +
 * cad-topology-approval-v0.1 -> pure reviewed-partition-model-v0.1 ->
 * cad-partition-model-evidence-v0.1. Every hash in the chain is recomputed
 * here with the shared worker-contracts primitive. No DXF re-parsing, no
 * SceneSpec, no DCC, no AI, no network; paths never enter a hashed artifact.
 */

export type CadPartitionWorkerErrorCode =
  | CadPartitionErrorCode
  | "CAD_PARTITION_INPUT_PATH_INVALID"
  | "CAD_PARTITION_INPUT_NOT_FOUND"
  | "CAD_PARTITION_INPUT_JSON_INVALID"
  | "CAD_PARTITION_OUTPUT_PATH_INVALID"
  | "CAD_PARTITION_OUTPUT_INVALID"
  | "CAD_PARTITION_HASH_MISMATCH"
  | "CAD_PARTITION_EVIDENCE_INVALID";

export class CadPartitionWorkerError extends Error {
  readonly code: CadPartitionWorkerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CadPartitionWorkerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CadPartitionWorkerError";
    this.code = code;
    this.details = details;
  }
}

export interface CadPartitionInputs {
  cadDocument: unknown;
  interpretationProfile: unknown;
  /** The 10B extraction, or null exactly for the space_wall_stage basis. */
  architecturalExtraction: unknown;
  architecturalTopology: unknown;
  approval: unknown;
}

export interface CadPartitionResult {
  model: ReviewedPartitionModel;
  reviewedPartitionModelHash: string;
  evidence: CadPartitionModelEvidence;
}

/** Pure evidence builder over already-loaded input objects. */
export function cadPartitionModelEvidence(inputs: CadPartitionInputs): CadPartitionResult {
  let model: ReviewedPartitionModel;
  try {
    model = createReviewedPartitionModel({
      cadDocument: inputs.cadDocument,
      interpretationProfile: inputs.interpretationProfile,
      architecturalExtraction: inputs.architecturalExtraction,
      architecturalTopology: inputs.architecturalTopology,
      approval: inputs.approval,
    });
  } catch (error) {
    if (error instanceof CadPartitionError) {
      throw new CadPartitionWorkerError(error.code, error.message, { ...error.details });
    }
    throw error;
  }
  const validated = validateReviewedPartitionModel(model);
  if (!validated.ok) {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_OUTPUT_INVALID",
      "Partition model output does not satisfy reviewed-partition-model-v0.1",
      { errors: validated.errors },
    );
  }

  // Recompute the complete chain; the topology's own recorded hashes are never trusted.
  const extraction = inputs.architecturalExtraction as {
    level: unknown;
    spaces: unknown;
    walls: unknown;
  } | null;
  const candidates =
    extraction ?? deriveSpaceWallStage(inputs.cadDocument, inputs.interpretationProfile);
  const recomputed = {
    cadDocumentHash: semanticJsonHash(inputs.cadDocument),
    profileHash: semanticJsonHash(inputs.interpretationProfile),
    architecturalExtractionHash: extraction === null ? null : semanticJsonHash(extraction),
    spaceWallStageHash: semanticJsonHash({
      level: candidates.level,
      spaces: candidates.spaces,
      walls: candidates.walls,
    }),
    architecturalTopologyHash: semanticJsonHash(inputs.architecturalTopology),
  };
  const approvalHash = semanticJsonHash(inputs.approval);
  const mismatched = [
    ...(Object.keys(recomputed) as (keyof typeof recomputed)[]).filter(
      (key) => model.source[key] !== recomputed[key],
    ),
    ...(model.approvalHash === approvalHash ? [] : ["approvalHash"]),
  ];
  if (mismatched.length > 0) {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_HASH_MISMATCH",
      "Partition model hashes do not match the worker semantic hashes",
      { mismatched },
    );
  }

  const reviewedPartitionModelHash = semanticJsonHash(model);
  const evidence: CadPartitionModelEvidence = {
    evidenceVersion: "0.1.0",
    partitionPolicyVersion: model.partitionPolicyVersion,
    approvalId: model.approvalId,
    approvalHash,
    sourceHash: model.source.sourceHash,
    cadDocumentHash: recomputed.cadDocumentHash,
    profileHash: recomputed.profileHash,
    candidateBasis: model.source.candidateBasis,
    architecturalExtractionHash: recomputed.architecturalExtractionHash,
    spaceWallStageHash: recomputed.spaceWallStageHash,
    architecturalTopologyHash: recomputed.architecturalTopologyHash,
    reviewedPartitionModelVersion: model.reviewedPartitionModelVersion,
    reviewedPartitionModelHash,
    summary: { ...model.summary },
    status: model.status,
  };
  const evidenceResult = validateCadPartitionModelEvidence(evidence);
  if (!evidenceResult.ok) {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_EVIDENCE_INVALID",
      "Partition model evidence does not satisfy cad-partition-model-evidence-v0.1",
      { errors: evidenceResult.errors },
    );
  }
  return { model, reviewedPartitionModelHash, evidence };
}

export interface ReviewCadPartitionFilesOptions {
  /** Trusted, caller-controlled root; every input must stay inside it. */
  repositoryRoot: string;
  cadDocumentPath: string;
  profilePath: string;
  /** Root-relative architectural-extraction-v0.1 JSON, or null. */
  extractionPath: string | null;
  topologyPath: string;
  approvalPath: string;
}

export interface CadPartitionFiles extends CadPartitionResult {
  /** Execution metadata only; never part of any hashed artifact. */
  inputAbsolutePaths: string[];
}

function readJsonInput(root: string, relativePath: string, label: string) {
  if (extname(relativePath).toLowerCase() !== ".json") {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_INPUT_PATH_INVALID",
      `${label} must be a .json file`,
    );
  }
  let physicalPath: string;
  try {
    // Lexical AND physical (realpath) containment; final links never followed.
    physicalPath = resolveExistingFileWithinRoot(root, relativePath);
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadPartitionWorkerError(
      error.reason === "NOT_FOUND"
        ? "CAD_PARTITION_INPUT_NOT_FOUND"
        : "CAD_PARTITION_INPUT_PATH_INVALID",
      `${label} path is missing or not contained in the trusted root`,
      { reason: error.reason },
    );
  }
  if (lstatSync(physicalPath).size > CAD_SOURCE_MAX_BYTES) {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_INPUT_PATH_INVALID",
      `${label} exceeds ${CAD_SOURCE_MAX_BYTES} bytes`,
    );
  }
  try {
    return { physicalPath, value: JSON.parse(readFileSync(physicalPath, "utf8")) as unknown };
  } catch {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_INPUT_JSON_INVALID",
      `${label} is not valid JSON`,
    );
  }
}

export function reviewCadPartitionFiles(
  options: ReviewCadPartitionFilesOptions,
): CadPartitionFiles {
  const root = options.repositoryRoot;
  const cadDocument = readJsonInput(root, options.cadDocumentPath, "CAD document");
  const profile = readJsonInput(root, options.profilePath, "Profile");
  const extraction =
    options.extractionPath === null
      ? null
      : readJsonInput(root, options.extractionPath, "Architectural extraction");
  const topology = readJsonInput(root, options.topologyPath, "Architectural topology");
  const approval = readJsonInput(root, options.approvalPath, "Topology approval");
  return {
    ...cadPartitionModelEvidence({
      cadDocument: cadDocument.value,
      interpretationProfile: profile.value,
      architecturalExtraction: extraction === null ? null : extraction.value,
      architecturalTopology: topology.value,
      approval: approval.value,
    }),
    inputAbsolutePaths: [
      cadDocument,
      profile,
      ...(extraction ? [extraction] : []),
      topology,
      approval,
    ].map((input) => input.physicalPath),
  };
}

export interface CadPartitionOutputPaths {
  modelPath: string;
  evidencePath: string;
}

/**
 * Writes the reviewed model and its evidence under the worker-owned output
 * root, contained lexically and physically; both destinations are validated
 * before either write, and neither may overwrite an input.
 */
export function writeCadPartitionModel(
  result: CadPartitionFiles,
  outputRoot: string,
  outputPath: string,
): CadPartitionOutputPaths {
  const lowered = outputPath.toLowerCase();
  if (!lowered.endsWith(".json") || lowered.endsWith(".evidence.json")) {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_OUTPUT_PATH_INVALID",
      "Output path must end in .json (and not .evidence.json)",
    );
  }
  let modelPath: string;
  let evidencePath: string;
  try {
    modelPath = resolveOutputPathWithinRoot(outputRoot, outputPath);
    evidencePath = resolveOutputPathWithinRoot(
      outputRoot,
      `${outputPath.slice(0, -".json".length)}.evidence.json`,
    );
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_OUTPUT_PATH_INVALID",
      "Output path must stay inside the worker output root, lexically and physically",
      { reason: error.reason },
    );
  }
  const inputs = new Set(result.inputAbsolutePaths.map((path) => resolve(path).toLowerCase()));
  if ([modelPath, evidencePath].some((path) => inputs.has(resolve(path).toLowerCase()))) {
    throw new CadPartitionWorkerError(
      "CAD_PARTITION_OUTPUT_PATH_INVALID",
      "Output must not overwrite an input",
    );
  }
  writeDeterministicJson(modelPath, result.model);
  writeDeterministicJson(evidencePath, result.evidence);
  return { modelPath, evidencePath };
}
