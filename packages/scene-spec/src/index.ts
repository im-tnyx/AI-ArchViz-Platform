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
          : validateV02;
  if (
    validate(value) &&
    (version === "0.1.0" || version === "0.2.0" || version === "0.3.0" || version === "0.4.0")
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
function validateCirculationRequirements(value: SceneSpec): ContractValidationError[] {
  const scene = value as {
    spaces: Array<{ id: string }>;
    geometry: Array<{ id: string; type: string; spaceId?: string }>;
    openings: Array<{ id: string; type: string; hostGeometryId: string }>;
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
      if (hosts.length !== 1 || host?.type !== "wall") {
        errors.push({
          instancePath: endpointPath,
          keyword: "circulationRequirementOpeningHost",
          message: "door host must resolve to exactly one wall",
          params: { openingId: opening.id, hostGeometryId: opening.hostGeometryId },
        });
        continue;
      }
      if (host.spaceId !== requirement.spaceId) {
        errors.push({
          instancePath: endpointPath,
          keyword: "circulationRequirementOpeningSpace",
          message: "door host wall must belong to the requirement space",
          params: {
            openingId: opening.id,
            requirementSpaceId: requirement.spaceId,
            hostSpaceId: host.spaceId,
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
};
