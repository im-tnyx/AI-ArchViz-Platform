import { createHash } from "node:crypto";
import { assembleCadDocument, compareCodePoints } from "./normalize.js";
import {
  type CadBlock,
  type CadDocument,
  type CadEntity,
  type CadHeader,
  type CadLayer,
  type CadLwPolylineVertex,
  type CadPoint3,
  type CadSourceAdapter,
  CadSourceError,
  type CadSourceInput,
  type CadSourceUnits,
  type CadUnsupportedEntity,
  type CadUnsupportedReason,
} from "./types.js";
import { resolveSourceUnits, toMillimeters } from "./units.js";

/**
 * Project-owned ASCII DXF adapter. An ASCII DXF file is a flat sequence of
 * (group code, value) line pairs; this module is the only place that knows
 * that shape. Its raw pair/record structures never leave this file — every
 * caller receives only the cad-document-v0.1 contract.
 *
 * Deliberately NOT supported: binary DXF, DWG, block explosion, XREF/image/
 * font loading, MTEXT, DIMENSION interpretation, and any architectural
 * inference. Every value is inert data.
 */

/** Hard pre-parse limit: 10 MiB. Callers may only lower it. */
export const CAD_SOURCE_MAX_BYTES = 10 * 1024 * 1024;

const BINARY_DXF_SENTINEL = [..."AutoCAD Binary DXF"].map((character) => character.charCodeAt(0));
const DECIMAL_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INTEGER_PATTERN = /^[+-]?\d+$/;
const GROUP_CODE_PATTERN = /^-?\d{1,4}$/;
const COMMENT_GROUP_CODE = 999;

interface DxfPair {
  code: number;
  value: string;
  /** 1-based line of the group-code line (diagnostics only). */
  line: number;
}

interface DxfRecord {
  type: string;
  pairs: DxfPair[];
  line: number;
}

interface DxfSection {
  pairs: DxfPair[];
  body: DxfRecord[];
}

function parseFailure(message: string, details: Record<string, unknown> = {}): never {
  throw new CadSourceError("CAD_DXF_PARSE_FAILED", message, details);
}

export interface DxfSourceAdapterOptions {
  /** Lower the pre-parse byte limit (never above CAD_SOURCE_MAX_BYTES). */
  maxSourceBytes?: number;
}

export class DxfSourceAdapter implements CadSourceAdapter {
  readonly sourceFormat = "dxf" as const;
  readonly maxSourceBytes: number;

  constructor(options: DxfSourceAdapterOptions = {}) {
    const limit = options.maxSourceBytes ?? CAD_SOURCE_MAX_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CAD_SOURCE_MAX_BYTES) {
      throw new RangeError(`maxSourceBytes must be an integer in [1, ${CAD_SOURCE_MAX_BYTES}]`);
    }
    this.maxSourceBytes = limit;
  }

  parse(input: CadSourceInput): CadDocument {
    const { bytes } = input;
    // Pre-parse safety gates run before hashing, decoding, or tokenizing.
    if (bytes.byteLength > this.maxSourceBytes) {
      throw new CadSourceError(
        "CAD_SOURCE_TOO_LARGE",
        `CAD source is ${bytes.byteLength} bytes; the limit is ${this.maxSourceBytes}`,
        { byteLength: bytes.byteLength, maxSourceBytes: this.maxSourceBytes },
      );
    }
    if (isBinaryDxf(bytes)) {
      throw new CadSourceError(
        "CAD_BINARY_DXF_UNSUPPORTED",
        "Binary DXF (or non-text content) is not supported; only ASCII/text DXF is accepted",
      );
    }

    const sourceHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const sections = readSections(groupRecords(readPairs(decodeText(bytes))));

    const headerVariables = readHeaderVariables(sections.get("HEADER"));
    const header: CadHeader = {
      acadVersion: headerString(headerVariables, "$ACADVER", 1),
      insunitsCode: 0,
      dwgCodePage: headerString(headerVariables, "$DWGCODEPAGE", 3),
    };
    const sourceUnits = resolveSourceUnits(headerInteger(headerVariables, "$INSUNITS", 70));
    header.insunitsCode = sourceUnits.insunitsCode;

    const layers = readLayers(sections.get("TABLES")?.body ?? []);
    const blocks = readBlocks(sections.get("BLOCKS")?.body ?? [], sourceUnits);
    const entities: CadEntity[] = [];
    const unsupportedEntities: CadUnsupportedEntity[] = [];
    for (const [sourceOrdinal, record] of (sections.get("ENTITIES")?.body ?? []).entries()) {
      const result = readEntity(record, sourceOrdinal, sourceUnits);
      if ("reason" in result) unsupportedEntities.push(result);
      else entities.push(result);
    }

    return assembleCadDocument({
      sourceFormat: "dxf",
      sourceHash,
      header,
      sourceUnits,
      layers,
      blocks,
      entities,
      unsupportedEntities,
    });
  }
}

function isBinaryDxf(bytes: Uint8Array): boolean {
  if (
    bytes.byteLength >= BINARY_DXF_SENTINEL.length &&
    BINARY_DXF_SENTINEL.every((byte, index) => bytes[index] === byte)
  ) {
    return true;
  }
  // A NUL byte never appears in a text DXF.
  return bytes.indexOf(0) !== -1;
}

function decodeText(bytes: Uint8Array): string {
  try {
    // Fatal UTF-8 decoding (a leading BOM is stripped). Legacy code-page
    // bytes are rejected rather than guessed.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return parseFailure("DXF source is not valid UTF-8 text");
  }
}

function readPairs(text: string): DxfPair[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length % 2 !== 0) {
    parseFailure("DXF group-code/value pairs are truncated", { lineCount: lines.length });
  }
  const pairs: DxfPair[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const codeText = (lines[index] as string).trim();
    if (!GROUP_CODE_PATTERN.test(codeText)) {
      parseFailure(`Invalid DXF group code at line ${index + 1}`, { line: index + 1 });
    }
    const code = Number(codeText);
    if (code === COMMENT_GROUP_CODE) continue;
    pairs.push({ code, value: lines[index + 1] as string, line: index + 1 });
  }
  return pairs;
}

function groupRecords(pairs: DxfPair[]): DxfRecord[] {
  const records: DxfRecord[] = [];
  for (const pair of pairs) {
    if (pair.code === 0) {
      records.push({ type: pair.value.trim(), pairs: [], line: pair.line });
      continue;
    }
    const current = records.at(-1);
    if (!current) parseFailure("DXF source must start with a group code 0 record");
    current.pairs.push(pair);
  }
  return records;
}

const EXTRACTED_SECTIONS = new Set(["HEADER", "TABLES", "BLOCKS", "ENTITIES"]);

function readSections(records: DxfRecord[]): Map<string, DxfSection> {
  const sections = new Map<string, DxfSection>();
  const seen = new Set<string>();
  let index = 0;
  for (;;) {
    const record = records[index];
    if (!record) parseFailure("DXF source is missing the EOF record");
    if (record.type === "EOF") {
      if (index !== records.length - 1) parseFailure("DXF source has records after EOF");
      break;
    }
    if (record.type !== "SECTION") {
      parseFailure(`Expected SECTION at line ${record.line}, found ${record.type}`);
    }
    const namePair = record.pairs[0];
    if (namePair?.code !== 2) {
      parseFailure(`SECTION at line ${record.line} has no name`);
    }
    const name = namePair.value.trim();
    if (seen.has(name)) parseFailure(`Duplicate DXF section ${name}`);
    seen.add(name);
    const body: DxfRecord[] = [];
    index += 1;
    for (;;) {
      const inner = records[index];
      if (!inner || inner.type === "SECTION" || inner.type === "EOF") {
        parseFailure(`DXF section ${name} is not terminated by ENDSEC`);
      }
      if (inner.type === "ENDSEC") break;
      body.push(inner);
      index += 1;
    }
    index += 1;
    if (EXTRACTED_SECTIONS.has(name)) sections.set(name, { pairs: record.pairs.slice(1), body });
  }
  return sections;
}

function readHeaderVariables(section: DxfSection | undefined): Map<string, DxfPair[]> {
  const variables = new Map<string, DxfPair[]>();
  if (!section) return variables;
  if (section.body.length > 0) parseFailure("HEADER section contains unexpected records");
  let current: DxfPair[] | null = null;
  for (const pair of section.pairs) {
    if (pair.code === 9) {
      const name = pair.value.trim();
      if (variables.has(name)) parseFailure(`Duplicate header variable ${name}`);
      current = [];
      variables.set(name, current);
      continue;
    }
    if (!current) parseFailure(`HEADER value at line ${pair.line} precedes any variable name`);
    current.push(pair);
  }
  return variables;
}

function headerPair(variables: Map<string, DxfPair[]>, name: string, code: number): DxfPair | null {
  const pairs = variables.get(name);
  if (!pairs) return null;
  const [pair] = pairs;
  if (pairs.length !== 1 || !pair || pair.code !== code) {
    parseFailure(`Header variable ${name} must be exactly one group ${code} value`);
  }
  return pair;
}

function headerString(variables: Map<string, DxfPair[]>, name: string, code: number) {
  return headerPair(variables, name, code)?.value ?? null;
}

function headerInteger(variables: Map<string, DxfPair[]>, name: string, code: number) {
  const pair = headerPair(variables, name, code);
  return pair ? parseInteger(pair, name) : null;
}

function parseReal(pair: DxfPair, context: string): number {
  const text = pair.value.trim();
  if (!DECIMAL_PATTERN.test(text)) {
    parseFailure(`${context} at line ${pair.line + 1} is not a decimal number`);
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new CadSourceError(
      "CAD_NUMERIC_NON_FINITE",
      `${context} at line ${pair.line + 1} is not a finite number`,
      { context, line: pair.line + 1 },
    );
  }
  return value === 0 ? 0 : value;
}

function parseInteger(pair: DxfPair, context: string): number {
  const text = pair.value.trim();
  const value = Number(text);
  if (!INTEGER_PATTERN.test(text) || !Number.isSafeInteger(value)) {
    parseFailure(`${context} at line ${pair.line + 1} is not an integer`);
  }
  return value === 0 ? 0 : value;
}

/** Pairs of a record, excluding 102 "{application ... }" groups. */
function contentPairs(record: DxfRecord): DxfPair[] {
  const pairs: DxfPair[] = [];
  let inApplicationGroup = false;
  for (const pair of record.pairs) {
    if (pair.code === 102) {
      const value = pair.value.trim();
      if (value.startsWith("{")) {
        if (inApplicationGroup) parseFailure(`Nested 102 group at line ${pair.line}`);
        inApplicationGroup = true;
      } else if (value === "}") {
        if (!inApplicationGroup) parseFailure(`Unbalanced 102 group at line ${pair.line}`);
        inApplicationGroup = false;
      }
      continue;
    }
    if (!inApplicationGroup) pairs.push(pair);
  }
  if (inApplicationGroup) parseFailure(`Unterminated 102 group in ${record.type}`);
  return pairs;
}

/** Strict single-occurrence field access over one record's content pairs. */
class RecordFields {
  private readonly byCode = new Map<number, DxfPair[]>();

  constructor(
    readonly record: DxfRecord,
    readonly pairs: DxfPair[] = contentPairs(record),
  ) {
    for (const pair of pairs) {
      const list = this.byCode.get(pair.code);
      if (list) list.push(pair);
      else this.byCode.set(pair.code, [pair]);
    }
  }

  private context(code: number): string {
    return `${this.record.type} (line ${this.record.line}) group ${code}`;
  }

  optional(code: number): DxfPair | null {
    const list = this.byCode.get(code);
    if (!list) return null;
    if (list.length !== 1) parseFailure(`${this.context(code)} occurs more than once`);
    return list[0] as DxfPair;
  }

  required(code: number): DxfPair {
    const pair = this.optional(code);
    if (!pair) parseFailure(`${this.context(code)} is required`);
    return pair;
  }

  string(code: number): string {
    return this.required(code).value;
  }

  optionalString(code: number): string | null {
    return this.optional(code)?.value ?? null;
  }

  nonEmptyString(code: number): string {
    const value = this.string(code);
    if (value.length === 0) parseFailure(`${this.context(code)} must not be empty`);
    return value;
  }

  real(code: number): number {
    return parseReal(this.required(code), this.context(code));
  }

  optionalReal(code: number, defaultValue: number): number {
    const pair = this.optional(code);
    return pair ? parseReal(pair, this.context(code)) : defaultValue;
  }

  optionalInteger(code: number): number | null {
    const pair = this.optional(code);
    return pair ? parseInteger(pair, this.context(code)) : null;
  }

  /** A point from groups (c, c+10, c+20); Z defaults to 0 as defined by DXF. */
  point(xCode: number, units: CadSourceUnits): CadPoint3 {
    const context = `${this.record.type} (line ${this.record.line}) point ${xCode}`;
    return [
      toMillimeters(this.real(xCode), units, context),
      toMillimeters(this.real(xCode + 10), units, context),
      toMillimeters(this.optionalReal(xCode + 20, 0), units, context),
    ];
  }

  optionalPoint(xCode: number, units: CadSourceUnits): CadPoint3 | null {
    if (!this.optional(xCode) && !this.optional(xCode + 10)) return null;
    return this.point(xCode, units);
  }

  /** OCS == WCS only for the default (0,0,1) extrusion; anything else is unsupported. */
  hasDefaultExtrusion(): boolean {
    return (
      this.optionalReal(210, 0) === 0 &&
      this.optionalReal(220, 0) === 0 &&
      this.optionalReal(230, 1) === 1
    );
  }
}

function readLayers(records: DxfRecord[]): CadLayer[] {
  const layers: CadLayer[] = [];
  let sawLayerTable = false;
  let index = 0;
  while (index < records.length) {
    const table = records[index] as DxfRecord;
    if (table.type !== "TABLE") parseFailure(`Expected TABLE at line ${table.line}`);
    const tableName = table.pairs.find((pair) => pair.code === 2)?.value.trim();
    if (!tableName) parseFailure(`TABLE at line ${table.line} has no name`);
    index += 1;
    for (;;) {
      const entry = records[index];
      if (!entry || entry.type === "TABLE") {
        parseFailure(`TABLE ${tableName} is not terminated by ENDTAB`);
      }
      index += 1;
      if (entry.type === "ENDTAB") break;
      if (tableName !== "LAYER") continue;
      if (entry.type !== "LAYER") parseFailure(`Unexpected ${entry.type} in LAYER table`);
      const fields = new RecordFields(entry);
      layers.push({
        name: fields.nonEmptyString(2),
        colorIndex: fields.optionalInteger(62),
        lineType: fields.optionalString(6),
        flags: fields.optionalInteger(70),
      });
    }
    if (tableName === "LAYER") {
      if (sawLayerTable) parseFailure("Duplicate LAYER table");
      sawLayerTable = true;
    }
  }
  assertUniqueNames(layers, "layer");
  return layers;
}

function readBlocks(records: DxfRecord[], units: CadSourceUnits): CadBlock[] {
  const blocks: CadBlock[] = [];
  let index = 0;
  while (index < records.length) {
    const block = records[index] as DxfRecord;
    if (block.type !== "BLOCK") parseFailure(`Expected BLOCK at line ${block.line}`);
    const fields = new RecordFields(block);
    const flags = fields.optionalInteger(70);
    let entityCount = 0;
    index += 1;
    for (;;) {
      const inner = records[index];
      if (!inner || inner.type === "BLOCK") {
        parseFailure(`BLOCK at line ${block.line} is not terminated by ENDBLK`);
      }
      index += 1;
      if (inner.type === "ENDBLK") break;
      entityCount += 1;
    }
    blocks.push({
      name: fields.nonEmptyString(2),
      flags,
      basePoint: fields.point(10, units),
      // Flag 4 = XREF, 8 = XREF overlay. The referenced path is never
      // recorded (it may be machine-specific) and never followed.
      externalReference: flags !== null && (flags & 12) !== 0,
      entityCount,
    });
  }
  assertUniqueNames(blocks, "block");
  return blocks;
}

function assertUniqueNames(items: readonly { name: string }[], kind: string): void {
  const names = items.map((item) => item.name).sort(compareCodePoints);
  for (let index = 1; index < names.length; index += 1) {
    if (names[index] === names[index - 1]) parseFailure(`Duplicate ${kind} name ${names[index]}`);
  }
}

function readEntity(
  record: DxfRecord,
  sourceOrdinal: number,
  units: CadSourceUnits,
): CadEntity | CadUnsupportedEntity {
  const fields = new RecordFields(record);
  const common = {
    sourceOrdinal,
    sourceHandle: fields.optionalString(5),
    layer: fields.nonEmptyString(8),
  };
  const unsupported = (reason: CadUnsupportedReason): CadUnsupportedEntity => ({
    ...common,
    type: record.type,
    reason,
  });

  switch (record.type) {
    case "LINE":
      // LINE endpoints are WCS regardless of extrusion.
      return {
        ...common,
        type: "LINE",
        start: fields.point(10, units),
        end: fields.point(11, units),
      };
    case "LWPOLYLINE": {
      if (!fields.hasDefaultExtrusion()) return unsupported("UNSUPPORTED_OCS_EXTRUSION");
      const flags = fields.optionalInteger(70) ?? 0;
      const context = `LWPOLYLINE (line ${record.line})`;
      return {
        ...common,
        type: "LWPOLYLINE",
        closed: (flags & 1) === 1,
        flags,
        elevation: toMillimeters(fields.optionalReal(38, 0), units, context),
        vertices: readLwPolylineVertices(fields, units),
      };
    }
    case "INSERT": {
      if (!fields.hasDefaultExtrusion()) return unsupported("UNSUPPORTED_OCS_EXTRUSION");
      const columns = fields.optionalInteger(70) ?? 1;
      const rows = fields.optionalInteger(71) ?? 1;
      if (columns !== 1 || rows !== 1) return unsupported("UNSUPPORTED_INSERT_ARRAY");
      return {
        ...common,
        type: "INSERT",
        blockName: fields.nonEmptyString(2),
        insertionPoint: fields.point(10, units),
        scale: [fields.optionalReal(41, 1), fields.optionalReal(42, 1), fields.optionalReal(43, 1)],
        rotationDegrees: fields.optionalReal(50, 0),
        hasAttributes: fields.optionalInteger(66) === 1,
      };
    }
    case "TEXT": {
      if (!fields.hasDefaultExtrusion()) return unsupported("UNSUPPORTED_OCS_EXTRUSION");
      const heightPair = fields.optional(40);
      return {
        ...common,
        type: "TEXT",
        text: fields.string(1),
        insertionPoint: fields.point(10, units),
        alignmentPoint: fields.optionalPoint(11, units),
        height: heightPair
          ? toMillimeters(parseReal(heightPair, "TEXT height"), units, "TEXT height")
          : null,
        rotationDegrees: fields.optionalReal(50, 0),
        horizontalJustification: fields.optionalInteger(72) ?? 0,
        verticalJustification: fields.optionalInteger(73) ?? 0,
      };
    }
    default:
      // MTEXT, DIMENSION, HATCH, ARC, CIRCLE, POLYLINE/VERTEX/SEQEND,
      // ATTRIB, IMAGE, ... are recorded, never dropped and never interpreted.
      return unsupported("UNSUPPORTED_ENTITY_TYPE");
  }
}

function readLwPolylineVertices(fields: RecordFields, units: CadSourceUnits) {
  const context = `LWPOLYLINE (line ${fields.record.line})`;
  const declaredCount = parseInteger(fields.required(90), `${context} vertex count`);
  const vertices: CadLwPolylineVertex[] = [];
  let current: { x: number; y: number | null; bulge: number | null } | null = null;
  const finish = () => {
    if (!current) return;
    if (current.y === null) parseFailure(`${context} vertex ${vertices.length} is missing Y`);
    vertices.push({
      x: toMillimeters(current.x, units, context),
      y: toMillimeters(current.y, units, context),
      bulge: current.bulge ?? 0,
    });
  };
  for (const pair of fields.pairs) {
    if (pair.code === 10) {
      finish();
      current = { x: parseReal(pair, `${context} vertex X`), y: null, bulge: null };
      continue;
    }
    if (pair.code !== 20 && pair.code !== 42) continue;
    if (!current) parseFailure(`${context} group ${pair.code} precedes the first vertex`);
    if (pair.code === 20) {
      if (current.y !== null) parseFailure(`${context} vertex has more than one Y`);
      current.y = parseReal(pair, `${context} vertex Y`);
    } else {
      if (current.bulge !== null) parseFailure(`${context} vertex has more than one bulge`);
      // Bulge is dimensionless and is never scaled or flattened.
      current.bulge = parseReal(pair, `${context} vertex bulge`);
    }
  }
  finish();
  if (vertices.length !== declaredCount) {
    parseFailure(`${context} declares ${declaredCount} vertices but has ${vertices.length}`);
  }
  return vertices;
}
