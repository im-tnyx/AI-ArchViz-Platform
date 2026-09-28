/**
 * cad-document-v0.1: normalized, deterministic SOURCE EVIDENCE extracted from
 * a CAD file. It is not SceneSpec and never contains inferred architecture
 * (walls, rooms, doors, windows). Every length is in millimeters; the source
 * file path never appears anywhere in it.
 */

export const CAD_DOCUMENT_VERSION = "0.1.0";

export type CadSourceFormat = "dxf";

export type CadPoint3 = [number, number, number];

export type CadUnitName = "inches" | "feet" | "millimeters" | "centimeters" | "meters";

export interface CadSourceUnits {
  insunitsCode: number;
  name: CadUnitName;
  scaleToMillimeters: number;
}

export interface CadHeader {
  /** Raw `$ACADVER` value, or null when the source does not declare it. */
  acadVersion: string | null;
  /** Raw `$INSUNITS` value (the v0.1 unit authority). */
  insunitsCode: number;
  /** Raw `$DWGCODEPAGE` value, or null when the source does not declare it. */
  dwgCodePage: string | null;
}

export interface CadLayer {
  name: string;
  colorIndex: number | null;
  lineType: string | null;
  flags: number | null;
}

export interface CadBlock {
  name: string;
  flags: number | null;
  basePoint: CadPoint3;
  /** True when the block is an XREF/overlay. Its path is never recorded or followed. */
  externalReference: boolean;
  /** Entity records inside the definition; never expanded. */
  entityCount: number;
}

interface CadEntityBase {
  /** Zero-based position in the source ENTITIES sequence (provenance, not identity). */
  sourceOrdinal: number;
  /** Raw DXF handle (group 5) when present. Provenance only; never a SceneSpec ID. */
  sourceHandle: string | null;
  layer: string;
}

export interface CadLineEntity extends CadEntityBase {
  type: "LINE";
  start: CadPoint3;
  end: CadPoint3;
}

export interface CadLwPolylineVertex {
  x: number;
  y: number;
  /** Dimensionless arc bulge (tan(theta/4)); 0 is a straight segment. Never flattened. */
  bulge: number;
}

export interface CadLwPolylineEntity extends CadEntityBase {
  type: "LWPOLYLINE";
  closed: boolean;
  flags: number;
  /** Shared Z of every vertex (group 38), in millimeters. */
  elevation: number;
  vertices: CadLwPolylineVertex[];
}

export interface CadInsertEntity extends CadEntityBase {
  type: "INSERT";
  blockName: string;
  insertionPoint: CadPoint3;
  /** Dimensionless X/Y/Z scale factors. */
  scale: CadPoint3;
  rotationDegrees: number;
  hasAttributes: boolean;
}

export interface CadTextEntity extends CadEntityBase {
  type: "TEXT";
  /** Inert source text; never interpreted or evaluated. */
  text: string;
  insertionPoint: CadPoint3;
  alignmentPoint: CadPoint3 | null;
  height: number | null;
  rotationDegrees: number;
  horizontalJustification: number;
  verticalJustification: number;
}

export type CadEntity = CadLineEntity | CadLwPolylineEntity | CadInsertEntity | CadTextEntity;

export type CadSupportedEntityType = CadEntity["type"];

export type CadUnsupportedReason =
  | "UNSUPPORTED_ENTITY_TYPE"
  | "UNSUPPORTED_OCS_EXTRUSION"
  | "UNSUPPORTED_INSERT_ARRAY";

export interface CadUnsupportedEntity {
  sourceOrdinal: number;
  sourceHandle: string | null;
  type: string;
  layer: string;
  reason: CadUnsupportedReason;
}

export interface CadDocumentSummary {
  layerCount: number;
  blockCount: number;
  entityCount: number;
  supportedEntityCount: number;
  unsupportedEntityCount: number;
  /** Every source entity type (supported or not), keys in code-point order. */
  entityTypeCounts: Record<string, number>;
}

export interface CadDocument {
  cadDocumentVersion: typeof CAD_DOCUMENT_VERSION;
  sourceFormat: CadSourceFormat;
  /** `sha256:` + lowercase hex of the raw source BYTES (not a semantic hash). */
  sourceHash: string;
  header: CadHeader;
  sourceUnits: CadSourceUnits;
  canonicalUnits: "millimeters";
  layers: CadLayer[];
  blocks: CadBlock[];
  entities: CadEntity[];
  unsupportedEntities: CadUnsupportedEntity[];
  summary: CadDocumentSummary;
}

export type CadSourceErrorCode =
  | "CAD_SOURCE_TOO_LARGE"
  | "CAD_BINARY_DXF_UNSUPPORTED"
  | "CAD_DXF_PARSE_FAILED"
  | "CAD_NUMERIC_NON_FINITE"
  | "CAD_UNITS_UNSPECIFIED"
  | "CAD_UNITS_UNSUPPORTED";

export class CadSourceError extends Error {
  readonly code: CadSourceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CadSourceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CadSourceError";
    this.code = code;
    this.details = details;
  }
}

/** Already-loaded source bytes. Adapters never receive or read a path. */
export interface CadSourceInput {
  bytes: Uint8Array;
}

/**
 * The trusted source-adapter boundary. Any future adapter (e.g. DWG) must
 * produce the same cad-document contract; downstream code never sees a
 * parser- or format-specific object shape.
 */
export interface CadSourceAdapter {
  readonly sourceFormat: CadSourceFormat;
  parse(input: CadSourceInput): CadDocument;
}
