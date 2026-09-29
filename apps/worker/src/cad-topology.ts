import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { deriveSpaceWallStage } from "@ai-archviz/cad-interpreter";
import { CAD_SOURCE_MAX_BYTES } from "@ai-archviz/cad-parser";
import {
  type ArchitecturalTopology,
  analyzeArchitecturalTopology,
  CadTopologyError,
  type CadTopologyErrorCode,
  validateArchitecturalTopology,
} from "@ai-archviz/cad-topology";
import {
  type CadTopologyEvidence,
  semanticJsonHash,
  validateCadTopologyEvidence,
} from "@ai-archviz/worker-contracts";
import {
  PathContainmentError,
  resolveExistingFileWithinRoot,
  resolveOutputPathWithinRoot,
} from "./paths.js";
import { writeDeterministicJson } from "./workspace.js";

/**
 * Technical Spike 10D worker boundary: validated cad-document-v0.1 +
 * cad-interpretation-profile-v0.1 + architectural-extraction-v0.1 (or null
 * when 10B v0.1 rejects a shared-boundary opening) -> pure topology
 * analysis -> architectural-topology-v0.1 -> cad-topology-evidence-v0.1.
 * Every upstream hash is recomputed here with the shared worker-contracts
 * primitive. No DXF re-parsing, no SceneSpec, no DCC, no AI, no network;
 * paths never enter any hashed artifact.
 */

export type CadTopologyWorkerErrorCode =
  | CadTopologyErrorCode
  | "CAD_TOPOLOGY_INPUT_PATH_INVALID"
  | "CAD_TOPOLOGY_INPUT_NOT_FOUND"
  | "CAD_TOPOLOGY_INPUT_JSON_INVALID"
  | "CAD_TOPOLOGY_OUTPUT_PATH_INVALID"
  | "CAD_TOPOLOGY_OUTPUT_INVALID"
  | "CAD_TOPOLOGY_HASH_MISMATCH"
  | "CAD_TOPOLOGY_EVIDENCE_INVALID";

export class CadTopologyWorkerError extends Error {
  readonly code: CadTopologyWorkerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CadTopologyWorkerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CadTopologyWorkerError";
    this.code = code;
    this.details = details;
  }
}

export interface CadTopologyInputs {
  cadDocument: unknown;
  interpretationProfile: unknown;
  /** The 10B extraction, or null only when 10B v0.1 cannot produce one. */
  architecturalExtraction: unknown;
}

export interface CadTopologyResult {
  topology: ArchitecturalTopology;
  architecturalTopologyHash: string;
  evidence: CadTopologyEvidence;
}

/** Pure evidence builder over already-loaded input objects. */
export function cadTopologyEvidence(inputs: CadTopologyInputs): CadTopologyResult {
  let topology: ArchitecturalTopology;
  try {
    topology = analyzeArchitecturalTopology({
      cadDocument: inputs.cadDocument,
      interpretationProfile: inputs.interpretationProfile,
      architecturalExtraction: inputs.architecturalExtraction,
    });
  } catch (error) {
    if (error instanceof CadTopologyError) {
      throw new CadTopologyWorkerError(error.code, error.message, { ...error.details });
    }
    throw error;
  }
  const validated = validateArchitecturalTopology(topology);
  if (!validated.ok) {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_OUTPUT_INVALID",
      "Topology output does not satisfy architectural-topology-v0.1",
      { errors: validated.errors },
    );
  }

  // Recompute every upstream hash with the shared worker-contracts primitive.
  const { source } = topology;
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
  };
  const mismatched = (Object.keys(recomputed) as (keyof typeof recomputed)[]).filter(
    (key) => source[key] !== recomputed[key],
  );
  if (mismatched.length > 0) {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_HASH_MISMATCH",
      "Topology source hashes do not match the worker semantic hashes",
      { mismatched },
    );
  }

  const architecturalTopologyHash = semanticJsonHash(topology);
  const evidence: CadTopologyEvidence = {
    evidenceVersion: "0.1.0",
    topologyPolicyVersion: topology.topologyPolicyVersion,
    interpretationPolicyVersion: source.interpretationPolicyVersion,
    sourceHash: source.sourceHash,
    cadDocumentHash: recomputed.cadDocumentHash,
    profileId: source.profileId,
    profileHash: recomputed.profileHash,
    architecturalExtractionVersion: source.architecturalExtractionVersion,
    candidateBasis: source.candidateBasis,
    architecturalExtractionHash: recomputed.architecturalExtractionHash,
    spaceWallStageHash: recomputed.spaceWallStageHash,
    architecturalTopologyVersion: topology.architecturalTopologyVersion,
    architecturalTopologyHash,
    summary: { ...topology.summary },
    status: topology.status,
  };
  const evidenceResult = validateCadTopologyEvidence(evidence);
  if (!evidenceResult.ok) {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_EVIDENCE_INVALID",
      "Topology evidence does not satisfy cad-topology-evidence-v0.1",
      { errors: evidenceResult.errors },
    );
  }
  return { topology, architecturalTopologyHash, evidence };
}

export interface AnalyzeCadTopologyFilesOptions {
  /** Trusted, caller-controlled root; every input must stay inside it. */
  repositoryRoot: string;
  /** Root-relative cad-document-v0.1 JSON (the 10A artifact). */
  cadDocumentPath: string;
  /** Root-relative cad-interpretation-profile-v0.1 JSON. */
  profilePath: string;
  /** Root-relative architectural-extraction-v0.1 JSON, or null. */
  extractionPath: string | null;
}

export interface CadTopologyFiles extends CadTopologyResult {
  /** Execution metadata only; never part of any hashed artifact. */
  inputAbsolutePaths: string[];
}

function readJsonInput(root: string, relativePath: string, label: string) {
  if (extname(relativePath).toLowerCase() !== ".json") {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_INPUT_PATH_INVALID",
      `${label} must be a .json file`,
    );
  }
  let physicalPath: string;
  try {
    // Lexical AND physical (realpath) containment; final links never followed.
    physicalPath = resolveExistingFileWithinRoot(root, relativePath);
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadTopologyWorkerError(
      error.reason === "NOT_FOUND"
        ? "CAD_TOPOLOGY_INPUT_NOT_FOUND"
        : "CAD_TOPOLOGY_INPUT_PATH_INVALID",
      `${label} path is missing or not contained in the trusted root`,
      { reason: error.reason },
    );
  }
  if (lstatSync(physicalPath).size > CAD_SOURCE_MAX_BYTES) {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_INPUT_PATH_INVALID",
      `${label} exceeds ${CAD_SOURCE_MAX_BYTES} bytes`,
    );
  }
  try {
    return { physicalPath, value: JSON.parse(readFileSync(physicalPath, "utf8")) as unknown };
  } catch {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_INPUT_JSON_INVALID",
      `${label} is not valid JSON`,
    );
  }
}

export function analyzeCadTopologyFiles(options: AnalyzeCadTopologyFilesOptions): CadTopologyFiles {
  const root = options.repositoryRoot;
  const cadDocument = readJsonInput(root, options.cadDocumentPath, "CAD document");
  const profile = readJsonInput(root, options.profilePath, "Profile");
  const extraction =
    options.extractionPath === null
      ? null
      : readJsonInput(root, options.extractionPath, "Architectural extraction");
  return {
    ...cadTopologyEvidence({
      cadDocument: cadDocument.value,
      interpretationProfile: profile.value,
      architecturalExtraction: extraction === null ? null : extraction.value,
    }),
    inputAbsolutePaths: [cadDocument, profile, ...(extraction ? [extraction] : [])].map(
      (input) => input.physicalPath,
    ),
  };
}

export interface CadTopologyOutputPaths {
  topologyPath: string;
  evidencePath: string;
}

/**
 * Writes the topology and its evidence under the worker-owned output root,
 * contained lexically and physically; both destinations are validated
 * before either write, and neither may overwrite an input.
 */
export function writeCadTopology(
  result: CadTopologyFiles,
  outputRoot: string,
  outputPath: string,
): CadTopologyOutputPaths {
  const lowered = outputPath.toLowerCase();
  if (!lowered.endsWith(".json") || lowered.endsWith(".evidence.json")) {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_OUTPUT_PATH_INVALID",
      "Output path must end in .json (and not .evidence.json)",
    );
  }
  let topologyPath: string;
  let evidencePath: string;
  try {
    topologyPath = resolveOutputPathWithinRoot(outputRoot, outputPath);
    evidencePath = resolveOutputPathWithinRoot(
      outputRoot,
      `${outputPath.slice(0, -".json".length)}.evidence.json`,
    );
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_OUTPUT_PATH_INVALID",
      "Output path must stay inside the worker output root, lexically and physically",
      { reason: error.reason },
    );
  }
  const inputs = new Set(result.inputAbsolutePaths.map((path) => resolve(path).toLowerCase()));
  if ([topologyPath, evidencePath].some((path) => inputs.has(resolve(path).toLowerCase()))) {
    throw new CadTopologyWorkerError(
      "CAD_TOPOLOGY_OUTPUT_PATH_INVALID",
      "Output must not overwrite an input",
    );
  }
  writeDeterministicJson(topologyPath, result.topology);
  writeDeterministicJson(evidencePath, result.evidence);
  return { topologyPath, evidencePath };
}
