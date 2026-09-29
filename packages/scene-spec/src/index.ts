import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";

export interface ContractValidationError {
  instancePath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ContractValidationError[] };

export type SceneSpec = Record<string, unknown>;
export type SceneChangeSet = Record<string, unknown>;

/**
 * Narrow, version-aware material types. These do not attempt a full typed
 * SceneSpec migration; they exist only so callers that care about material
 * appearance (the Corona adapter) can type it without `Record<string, unknown>`.
 */
export interface MaterialV02 {
  id: string;
  name: string;
  baseColorRgb: [number, number, number];
}

export interface MaterialV03 extends MaterialV02 {
  roughness: number;
  metalness: number;
}

const schemaV01Url = new URL("../schema/scene-spec-v0.1.schema.json", import.meta.url);
const schemaV02Url = new URL("../schema/scene-spec-v0.2.schema.json", import.meta.url);
const schemaV03Url = new URL("../schema/scene-spec-v0.3.schema.json", import.meta.url);
const schemaV04Url = new URL("../schema/scene-spec-v0.4.schema.json", import.meta.url);
const schemaV05Url = new URL("../schema/scene-spec-v0.5.schema.json", import.meta.url);
const changeSetSchemaUrl = new URL("../schema/scene-change-set-v0.1.schema.json", import.meta.url);
const changeSetV02SchemaUrl = new URL(
  "../schema/scene-change-set-v0.2.schema.json",
  import.meta.url,
);
const changeSetV03SchemaUrl = new URL(
  "../schema/scene-change-set-v0.3.schema.json",
  import.meta.url,
);
const changeSetV04SchemaUrl = new URL(
  "../schema/scene-change-set-v0.4.schema.json",
  import.meta.url,
);
const sceneSpecV01Schema = JSON.parse(readFileSync(schemaV01Url, "utf8")) as Record<
  string,
  unknown
>;
const sceneSpecSchema = JSON.parse(readFileSync(schemaV02Url, "utf8")) as Record<string, unknown>;
const sceneSpecV03Schema = JSON.parse(readFileSync(schemaV03Url, "utf8")) as Record<
  string,
  unknown
>;
const sceneSpecV04Schema = JSON.parse(readFileSync(schemaV04Url, "utf8")) as Record<
  string,
  unknown
>;
const sceneSpecV05Schema = JSON.parse(readFileSync(schemaV05Url, "utf8")) as Record<
  string,
  unknown
>;
const sceneChangeSetSchema = JSON.parse(readFileSync(changeSetSchemaUrl, "utf8")) as Record<
  string,
  unknown
>;
const sceneChangeSetV02Schema = JSON.parse(readFileSync(changeSetV02SchemaUrl, "utf8")) as Record<
  string,
  unknown
>;
const sceneChangeSetV03Schema = JSON.parse(readFileSync(changeSetV03SchemaUrl, "utf8")) as Record<
  string,
  unknown
>;
const sceneChangeSetV04Schema = JSON.parse(readFileSync(changeSetV04SchemaUrl, "utf8")) as Record<
  string,
  unknown
>;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormatsModule.default.default(ajv);

const validateV01 = ajv.compile(sceneSpecV01Schema) as ValidateFunction<SceneSpec>;
const validateV02 = ajv.compile(sceneSpecSchema) as ValidateFunction<SceneSpec>;
const validateV03 = ajv.compile(sceneSpecV03Schema) as ValidateFunction<SceneSpec>;
const validateV04 = ajv.compile(sceneSpecV04Schema) as ValidateFunction<SceneSpec>;
const validateV05 = ajv.compile(sceneSpecV05Schema) as ValidateFunction<SceneSpec>;
const validateChangeSet = ajv.compile(sceneChangeSetSchema) as ValidateFunction<SceneChangeSet>;
const validateChangeSetV02 = ajv.compile(
  sceneChangeSetV02Schema,
) as ValidateFunction<SceneChangeSet>;
const validateChangeSetV03 = ajv.compile(
  sceneChangeSetV03Schema,
) as ValidateFunction<SceneChangeSet>;
const validateChangeSetV04 = ajv.compile(
  sceneChangeSetV04Schema,
) as ValidateFunction<SceneChangeSet>;

function normalizeErrors(errors: ErrorObject[] | null | undefined): ContractValidationError[] {
  return (errors ?? [])
    .map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? "Schema validation failed",
      params: error.params as Record<string, unknown>,
    }))
    .sort((left, right) => {
      const leftKey = `${left.instancePath}\u0000${left.keyword}\u0000${left.message}`;
      const rightKey = `${right.instancePath}\u0000${right.keyword}\u0000${right.message}`;
      return leftKey.localeCompare(rightKey);
    });
}

export function validateSceneSpec(value: unknown): ValidationResult<SceneSpec> {
  const version =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { sceneSpecVersion?: unknown }).sceneSpecVersion
      : undefined;
  const validate =
    version === "0.1.0"
      ? validateV01
      : version === "0.3.0"
        ? validateV03
        : version === "0.4.0"
          ? validateV04
          : version === "0.5.0"
            ? validateV05
            : validateV02;
  if (
    validate(value) &&
    (version === "0.1.0" ||
      version === "0.2.0" ||
      version === "0.3.0" ||
      version === "0.4.0" ||
      version === "0.5.0")
  ) {
    if (version === "0.2.0" || version === "0.3.0") {
      const identityErrors = validateAssetIdentity(value);
      if (identityErrors.length > 0) return { ok: false, errors: identityErrors };
    }
    if (version === "0.4.0") {
      const semanticErrors = [
        ...validateAssetIdentity(value),
        ...validateCirculationRequirements(value),
      ].sort((left, right) => left.instancePath.localeCompare(right.instancePath));
      if (semanticErrors.length > 0) return { ok: false, errors: semanticErrors };
    }
    if (version === "0.5.0") {
      const semanticErrors = [
        ...validateAssetIdentity(value),
        ...validateCirculationRequirements(value, "v0.5"),
        ...validateMultiSpaceGeometry(value),
      ].sort(
        (left, right) =>
          left.instancePath.localeCompare(right.instancePath) ||
          left.keyword.localeCompare(right.keyword),
      );
      if (semanticErrors.length > 0) return { ok: false, errors: semanticErrors };
    }
    return { ok: true, value };
  }

  return { ok: false, errors: normalizeErrors(validate.errors) };
}

function validateAssetIdentity(value: SceneSpec): ContractValidationError[] {
  const scene = value as {
    assetDefinitions?: Array<{ id?: unknown }>;
    assets?: Array<{ id?: unknown; assetDefinitionId?: unknown }>;
  };
  const definitions = scene.assetDefinitions ?? [];
  const assets = scene.assets ?? [];
  const errors: ContractValidationError[] = [];
  const definitionIds = new Set<string>();
  definitions.forEach((definition, index) => {
    const id = typeof definition.id === "string" ? definition.id : "";
    if (definitionIds.has(id)) {
      errors.push({
        instancePath: `/assetDefinitions/${index}/id`,
        keyword: "uniqueAssetDefinitionId",
        message: "asset definition id must be unique",
        params: { id },
      });
    }
    definitionIds.add(id);
  });
  const assetIds = new Set<string>();
  assets.forEach((asset, index) => {
    const id = typeof asset.id === "string" ? asset.id : "";
    if (assetIds.has(id)) {
      errors.push({
        instancePath: `/assets/${index}/id`,
        keyword: "uniqueLogicalAssetId",
        message: "logical asset id must be unique",
        params: { id },
      });
    }
    assetIds.add(id);
    const definitionId = typeof asset.assetDefinitionId === "string" ? asset.assetDefinitionId : "";
    if (!definitionIds.has(definitionId)) {
      errors.push({
        instancePath: `/assets/${index}/assetDefinitionId`,
        keyword: "assetDefinitionReference",
        message: "assetDefinitionId must resolve to an asset definition",
        params: { assetDefinitionId: definitionId },
      });
    }
  });
  return errors.sort((left, right) => left.instancePath.localeCompare(right.instancePath));
}

interface CirculationEndpointInput {
  kind: "door_portal" | "point";
  openingId?: string;
  pointXY?: [number, number];
}

interface CirculationRequirementInput {
  id: string;
  spaceId: string;
  start: CirculationEndpointInput;
  end: CirculationEndpointInput;
}

function sameEndpoint(left: CirculationEndpointInput, right: CirculationEndpointInput): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "door_portal") return left.openingId === right.openingId;
  return left.pointXY?.[0] === right.pointXY?.[0] && left.pointXY?.[1] === right.pointXY?.[1];
}

/**
 * SceneSpec v0.4 structural coherence for circulationRequirements: sorted
 * unique IDs, exactly-once space/opening/host-wall resolution, door-only
 * portals owned by the requirement's own space (canonical wall spaceId, never
 * geometric overlap), and distinct endpoint intent. Whether a requirement is
 * currently satisfied is a separate evaluation, never a validation error.
 */
function validateCirculationRequirements(
  value: SceneSpec,
  contract: "v0.4" | "v0.5" = "v0.4",
): ContractValidationError[] {
  const scene = value as {
    spaces: Array<{ id: string }>;
    geometry: Array<{ id: string; type: string; spaceId?: string }>;
    openings: Array<{
      id: string;
      type: string;
      hostGeometryId: string;
      connectsSpaceIds?: string[];
    }>;
    circulationRequirements: CirculationRequirementInput[];
  };
  const errors: ContractValidationError[] = [];
  const countById = <T extends { id: string }>(items: readonly T[], id: string) =>
    items.filter((item) => item.id === id);
  const seen = new Set<string>();
  scene.circulationRequirements.forEach((requirement, index) => {
    const path = `/circulationRequirements/${index}`;
    const previous = scene.circulationRequirements[index - 1];
    if (seen.has(requirement.id)) {
      errors.push({
        instancePath: `${path}/id`,
        keyword: "uniqueCirculationRequirementId",
        message: "circulation requirement id must be unique",
        params: { id: requirement.id },
      });
    } else if (previous && previous.id > requirement.id) {
      errors.push({
        instancePath: `${path}/id`,
        keyword: "circulationRequirementOrder",
        message: "circulationRequirements must be sorted by id in code-point order",
        params: { id: requirement.id, previousId: previous.id },
      });
    }
    seen.add(requirement.id);

    if (countById(scene.spaces, requirement.spaceId).length !== 1) {
      errors.push({
        instancePath: `${path}/spaceId`,
        keyword: "circulationRequirementSpaceReference",
        message: "spaceId must resolve to exactly one space",
        params: { spaceId: requirement.spaceId },
      });
    }

    for (const side of ["start", "end"] as const) {
      const endpoint = requirement[side];
      if (endpoint.kind !== "door_portal") continue;
      const endpointPath = `${path}/${side}/openingId`;
      const openings = countById(scene.openings, endpoint.openingId ?? "");
      const opening = openings[0];
      if (openings.length !== 1 || !opening) {
        errors.push({
          instancePath: endpointPath,
          keyword: "circulationRequirementOpeningReference",
          message: "openingId must resolve to exactly one opening",
          params: { openingId: endpoint.openingId },
        });
        continue;
      }
      if (opening.type !== "door") {
        errors.push({
          instancePath: endpointPath,
          keyword: "circulationRequirementOpeningType",
          message: "door_portal endpoints must reference a door opening",
          params: { openingId: opening.id, openingType: opening.type },
        });
        continue;
      }
      const hosts = countById(scene.geometry, opening.hostGeometryId);
      const host = hosts[0];
      // v0.5 only: a shared-partition door offers one portal to EACH connected
      // space; the requirement's own space selects it (never the swing space).
      const partitionHost = contract === "v0.5" && host?.type === "shared_partition";
      if (hosts.length !== 1 || (host?.type !== "wall" && !partitionHost)) {
        errors.push({
          instancePath: endpointPath,
          keyword: "circulationRequirementOpeningHost",
          message:
            contract === "v0.5"
              ? "door host must resolve to exactly one wall or shared partition"
              : "door host must resolve to exactly one wall",
          params: { openingId: opening.id, hostGeometryId: opening.hostGeometryId },
        });
        continue;
      }
      if (partitionHost) {
        if (!(opening.connectsSpaceIds ?? []).includes(requirement.spaceId)) {
          errors.push({
            instancePath: endpointPath,
            keyword: "circulationRequirementOpeningSpace",
            message: "shared-partition door must connect the requirement space",
            params: {
              openingId: opening.id,
              requirementSpaceId: requirement.spaceId,
              connectsSpaceIds: opening.connectsSpaceIds ?? [],
            },
          });
        }
        continue;
      }
      if (host?.spaceId !== requirement.spaceId) {
        errors.push({
          instancePath: endpointPath,
          keyword: "circulationRequirementOpeningSpace",
          message: "door host wall must belong to the requirement space",
          params: {
            openingId: opening.id,
            requirementSpaceId: requirement.spaceId,
            hostSpaceId: host?.spaceId,
          },
        });
      }
    }

    if (sameEndpoint(requirement.start, requirement.end)) {
      errors.push({
        instancePath: path,
        keyword: "circulationRequirementDistinctEndpoints",
        message: "a circulation requirement must have distinct start and end endpoints",
        params: { id: requirement.id },
      });
    }
  });
  return errors;
}

/** Canonical geometry epsilon (mm); the same value as spatial-policy SPATIAL_EPSILON_MM. */
export const SCENE_GEOMETRY_EPSILON_MM = 0.001;

type Vec3 = [number, number, number];

interface SharedPartitionInput {
  id: string;
  type: "shared_partition";
  levelId: string;
  adjacentSpaceIds: string[];
  start: Vec3;
  end: Vec3;
  baseElevation: number;
  thickness: number;
  spaceFaces: Array<{ spaceId: string; side: "left" | "right"; start: Vec3; end: Vec3 }>;
}

interface OpeningGeometryInput {
  id: string;
  type: string;
  hostGeometryId: string;
  offset: number;
  width: number;
  connectsSpaceIds?: string[];
  swingIntoSpaceId?: string;
}

/**
 * The frozen shared-partition frame: u = normalize(end - start) in XY,
 * leftNormal = [-u.y, u.x], rightNormal = [u.y, -u.x]; null for a
 * zero-length centerline.
 */
export function sharedPartitionFrame(partition: {
  start: readonly number[];
  end: readonly number[];
}): {
  length: number;
  unit: [number, number];
  left: [number, number];
  right: [number, number];
} | null {
  const dx = (partition.end[0] as number) - (partition.start[0] as number);
  const dy = (partition.end[1] as number) - (partition.start[1] as number);
  const length = Math.hypot(dx, dy);
  if (length <= SCENE_GEOMETRY_EPSILON_MM) return null;
  const unit: [number, number] = [dx / length + 0, dy / length + 0];
  return {
    length,
    unit,
    left: [-unit[1] + 0, unit[0] + 0],
    right: [unit[1] + 0, -unit[0] + 0],
  };
}

/**
 * SceneSpec v0.5 multi-space coherence: unique space/geometry/opening IDs;
 * every shared_partition has two distinct, sorted adjacent spaces that each
 * resolve exactly once on its own level, a positive centerline at its base
 * elevation, and left/right faces proven to lie exactly thickness/2 along the
 * frozen normals in the centerline direction (stored face coordinates are
 * never trusted); every opening resolves its host exactly once with a
 * compatible type (legacy doors and windows on walls, partition doors on
 * shared partitions, never a partition window); partition doors connect
 * exactly the host spaces, swing into one of them, fit the partition, and
 * never overlap another opening on it.
 */
function validateMultiSpaceGeometry(value: SceneSpec): ContractValidationError[] {
  const scene = value as {
    spaces: Array<{ id: string; levelId: string }>;
    geometry: Array<{ id: string; type: string }>;
    openings: OpeningGeometryInput[];
  };
  const epsilon = SCENE_GEOMETRY_EPSILON_MM;
  const errors: ContractValidationError[] = [];
  const push = (
    instancePath: string,
    keyword: string,
    message: string,
    params: Record<string, unknown>,
  ) => errors.push({ instancePath, keyword, message, params });

  for (const [collection, items] of [
    ["spaces", scene.spaces],
    ["geometry", scene.geometry],
    ["openings", scene.openings],
  ] as const) {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.id)) {
        push(`/${collection}/${index}/id`, "uniqueLogicalId", `${collection} id must be unique`, {
          id: item.id,
        });
      }
      seen.add(item.id);
    });
  }

  const partitionLengths = new Map<string, number>();
  scene.geometry.forEach((entry, index) => {
    if (entry.type !== "shared_partition") return;
    const partition = entry as unknown as SharedPartitionInput;
    const path = `/geometry/${index}`;
    const [first, second] = partition.adjacentSpaceIds as [string, string];
    if (first === second) {
      push(
        `${path}/adjacentSpaceIds`,
        "partitionAdjacentSpacesDistinct",
        "adjacentSpaceIds must name two distinct spaces",
        { adjacentSpaceIds: partition.adjacentSpaceIds },
      );
    } else if (first > second) {
      push(
        `${path}/adjacentSpaceIds`,
        "partitionAdjacentSpacesOrder",
        "adjacentSpaceIds must be sorted in code-point order",
        { adjacentSpaceIds: partition.adjacentSpaceIds },
      );
    }
    for (const spaceId of new Set(partition.adjacentSpaceIds)) {
      const matches = scene.spaces.filter((space) => space.id === spaceId);
      if (matches.length !== 1) {
        push(
          `${path}/adjacentSpaceIds`,
          "partitionAdjacentSpaceReference",
          "each adjacent space must resolve to exactly one space",
          { spaceId },
        );
      } else if (matches[0]?.levelId !== partition.levelId) {
        push(
          `${path}/adjacentSpaceIds`,
          "partitionAdjacentSpaceLevel",
          "each adjacent space must be on the partition level",
          { spaceId, levelId: partition.levelId },
        );
      }
    }
    const faceSpaces = partition.spaceFaces.map((face) => face.spaceId);
    if (
      new Set(faceSpaces).size !== 2 ||
      faceSpaces.some((spaceId) => !partition.adjacentSpaceIds.includes(spaceId))
    ) {
      push(
        `${path}/spaceFaces`,
        "partitionFaceSpaces",
        "spaceFaces must name each adjacent space exactly once",
        { faceSpaceIds: faceSpaces },
      );
    }

    const frame = sharedPartitionFrame(partition);
    if (!frame) {
      push(
        `${path}/end`,
        "partitionCenterlineLength",
        "partition centerline must have positive XY length",
        { id: partition.id },
      );
      return;
    }
    partitionLengths.set(partition.id, frame.length);
    const zs = [
      partition.start[2],
      partition.end[2],
      ...partition.spaceFaces.flatMap((face) => [face.start[2], face.end[2]]),
    ];
    if (zs.some((z) => Math.abs(z - partition.baseElevation) > epsilon)) {
      push(path, "partitionElevation", "partition centerline and faces must lie at baseElevation", {
        id: partition.id,
      });
    }
    const half = partition.thickness / 2;
    partition.spaceFaces.forEach((face, faceIndex) => {
      const normal = face.side === "left" ? frame.left : frame.right;
      const offsetDistance = (stored: Vec3, reference: Vec3) =>
        Math.hypot(
          stored[0] - (reference[0] + normal[0] * half),
          stored[1] - (reference[1] + normal[1] * half),
        );
      if (
        offsetDistance(face.start, partition.start) > epsilon ||
        offsetDistance(face.end, partition.end) > epsilon
      ) {
        push(
          `${path}/spaceFaces/${faceIndex}`,
          "partitionFaceGeometry",
          `the ${face.side} face must be the centerline offset by thickness/2 along the ${face.side} normal, in the centerline direction`,
          { id: partition.id, side: face.side },
        );
      }
    });
  });

  const geometryById = new Map<string, Array<{ id: string; type: string }>>();
  for (const entry of scene.geometry) {
    geometryById.set(entry.id, [...(geometryById.get(entry.id) ?? []), entry]);
  }
  const spansByPartition = new Map<string, Array<{ id: string; from: number; to: number }>>();
  scene.openings.forEach((opening, index) => {
    const path = `/openings/${index}`;
    const hosts = geometryById.get(opening.hostGeometryId) ?? [];
    const host = hosts[0];
    const partitionDoor = opening.connectsSpaceIds !== undefined;
    const expectedType = partitionDoor ? "shared_partition" : "wall";
    if (hosts.length !== 1 || host?.type !== expectedType) {
      push(
        `${path}/hostGeometryId`,
        "openingHostType",
        partitionDoor
          ? "a partition door must be hosted on exactly one shared_partition"
          : `a ${opening.type} must be hosted on exactly one wall`,
        {
          openingId: opening.id,
          hostGeometryId: opening.hostGeometryId,
          hostType: host?.type ?? null,
        },
      );
      return;
    }
    if (!partitionDoor) return;
    const partition = host as unknown as SharedPartitionInput;
    const connects = opening.connectsSpaceIds ?? [];
    if (
      connects.length !== 2 ||
      connects[0] !== partition.adjacentSpaceIds[0] ||
      connects[1] !== partition.adjacentSpaceIds[1]
    ) {
      push(
        `${path}/connectsSpaceIds`,
        "partitionOpeningConnectivity",
        "connectsSpaceIds must equal the host partition adjacentSpaceIds",
        {
          openingId: opening.id,
          connectsSpaceIds: connects,
          adjacentSpaceIds: partition.adjacentSpaceIds,
        },
      );
    }
    if (!connects.includes(opening.swingIntoSpaceId ?? "")) {
      push(
        `${path}/swingIntoSpaceId`,
        "partitionOpeningSwingSpace",
        "swingIntoSpaceId must be one of connectsSpaceIds",
        { openingId: opening.id, swingIntoSpaceId: opening.swingIntoSpaceId },
      );
    }
    const length = partitionLengths.get(partition.id);
    if (length === undefined) return;
    if (opening.offset < -epsilon || opening.offset + opening.width > length + epsilon) {
      push(
        `${path}/offset`,
        "partitionOpeningFit",
        "a partition opening must fit within the partition length",
        {
          openingId: opening.id,
          offset: opening.offset,
          width: opening.width,
          partitionLength: length,
        },
      );
    }
    const spans = spansByPartition.get(partition.id) ?? [];
    for (const other of spans) {
      const overlap =
        Math.min(other.to, opening.offset + opening.width) - Math.max(other.from, opening.offset);
      if (overlap > epsilon) {
        push(
          `${path}/offset`,
          "partitionOpeningOverlap",
          "openings on one partition must not overlap (touching jambs are allowed)",
          { openingId: opening.id, otherOpeningId: other.id },
        );
      }
    }
    spans.push({ id: opening.id, from: opening.offset, to: opening.offset + opening.width });
    spansByPartition.set(partition.id, spans);
  });
  return errors;
}

export function validateSceneChangeSet(value: unknown): ValidationResult<SceneChangeSet> {
  const version =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  const validate =
    version === "0.1.0"
      ? validateChangeSet
      : version === "0.2.0"
        ? validateChangeSetV02
        : version === "0.3.0"
          ? validateChangeSetV03
          : version === "0.4.0"
            ? validateChangeSetV04
            : null;
  if (!validate) {
    return {
      ok: false,
      errors: [
        {
          instancePath: "/schemaVersion",
          keyword: "unsupportedSchemaVersion",
          message: "schemaVersion must be one of: 0.1.0, 0.2.0, 0.3.0, 0.4.0",
          params: { schemaVersion: version },
        },
      ],
    };
  }
  if (validate(value)) {
    return { ok: true, value };
  }
  return { ok: false, errors: normalizeErrors(validate.errors) };
}

export {
  sceneChangeSetSchema,
  sceneChangeSetV02Schema,
  sceneChangeSetV03Schema,
  sceneChangeSetV04Schema,
  sceneSpecSchema,
  sceneSpecV03Schema,
  sceneSpecV04Schema,
  sceneSpecV05Schema,
};
