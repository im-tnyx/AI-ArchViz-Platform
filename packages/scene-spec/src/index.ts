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

const schemaUrl = new URL("../schema/scene-spec-v0.1.schema.json", import.meta.url);
const changeSetSchemaUrl = new URL("../schema/scene-change-set-v0.1.schema.json", import.meta.url);
const sceneSpecSchema = JSON.parse(readFileSync(schemaUrl, "utf8")) as Record<string, unknown>;
const sceneChangeSetSchema = JSON.parse(readFileSync(changeSetSchemaUrl, "utf8")) as Record<
  string,
  unknown
>;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormatsModule.default.default(ajv);

const validate = ajv.compile(sceneSpecSchema) as ValidateFunction<SceneSpec>;
const validateChangeSet = ajv.compile(sceneChangeSetSchema) as ValidateFunction<SceneChangeSet>;

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
  if (validate(value)) {
    return { ok: true, value };
  }

  return { ok: false, errors: normalizeErrors(validate.errors) };
}

export function validateSceneChangeSet(value: unknown): ValidationResult<SceneChangeSet> {
  if (validateChangeSet(value)) {
    return { ok: true, value };
  }
  return { ok: false, errors: normalizeErrors(validateChangeSet.errors) };
}

export { sceneChangeSetSchema, sceneSpecSchema };
