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
const changeSetSchemaUrl = new URL("../schema/scene-change-set-v0.1.schema.json", import.meta.url);
const changeSetV02SchemaUrl = new URL(
  "../schema/scene-change-set-v0.2.schema.json",
  import.meta.url,
);
const changeSetV03SchemaUrl = new URL(
  "../schema/scene-change-set-v0.3.schema.json",
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

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormatsModule.default.default(ajv);

const validateV01 = ajv.compile(sceneSpecV01Schema) as ValidateFunction<SceneSpec>;
const validateV02 = ajv.compile(sceneSpecSchema) as ValidateFunction<SceneSpec>;
const validateV03 = ajv.compile(sceneSpecV03Schema) as ValidateFunction<SceneSpec>;
const validateChangeSet = ajv.compile(sceneChangeSetSchema) as ValidateFunction<SceneChangeSet>;
const validateChangeSetV02 = ajv.compile(
  sceneChangeSetV02Schema,
) as ValidateFunction<SceneChangeSet>;
const validateChangeSetV03 = ajv.compile(
  sceneChangeSetV03Schema,
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
    version === "0.1.0" ? validateV01 : version === "0.3.0" ? validateV03 : validateV02;
  if (validate(value) && (version === "0.1.0" || version === "0.2.0" || version === "0.3.0")) {
    if (version === "0.2.0" || version === "0.3.0") {
      const identityErrors = validateAssetIdentity(value);
      if (identityErrors.length > 0) return { ok: false, errors: identityErrors };
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
          : null;
  if (!validate) {
    return {
      ok: false,
      errors: [
        {
          instancePath: "/schemaVersion",
          keyword: "unsupportedSchemaVersion",
          message: "schemaVersion must be one of: 0.1.0, 0.2.0, 0.3.0",
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
  sceneSpecSchema,
  sceneSpecV03Schema,
};
