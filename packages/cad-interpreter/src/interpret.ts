import { createHash } from "node:crypto";
import {
  type CadDocument,
  type CadEntity,
  type CadInsertEntity,
  type CadLwPolylineEntity,
  type CadTextEntity,
  type CadUnsupportedEntity,
  validateCadDocument,
} from "@ai-archviz/cad-parser";
import { canonicalize } from "json-canonicalize";
import {
  isOnBoundary,
  isStrictlyInside,
  polygonDefect,
  polygonsOverlap,
  projectOntoSegment,
  signedArea,
} from "./geometry.js";
import { validateCadInterpretationProfile } from "./profile.js";
import {
  ARCHITECTURAL_EXTRACTION_VERSION,
  type ArchitecturalExtraction,
  CAD_INTERPRET_HOST_TOLERANCE_MM,
  CAD_INTERPRETATION_POLICY_VERSION,
  CadInterpretationError,
  type CadInterpretationErrorCode,
  type CadInterpretationProfile,
  type CadProvenance,
  type CadSourceRole,
  type DerivedProvenance,
  type DoorRule,
  CAD_INTERPRET_EPSILON_MM as EPSILON,
  type OpeningCandidate,
  type Point2,
  type ProfileProvenance,
  type SpaceCandidate,
  type SpaceLabelRule,
  type UnconsumedEntity,
  type WallCandidate,
  type WindowRule,
} from "./types.js";

/*
 * cad-interpretation-policy-v0.1. Pass order (and therefore error
 * precedence) is fixed:
 *   1. validate cad-document-v0.1 and the profile
 *   2. classify every source entity in sourceOrdinal order (mapped-layer
 *      unsupported entities and role/type mismatches fail closed)
 *   3. space boundaries (curved, open, elevation, simple-polygon checks),
 *      CCW normalization, then pairwise overlap
 *   4. space labels (exact text mapping, strictly-inside ownership)
 *   5. walls from normalized boundary edges
 *   6. openings (block, XREF, rule, scale, unique host, offset)
 * The profile supplies meaning; CAD supplies geometry; this policy only
 * derives. Nothing is guessed from layer names, text, or block graphics.
 */

type Role = keyof CadInterpretationProfile["layers"];

const EXPECTED_TYPE: Record<Role, CadEntity["type"]> = {
  spaceBoundary: "LWPOLYLINE",
  spaceLabel: "TEXT",
  door: "INSERT",
  window: "INSERT",
};

function fail(
  code: CadInterpretationErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new CadInterpretationError(code, message, details);
}

/** RFC 8785 canonical JSON SHA-256 (same algorithm as worker-contracts semanticJsonHash). */
export function semanticHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

const pad4 = (value: number) => String(value).padStart(4, "0");

function cad(
  entity: { sourceOrdinal: number; sourceHandle: string | null },
  role: CadSourceRole,
): CadProvenance {
  return {
    authority: "cad",
    sourceOrdinal: entity.sourceOrdinal,
    sourceHandle: entity.sourceHandle,
    role,
  };
}

function fromProfile(field: string, ruleId: string | null = null): ProfileProvenance {
  return { authority: "profile", field, ruleId };
}

function derived(derivation: string): DerivedProvenance {
  return { authority: "derived", derivation };
}

type SourceRecord =
  | { kind: "supported"; entity: CadEntity }
  | { kind: "unsupported"; entity: CadUnsupportedEntity };

interface ParsedSpace {
  candidateId: string;
  boundaryEntity: CadLwPolylineEntity;
  boundary: Point2[];
  sourceWinding: SpaceCandidate["sourceWinding"];
}

export function interpretCadDocument(
  cadDocumentInput: unknown,
  profileInput: unknown,
): ArchitecturalExtraction {
  // 1. Inputs must satisfy their contracts before anything is interpreted.
  const cadResult = validateCadDocument(cadDocumentInput);
  if (!cadResult.ok) {
    fail("CAD_INTERPRET_CAD_DOCUMENT_INVALID", "Input is not a valid cad-document-v0.1", {
      errors: cadResult.errors,
    });
  }
  const profileResult = validateCadInterpretationProfile(profileInput);
  if (!profileResult.ok) {
    fail("CAD_INTERPRET_PROFILE_INVALID", "Input is not a valid cad-interpretation-profile-v0.1", {
      errors: profileResult.errors,
    });
  }
  const cadDocument: CadDocument = cadResult.value;
  const profile = profileResult.value;
  const level = profile.level;

  // 2. Classify every source entity; nothing disappears.
  const roleByLayer = new Map<string, Role>(
    (Object.entries(profile.layers) as [Role, string][]).map(([role, layer]) => [layer, role]),
  );
  const records: SourceRecord[] = [
    ...cadDocument.entities.map((entity): SourceRecord => ({ kind: "supported", entity })),
    ...cadDocument.unsupportedEntities.map(
      (entity): SourceRecord => ({ kind: "unsupported", entity }),
    ),
  ].sort((left, right) => left.entity.sourceOrdinal - right.entity.sourceOrdinal);

  const boundaryEntities: CadLwPolylineEntity[] = [];
  const labelEntities: CadTextEntity[] = [];
  const insertEntities: { entity: CadInsertEntity; role: "door" | "window" }[] = [];
  const unconsumedEntities: UnconsumedEntity[] = [];

  for (const record of records) {
    const { sourceOrdinal, sourceHandle, type, layer } = record.entity;
    const role = roleByLayer.get(layer);
    if (record.kind === "unsupported") {
      if (role) {
        fail(
          "CAD_INTERPRET_UNSUPPORTED_ENTITY_ON_MAPPED_LAYER",
          `Unsupported ${type} (source ordinal ${sourceOrdinal}) is on mapped ${role} layer ${layer}`,
          { sourceOrdinal, type, layer, role },
        );
      }
      unconsumedEntities.push({
        sourceOrdinal,
        sourceHandle,
        type,
        layer,
        reason: "UNSUPPORTED_SOURCE_ENTITY",
      });
      continue;
    }
    if (!role) {
      unconsumedEntities.push({
        sourceOrdinal,
        sourceHandle,
        type,
        layer,
        reason: "UNMAPPED_LAYER",
      });
      continue;
    }
    const entity = record.entity;
    if (entity.type !== EXPECTED_TYPE[role]) {
      fail(
        "CAD_INTERPRET_ENTITY_ROLE_MISMATCH",
        `${type} (source ordinal ${sourceOrdinal}) cannot carry the ${role} role of layer ${layer}`,
        { sourceOrdinal, type, layer, role, expectedType: EXPECTED_TYPE[role] },
      );
    }
    if (entity.type === "LWPOLYLINE") boundaryEntities.push(entity);
    else if (entity.type === "TEXT") labelEntities.push(entity);
    else if (entity.type === "INSERT") {
      insertEntities.push({ entity, role: role === "door" ? "door" : "window" });
    }
  }

  // 3. Space boundaries: closed, straight, simple, positive area; CCW-normalized.
  const spaces: ParsedSpace[] = boundaryEntities.map((entity, index) => {
    const details = { sourceOrdinal: entity.sourceOrdinal, sourceHandle: entity.sourceHandle };
    if (entity.vertices.some((vertex) => vertex.bulge !== 0)) {
      fail(
        "CAD_INTERPRET_SPACE_BOUNDARY_CURVED_UNSUPPORTED",
        `Space boundary (source ordinal ${entity.sourceOrdinal}) has an arc segment; curves are never flattened`,
        details,
      );
    }
    const invalid = (defect: string): never =>
      fail(
        "CAD_INTERPRET_SPACE_BOUNDARY_INVALID",
        `Space boundary (source ordinal ${entity.sourceOrdinal}) is invalid: ${defect}`,
        { ...details, defect },
      );
    if (!entity.closed) invalid("OPEN_POLYLINE");
    if (Math.abs(entity.elevation - level.elevationMm) > EPSILON) invalid("ELEVATION_MISMATCH");
    const points = entity.vertices.map((vertex): Point2 => [vertex.x, vertex.y]);
    const defect = polygonDefect(points);
    if (defect) invalid(defect);
    const counterClockwise = signedArea(points) > 0;
    return {
      candidateId: `space_candidate_${pad4(index)}`,
      boundaryEntity: entity,
      // Clockwise input is reversed keeping its first vertex first.
      boundary: counterClockwise ? points : [points[0] as Point2, ...points.slice(1).reverse()],
      sourceWinding: counterClockwise ? "counter_clockwise" : "clockwise",
    };
  });
  if (spaces.length === 0) {
    fail(
      "CAD_INTERPRET_SPACE_MISSING",
      `No closed boundary on layer ${profile.layers.spaceBoundary}`,
    );
  }
  for (let i = 0; i < spaces.length; i += 1) {
    for (let j = i + 1; j < spaces.length; j += 1) {
      const first = spaces[i] as ParsedSpace;
      const second = spaces[j] as ParsedSpace;
      if (polygonsOverlap(first.boundary, second.boundary)) {
        fail(
          "CAD_INTERPRET_SPACE_OVERLAP",
          `Space boundaries (source ordinals ${first.boundaryEntity.sourceOrdinal} and ${second.boundaryEntity.sourceOrdinal}) overlap`,
          {
            sourceOrdinals: [
              first.boundaryEntity.sourceOrdinal,
              second.boundaryEntity.sourceOrdinal,
            ],
          },
        );
      }
    }
  }

  // 4. Labels: exact text rule, insertion point strictly inside exactly one space.
  const ruleByText = new Map(profile.spaceLabelRules.map((rule) => [rule.text, rule]));
  const labelsBySpace = spaces.map((): { entity: CadTextEntity; rule: SpaceLabelRule }[] => []);
  for (const entity of labelEntities) {
    const details = { sourceOrdinal: entity.sourceOrdinal, text: entity.text };
    const rule = ruleByText.get(entity.text);
    if (!rule) {
      fail(
        "CAD_INTERPRET_SPACE_LABEL_UNMAPPED",
        `Label text ${JSON.stringify(entity.text)} (source ordinal ${entity.sourceOrdinal}) has no exact profile rule`,
        details,
      );
    }
    const point: Point2 = [entity.insertionPoint[0], entity.insertionPoint[1]];
    if (spaces.some((space) => isOnBoundary(space.boundary, point))) {
      fail(
        "CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS",
        `Label (source ordinal ${entity.sourceOrdinal}) lies on a space boundary; ownership requires strictly inside`,
        { ...details, ambiguity: "ON_BOUNDARY" },
      );
    }
    const owners = spaces.flatMap((space, index) =>
      isStrictlyInside(space.boundary, point) ? [index] : [],
    );
    if (owners.length === 0) {
      fail(
        "CAD_INTERPRET_SPACE_LABEL_ORPHANED",
        `Label (source ordinal ${entity.sourceOrdinal}) is inside no space`,
        details,
      );
    }
    if (owners.length > 1) {
      fail(
        "CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS",
        `Label (source ordinal ${entity.sourceOrdinal}) is inside more than one space`,
        { ...details, ambiguity: "MULTIPLE_SPACES" },
      );
    }
    labelsBySpace[owners[0] as number]?.push({ entity, rule });
  }

  const spaceCandidates: SpaceCandidate[] = [];
  const wallCandidates: WallCandidate[] = [];
  for (const [index, space] of spaces.entries()) {
    const labels = labelsBySpace[index] ?? [];
    const spaceDetails = {
      spaceCandidateId: space.candidateId,
      sourceOrdinal: space.boundaryEntity.sourceOrdinal,
    };
    if (labels.length === 0) {
      fail(
        "CAD_INTERPRET_SPACE_LABEL_MISSING",
        `Space ${space.candidateId} has no mapped label`,
        spaceDetails,
      );
    }
    if (labels.length > 1) {
      fail(
        "CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS",
        `Space ${space.candidateId} has ${labels.length} mapped labels`,
        {
          ...spaceDetails,
          ambiguity: "MULTIPLE_LABELS",
          labelOrdinals: labels.map((label) => label.entity.sourceOrdinal),
        },
      );
    }
    const { entity: label, rule } = labels[0] as { entity: CadTextEntity; rule: SpaceLabelRule };
    spaceCandidates.push({
      candidateId: space.candidateId,
      levelCandidateId: level.levelCandidateId,
      spaceType: rule.spaceType,
      labelText: label.text,
      boundary: space.boundary.map((point): Point2 => [point[0], point[1]]),
      boundaryWinding: "counter_clockwise",
      sourceWinding: space.sourceWinding,
      normalization: space.sourceWinding === "clockwise" ? "reversed_to_counter_clockwise" : "none",
      floorElevationMm: level.elevationMm,
      ceilingHeightMm: level.defaultCeilingHeightMm,
      provenance: {
        boundary: [
          cad(space.boundaryEntity, "space_boundary"),
          derived("boundary_winding_normalization_v0.1"),
        ],
        spaceType: [
          cad(label, "space_label"),
          fromProfile("spaceLabelRules.spaceType", rule.ruleId),
        ],
        floorElevationMm: [fromProfile("level.elevationMm")],
        ceilingHeightMm: [fromProfile("level.defaultCeilingHeightMm")],
      },
    });

    // 5. One wall per normalized CCW edge Pi -> Pi+1. The interior is on the
    // left of every CCW edge, so the edge is the interior face and the
    // thickness extends to its right (SceneSpec interior_face /
    // exterior_right_of_u).
    for (const [edgeIndex, start] of space.boundary.entries()) {
      const end = space.boundary[(edgeIndex + 1) % space.boundary.length] as Point2;
      wallCandidates.push({
        candidateId: `wall_candidate_${space.candidateId.slice(-4)}_${pad4(edgeIndex)}`,
        spaceCandidateId: space.candidateId,
        levelCandidateId: level.levelCandidateId,
        edgeIndex,
        start: [start[0], start[1]],
        end: [end[0], end[1]],
        lengthMm: Math.hypot(end[0] - start[0], end[1] - start[1]),
        baseElevationMm: level.elevationMm,
        heightMm: level.defaultCeilingHeightMm,
        thicknessMm: profile.wallDefaults.wallThicknessMm,
        referenceLine: "interior_face",
        thicknessDirection: "exterior_right_of_u",
        provenance: {
          geometry: [
            cad(space.boundaryEntity, "space_boundary"),
            derived("space_boundary_edge_v0.1"),
          ],
          baseElevationMm: [fromProfile("level.elevationMm")],
          heightMm: [fromProfile("level.defaultCeilingHeightMm")],
          thicknessMm: [fromProfile("wallDefaults.wallThicknessMm")],
          referenceConvention: [derived("wall_reference_convention_v0.1")],
        },
      });
    }
  }

  // 6. Openings: explicit block rule, identity scale, unique host, derived offset.
  const blockByName = new Map(cadDocument.blocks.map((block) => [block.name, block]));
  const doorRules = new Map(profile.doorRules.map((rule) => [rule.blockName, rule]));
  const windowRules = new Map(profile.windowRules.map((rule) => [rule.blockName, rule]));
  const openings: OpeningCandidate[] = insertEntities.map(({ entity, role }, index) => {
    const details = {
      sourceOrdinal: entity.sourceOrdinal,
      blockName: entity.blockName,
      role,
    };
    const block = blockByName.get(entity.blockName);
    if (!block) {
      fail(
        "CAD_INTERPRET_BLOCK_REFERENCE_INVALID",
        `INSERT (source ordinal ${entity.sourceOrdinal}) references undefined block ${entity.blockName}`,
        details,
      );
    }
    if (block.externalReference) {
      fail(
        "CAD_INTERPRET_EXTERNAL_BLOCK_UNSUPPORTED",
        `INSERT (source ordinal ${entity.sourceOrdinal}) references external block ${entity.blockName}`,
        details,
      );
    }
    const rule: DoorRule | WindowRule | undefined =
      role === "door" ? doorRules.get(entity.blockName) : windowRules.get(entity.blockName);
    if (!rule) {
      fail(
        "CAD_INTERPRET_OPENING_RULE_MISSING",
        `No ${role} rule maps block ${entity.blockName} (source ordinal ${entity.sourceOrdinal})`,
        details,
      );
    }
    if (entity.scale.some((factor) => Math.abs(factor - 1) > 1e-9)) {
      fail(
        "CAD_INTERPRET_OPENING_SCALE_UNSUPPORTED",
        `Opening INSERT (source ordinal ${entity.sourceOrdinal}) must have scale [1,1,1]`,
        { ...details, scale: entity.scale },
      );
    }

    const center: Point2 = [entity.insertionPoint[0], entity.insertionPoint[1]];
    const hosts = wallCandidates.flatMap((wall) => {
      const projection = projectOntoSegment(center, wall.start, wall.end);
      const onSegment =
        projection.alongMm >= -EPSILON && projection.alongMm <= projection.lengthMm + EPSILON;
      return projection.perpendicularMm <= CAD_INTERPRET_HOST_TOLERANCE_MM && onSegment
        ? [{ wall, projection }]
        : [];
    });
    if (hosts.length === 0) {
      fail(
        "CAD_INTERPRET_OPENING_HOST_UNRESOLVED",
        `Opening (source ordinal ${entity.sourceOrdinal}) is within ${CAD_INTERPRET_HOST_TOLERANCE_MM} mm of no wall segment`,
        details,
      );
    }
    if (hosts.length > 1) {
      fail(
        "CAD_INTERPRET_OPENING_HOST_AMBIGUOUS",
        `Opening (source ordinal ${entity.sourceOrdinal}) matches ${hosts.length} wall segments`,
        { ...details, hostWallCandidateIds: hosts.map((host) => host.wall.candidateId) },
      );
    }
    const { wall, projection } = hosts[0] as (typeof hosts)[number];
    const rawOffset = projection.alongMm - rule.widthMm / 2;
    if (rawOffset < -EPSILON || rawOffset + rule.widthMm > wall.lengthMm + EPSILON) {
      fail(
        "CAD_INTERPRET_OPENING_OUTSIDE_HOST",
        `Opening (source ordinal ${entity.sourceOrdinal}) of width ${rule.widthMm} does not fit host ${wall.candidateId}`,
        { ...details, hostWallCandidateId: wall.candidateId, offsetMm: rawOffset },
      );
    }
    // Epsilon snap into [0, length - width]; values already inside are exact.
    const offsetMm = Math.min(Math.max(rawOffset, 0), wall.lengthMm - rule.widthMm);
    const rulesField = role === "door" ? "doorRules" : "windowRules";
    const source = cad(entity, role === "door" ? "door_insert" : "window_insert");
    const common = {
      candidateId: `opening_candidate_${pad4(index)}`,
      hostWallCandidateId: wall.candidateId,
      spaceCandidateId: wall.spaceCandidateId,
      blockName: entity.blockName,
      sourceCenter: center,
      sourceRotationDegrees: entity.rotationDegrees,
      hostDistanceMm: projection.perpendicularMm,
      offsetMm,
      widthMm: rule.widthMm,
      heightMm: rule.heightMm,
      sillMm: rule.sillMm,
    };
    const provenance = {
      center: [source],
      host: [source, derived("opening_host_projection_v0.1")],
      offsetMm: [
        source,
        fromProfile(`${rulesField}.widthMm`, rule.ruleId),
        derived("opening_offset_v0.1"),
      ],
      widthMm: [fromProfile(`${rulesField}.widthMm`, rule.ruleId)],
      heightMm: [fromProfile(`${rulesField}.heightMm`, rule.ruleId)],
      sillMm: [fromProfile(`${rulesField}.sillMm`, rule.ruleId)],
    };
    if (role === "door") {
      const doorRule = rule as DoorRule;
      return {
        ...common,
        type: "door",
        hingeSide: doorRule.hingeSide,
        swingDirection: doorRule.swingDirection,
        provenance: {
          ...provenance,
          hingeSide: [fromProfile("doorRules.hingeSide", rule.ruleId)],
          swingDirection: [fromProfile("doorRules.swingDirection", rule.ruleId)],
        },
      };
    }
    return { ...common, type: "window", provenance };
  });

  const consumedEntityCount =
    boundaryEntities.length + labelEntities.length + insertEntities.length;
  if (consumedEntityCount + unconsumedEntities.length !== cadDocument.summary.entityCount) {
    throw new Error("Interpretation accounting invariant violated: a source entity was dropped");
  }

  return {
    architecturalExtractionVersion: ARCHITECTURAL_EXTRACTION_VERSION,
    interpretationPolicyVersion: CAD_INTERPRETATION_POLICY_VERSION,
    profileId: profile.profileId,
    profileHash: semanticHash(profile),
    source: {
      cadDocumentVersion: cadDocument.cadDocumentVersion,
      sourceFormat: cadDocument.sourceFormat,
      sourceHash: cadDocument.sourceHash,
      cadDocumentHash: semanticHash(cadDocument),
    },
    canonicalUnits: "millimeters",
    level: {
      levelCandidateId: level.levelCandidateId,
      name: level.name,
      elevationMm: level.elevationMm,
      defaultCeilingHeightMm: level.defaultCeilingHeightMm,
      provenance: {
        name: [fromProfile("level.name")],
        elevationMm: [fromProfile("level.elevationMm")],
        defaultCeilingHeightMm: [fromProfile("level.defaultCeilingHeightMm")],
      },
    },
    spaces: spaceCandidates,
    walls: wallCandidates,
    openings,
    unconsumedEntities,
    summary: {
      spaceCount: spaceCandidates.length,
      wallCount: wallCandidates.length,
      openingCount: openings.length,
      doorCount: openings.filter((opening) => opening.type === "door").length,
      windowCount: openings.filter((opening) => opening.type === "window").length,
      sourceEntityCount: cadDocument.summary.entityCount,
      consumedEntityCount,
      unconsumedEntityCount: unconsumedEntities.length,
    },
    status: "READY_FOR_REVIEW",
  };
}
