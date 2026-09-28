import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
  type ArchitecturalExtraction,
  CadInterpretationError,
  type CadInterpretationErrorCode,
  interpretCadDocument,
  validateArchitecturalExtraction,
} from "@ai-archviz/cad-interpreter";
import { CAD_SOURCE_MAX_BYTES } from "@ai-archviz/cad-parser";
import {
  type CadInterpretationEvidence,
  semanticJsonHash,
  validateCadInterpretationEvidence,
} from "@ai-archviz/worker-contracts";
import {
  PathContainmentError,
  resolveExistingFileWithinRoot,
  resolveOutputPathWithinRoot,
} from "./paths.js";
import { writeDeterministicJson } from "./workspace.js";

/**
 * Technical Spike 10B worker boundary: validated cad-document-v0.1 +
 * cad-interpretation-profile-v0.1 -> pure interpretation ->
 * architectural-extraction-v0.1 -> cad-interpretation-evidence-v0.1.
 * Completes the hash chain raw DXF bytes (sourceHash) -> cadDocumentHash ->
 * profileHash -> architecturalExtractionHash. No DXF re-parsing, no DCC, no
 * AI, no network, no SceneSpec; paths never enter any hashed artifact.
 */

export type CadInterpretationWorkerErrorCode =
  | CadInterpretationErrorCode
  | "CAD_INTERPRET_INPUT_PATH_INVALID"
  | "CAD_INTERPRET_INPUT_NOT_FOUND"
  | "CAD_INTERPRET_INPUT_JSON_INVALID"
  | "CAD_INTERPRET_OUTPUT_PATH_INVALID"
  | "CAD_INTERPRET_EXTRACTION_INVALID"
  | "CAD_INTERPRET_HASH_MISMATCH"
  | "CAD_INTERPRET_EVIDENCE_INVALID";

export class CadInterpretationWorkerError extends Error {
  readonly code: CadInterpretationWorkerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CadInterpretationWorkerErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CadInterpretationWorkerError";
    this.code = code;
    this.details = details;
  }
}

export interface CadInterpretationResult {
  extraction: ArchitecturalExtraction;
  architecturalExtractionHash: string;
  evidence: CadInterpretationEvidence;
}

/** Pure evidence builder over already-loaded input objects. */
export function cadInterpretationEvidence(
  cadDocument: unknown,
  profile: unknown,
): CadInterpretationResult {
  let extraction: ArchitecturalExtraction;
  try {
    extraction = interpretCadDocument(cadDocument, profile);
  } catch (error) {
    if (error instanceof CadInterpretationError) {
      throw new CadInterpretationWorkerError(error.code, error.message, { ...error.details });
    }
    throw error;
  }
  const validated = validateArchitecturalExtraction(extraction);
  if (!validated.ok) {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_EXTRACTION_INVALID",
      "Interpretation output does not satisfy architectural-extraction-v0.1",
      { errors: validated.errors },
    );
  }
  // Recompute both input hashes with the shared worker-contracts primitive.
  const cadDocumentHash = semanticJsonHash(cadDocument);
  const profileHash = semanticJsonHash(profile);
  if (
    extraction.source.cadDocumentHash !== cadDocumentHash ||
    extraction.profileHash !== profileHash
  ) {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_HASH_MISMATCH",
      "Extraction input hashes do not match the worker semantic hashes",
    );
  }
  const architecturalExtractionHash = semanticJsonHash(extraction);
  const evidence: CadInterpretationEvidence = {
    evidenceVersion: "0.1.0",
    interpretationPolicyVersion: extraction.interpretationPolicyVersion,
    sourceHash: extraction.source.sourceHash,
    cadDocumentHash,
    profileId: extraction.profileId,
    profileHash,
    architecturalExtractionVersion: extraction.architecturalExtractionVersion,
    architecturalExtractionHash,
    summary: { ...extraction.summary },
    status: extraction.status,
  };
  const evidenceResult = validateCadInterpretationEvidence(evidence);
  if (!evidenceResult.ok) {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_EVIDENCE_INVALID",
      "Interpretation evidence does not satisfy cad-interpretation-evidence-v0.1",
      { errors: evidenceResult.errors },
    );
  }
  return { extraction, architecturalExtractionHash, evidence };
}

export interface InterpretCadFilesOptions {
  /** Trusted, caller-controlled root; both inputs must stay inside it. */
  repositoryRoot: string;
  /** Root-relative cad-document-v0.1 JSON (the 10A extraction artifact). */
  cadDocumentPath: string;
  /** Root-relative cad-interpretation-profile-v0.1 JSON. */
  profilePath: string;
}

export interface CadInterpretationFiles extends CadInterpretationResult {
  /** Execution metadata only; never part of any hashed artifact. */
  inputAbsolutePaths: string[];
}

function readJsonInput(root: string, relativePath: string, label: string) {
  if (extname(relativePath).toLowerCase() !== ".json") {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_INPUT_PATH_INVALID",
      `${label} must be a .json file`,
    );
  }
  let physicalPath: string;
  try {
    // Lexical AND physical (realpath) containment; final links never followed.
    physicalPath = resolveExistingFileWithinRoot(root, relativePath);
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadInterpretationWorkerError(
      error.reason === "NOT_FOUND"
        ? "CAD_INTERPRET_INPUT_NOT_FOUND"
        : "CAD_INTERPRET_INPUT_PATH_INVALID",
      `${label} path is missing or not contained in the trusted root`,
      { reason: error.reason },
    );
  }
  if (lstatSync(physicalPath).size > CAD_SOURCE_MAX_BYTES) {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_INPUT_PATH_INVALID",
      `${label} exceeds ${CAD_SOURCE_MAX_BYTES} bytes`,
    );
  }
  try {
    return { physicalPath, value: JSON.parse(readFileSync(physicalPath, "utf8")) as unknown };
  } catch {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_INPUT_JSON_INVALID",
      `${label} is not valid JSON`,
    );
  }
}

export function interpretCadFiles(options: InterpretCadFilesOptions): CadInterpretationFiles {
  const cadDocument = readJsonInput(
    options.repositoryRoot,
    options.cadDocumentPath,
    "CAD document",
  );
  const profile = readJsonInput(options.repositoryRoot, options.profilePath, "Profile");
  return {
    ...cadInterpretationEvidence(cadDocument.value, profile.value),
    inputAbsolutePaths: [cadDocument.physicalPath, profile.physicalPath],
  };
}

export interface CadInterpretationOutputPaths {
  extractionPath: string;
  evidencePath: string;
}

/**
 * Writes the extraction and its evidence under the worker-owned output
 * root, contained lexically and physically; both destinations are validated
 * before either write, and neither may overwrite an input.
 */
export function writeCadInterpretation(
  result: CadInterpretationFiles,
  outputRoot: string,
  outputPath: string,
): CadInterpretationOutputPaths {
  const lowered = outputPath.toLowerCase();
  if (!lowered.endsWith(".json") || lowered.endsWith(".evidence.json")) {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_OUTPUT_PATH_INVALID",
      "Output path must end in .json (and not .evidence.json)",
    );
  }
  let extractionPath: string;
  let evidencePath: string;
  try {
    extractionPath = resolveOutputPathWithinRoot(outputRoot, outputPath);
    evidencePath = resolveOutputPathWithinRoot(
      outputRoot,
      `${outputPath.slice(0, -".json".length)}.evidence.json`,
    );
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_OUTPUT_PATH_INVALID",
      "Output path must stay inside the worker output root, lexically and physically",
      { reason: error.reason },
    );
  }
  const inputs = new Set(result.inputAbsolutePaths.map((path) => resolve(path).toLowerCase()));
  if ([extractionPath, evidencePath].some((path) => inputs.has(resolve(path).toLowerCase()))) {
    throw new CadInterpretationWorkerError(
      "CAD_INTERPRET_OUTPUT_PATH_INVALID",
      "Output must not overwrite an input",
    );
  }
  writeDeterministicJson(extractionPath, result.extraction);
  writeDeterministicJson(evidencePath, result.evidence);
  return { extractionPath, evidencePath };
}
