import {
  CAD_DOCUMENT_VERSION,
  type CadBlock,
  type CadDocument,
  type CadEntity,
  type CadHeader,
  type CadLayer,
  type CadSourceFormat,
  type CadSourceUnits,
  type CadUnsupportedEntity,
} from "./types.js";

/** Unicode code-point lexical order (not UTF-16 code-unit order, not locale). */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftPoints[index] as number) - (rightPoints[index] as number);
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export interface CadDocumentParts {
  sourceFormat: CadSourceFormat;
  sourceHash: string;
  header: CadHeader;
  sourceUnits: CadSourceUnits;
  layers: CadLayer[];
  blocks: CadBlock[];
  entities: CadEntity[];
  unsupportedEntities: CadUnsupportedEntity[];
}

/**
 * Format-independent final normalization shared by every source adapter:
 * layers and blocks sorted by name (code-point order, independent of source
 * table order), entities kept in source order, deterministic summary counts.
 * No architectural meaning is derived here.
 */
export function assembleCadDocument(parts: CadDocumentParts): CadDocument {
  const byName = (left: { name: string }, right: { name: string }) =>
    compareCodePoints(left.name, right.name);
  const bySourceOrdinal = (left: { sourceOrdinal: number }, right: { sourceOrdinal: number }) =>
    left.sourceOrdinal - right.sourceOrdinal;
  const layers = [...parts.layers].sort(byName);
  const blocks = [...parts.blocks].sort(byName);
  const entities = [...parts.entities].sort(bySourceOrdinal);
  const unsupportedEntities = [...parts.unsupportedEntities].sort(bySourceOrdinal);

  const typeCounts = new Map<string, number>();
  for (const { type } of [...entities, ...unsupportedEntities]) {
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  const entityTypeCounts: Record<string, number> = {};
  for (const type of [...typeCounts.keys()].sort(compareCodePoints)) {
    entityTypeCounts[type] = typeCounts.get(type) as number;
  }

  return {
    cadDocumentVersion: CAD_DOCUMENT_VERSION,
    sourceFormat: parts.sourceFormat,
    sourceHash: parts.sourceHash,
    header: { ...parts.header },
    sourceUnits: { ...parts.sourceUnits },
    canonicalUnits: "millimeters",
    layers,
    blocks,
    entities,
    unsupportedEntities,
    summary: {
      layerCount: layers.length,
      blockCount: blocks.length,
      entityCount: entities.length + unsupportedEntities.length,
      supportedEntityCount: entities.length,
      unsupportedEntityCount: unsupportedEntities.length,
      entityTypeCounts,
    },
  };
}
