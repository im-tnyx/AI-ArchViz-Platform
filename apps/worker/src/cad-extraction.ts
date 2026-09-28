import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
  CAD_SOURCE_MAX_BYTES,
  type CadDocument,
  CadSourceError,
  type CadSourceErrorCode,
  DxfSourceAdapter,
  validateCadDocument,
} from "@ai-archviz/cad-parser";
import {
  type CadExtractionEvidence,
  semanticJsonHash,
  validateCadExtractionEvidence,
} from "@ai-archviz/worker-contracts";
import {
  PathContainmentError,
  resolveExistingFileWithinRoot,
  resolveOutputPathWithinRoot,
} from "./paths.js";
import { writeDeterministicJson } from "./workspace.js";

/**
 * Technical Spike 10A worker boundary: trusted local DXF file -> pure
 * cad-parser -> schema-validated cad-document-v0.1 -> RFC 8785 semantic
 * document hash -> cad-extraction-evidence-v0.1. No DCC, no AI, no network,
 * no child process, and no SceneSpec output. Paths are execution metadata
 * only and never enter the document or evidence.
 */

export type CadExtractionErrorCode =
  | CadSourceErrorCode
  | "CAD_SOURCE_PATH_INVALID"
  | "CAD_SOURCE_NOT_FOUND"
  | "CAD_OUTPUT_PATH_INVALID"
  | "CAD_DOCUMENT_SCHEMA_INVALID"
  | "CAD_EXTRACTION_EVIDENCE_INVALID";

export class CadExtractionError extends Error {
  readonly code: CadExtractionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CadExtractionErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CadExtractionError";
    this.code = code;
    this.details = details;
  }
}

export interface CadExtractionResult {
  cadDocument: CadDocument;
  cadDocumentHash: string;
  evidence: CadExtractionEvidence;
}

/** Pure: builds and validates evidence for an already-validated document. */
export function cadExtractionEvidence(cadDocument: CadDocument): CadExtractionResult {
  const validated = validateCadDocument(cadDocument);
  if (!validated.ok) {
    throw new CadExtractionError(
      "CAD_DOCUMENT_SCHEMA_INVALID",
      "Normalized CAD document does not satisfy cad-document-v0.1",
      { errors: validated.errors },
    );
  }
  const cadDocumentHash = semanticJsonHash(cadDocument);
  const evidence: CadExtractionEvidence = {
    evidenceVersion: "0.1.0",
    sourceFormat: cadDocument.sourceFormat,
    sourceHash: cadDocument.sourceHash,
    cadDocumentVersion: cadDocument.cadDocumentVersion,
    cadDocumentHash,
    sourceUnits: { ...cadDocument.sourceUnits },
    canonicalUnits: cadDocument.canonicalUnits,
    summary: {
      ...cadDocument.summary,
      entityTypeCounts: { ...cadDocument.summary.entityTypeCounts },
    },
    status: "PASS",
  };
  const evidenceResult = validateCadExtractionEvidence(evidence);
  if (!evidenceResult.ok) {
    throw new CadExtractionError(
      "CAD_EXTRACTION_EVIDENCE_INVALID",
      "CAD extraction evidence does not satisfy cad-extraction-evidence-v0.1",
      { errors: evidenceResult.errors },
    );
  }
  return { cadDocument, cadDocumentHash, evidence };
}

/** Pure: extraction from already-loaded bytes (the adapter never sees a path). */
export function extractCadDocumentFromBytes(
  bytes: Uint8Array,
  options: { maxSourceBytes?: number } = {},
): CadExtractionResult {
  const adapter = new DxfSourceAdapter(
    options.maxSourceBytes === undefined ? {} : { maxSourceBytes: options.maxSourceBytes },
  );
  let cadDocument: CadDocument;
  try {
    cadDocument = adapter.parse({ bytes });
  } catch (error) {
    if (error instanceof CadSourceError) {
      throw new CadExtractionError(error.code, error.message, { ...error.details });
    }
    throw error;
  }
  return cadExtractionEvidence(cadDocument);
}

export interface ExtractCadDocumentOptions {
  /** Trusted, caller-controlled root; the source must stay inside it. */
  repositoryRoot: string;
  /** Root-relative path to an existing regular `.dxf` file. */
  sourcePath: string;
  maxSourceBytes?: number;
}

export interface CadExtraction extends CadExtractionResult {
  /** Execution metadata only; never part of the document or evidence. */
  sourceAbsolutePath: string;
}

export function extractCadDocument(options: ExtractCadDocumentOptions): CadExtraction {
  const maxSourceBytes = options.maxSourceBytes ?? CAD_SOURCE_MAX_BYTES;
  // Physical (realpath) location, validated immediately before the read.
  const sourceAbsolutePath = resolveSourcePath(options.repositoryRoot, options.sourcePath);
  const stats = lstatSync(sourceAbsolutePath);
  if (stats.size > maxSourceBytes) {
    // Checked before reading so an oversized file is never loaded.
    throw new CadExtractionError(
      "CAD_SOURCE_TOO_LARGE",
      `CAD source is ${stats.size} bytes; the limit is ${maxSourceBytes}`,
      { byteLength: stats.size, maxSourceBytes },
    );
  }
  const bytes = new Uint8Array(readFileSync(sourceAbsolutePath));
  return { ...extractCadDocumentFromBytes(bytes, { maxSourceBytes }), sourceAbsolutePath };
}

const SOURCE_PATH_MESSAGES: Record<string, string> = {
  LEXICAL_ESCAPE: "CAD source path must be non-empty, relative, and inside the trusted root",
  NOT_REGULAR_FILE: "CAD source must be a regular file (a final link is never followed)",
  BROKEN_LINK_TRAVERSAL: "CAD source path traverses a link whose target does not resolve",
  PHYSICAL_ESCAPE: "CAD source resolves outside the trusted root through a link or junction",
  UNRESOLVABLE: "CAD source path cannot be resolved on the filesystem",
};

/**
 * Lexical AND physical containment: the caller path must stay inside the
 * trusted root as written, and its filesystem realpath must stay inside the
 * root's realpath (no parent symlink/junction escape). Returns the physical
 * path to read from.
 */
function resolveSourcePath(root: string, sourcePath: string): string {
  if (extname(sourcePath).toLowerCase() !== ".dxf") {
    throw new CadExtractionError("CAD_SOURCE_PATH_INVALID", "CAD source must be a .dxf file");
  }
  try {
    return resolveExistingFileWithinRoot(root, sourcePath);
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    if (error.reason === "NOT_FOUND") {
      throw new CadExtractionError("CAD_SOURCE_NOT_FOUND", "CAD source file does not exist");
    }
    throw new CadExtractionError(
      "CAD_SOURCE_PATH_INVALID",
      SOURCE_PATH_MESSAGES[error.reason] ?? "CAD source path is invalid",
      { reason: error.reason },
    );
  }
}

export interface CadExtractionOutputPaths {
  documentPath: string;
  evidencePath: string;
}

/**
 * Writes the document and its evidence under the worker-owned output root.
 * The output path is root-relative, must end in `.json`, and may never
 * escape the root (lexically, or physically through an existing
 * symlink/junction ancestor) or overwrite the source.
 */
export function writeCadExtraction(
  extraction: CadExtraction,
  outputRoot: string,
  outputPath: string,
): CadExtractionOutputPaths {
  const lowered = outputPath.toLowerCase();
  if (!lowered.endsWith(".json") || lowered.endsWith(".evidence.json")) {
    throw new CadExtractionError(
      "CAD_OUTPUT_PATH_INVALID",
      "CAD output path must end in .json (and not .evidence.json)",
    );
  }
  // Both destinations are validated (lexically and physically) before either
  // is written, so an escaping path never produces a partial write.
  let documentPath: string;
  let evidencePath: string;
  try {
    documentPath = resolveOutputPathWithinRoot(outputRoot, outputPath);
    evidencePath = resolveOutputPathWithinRoot(
      outputRoot,
      `${outputPath.slice(0, -".json".length)}.evidence.json`,
    );
  } catch (error) {
    if (!(error instanceof PathContainmentError)) throw error;
    throw new CadExtractionError(
      "CAD_OUTPUT_PATH_INVALID",
      "CAD output path must stay inside the worker output root, lexically and physically",
      { reason: error.reason },
    );
  }
  const source = resolve(extraction.sourceAbsolutePath).toLowerCase();
  if ([documentPath, evidencePath].some((path) => resolve(path).toLowerCase() === source)) {
    throw new CadExtractionError("CAD_OUTPUT_PATH_INVALID", "CAD output must not overwrite source");
  }
  writeDeterministicJson(documentPath, extraction.cadDocument);
  writeDeterministicJson(evidencePath, extraction.evidence);
  return { documentPath, evidencePath };
}
