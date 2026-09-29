import { readFileSync } from "node:fs";
import { sceneSpecV04Schema, sceneSpecV05Schema } from "@ai-archviz/scene-spec";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { CadSceneSeedApproval, CadSceneSeedApprovalV02 } from "./types.js";

export interface SeedContractError {
  instancePath: string;
  keyword: string;
  message: string;
}

export type SeedValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: SeedContractError[] };

export const cadSceneSeedApprovalSchema = JSON.parse(
  readFileSync(
    new URL("../schema/cad-scene-seed-approval-v0.1.schema.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

// The approval reuses the NORMATIVE SceneSpec v0.4 $defs (source, asset,
// camera, renderIntent, ...) by reference instead of duplicating them.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
addFormatsModule.default.default(ajv);
ajv.addSchema(sceneSpecV04Schema);
ajv.addSchema(sceneSpecV05Schema);
const approvalValidator = ajv.compile(
  cadSceneSeedApprovalSchema,
) as ValidateFunction<CadSceneSeedApproval>;

function normalizeErrors(errors: ErrorObject[] | null | undefined): SeedContractError[] {
  return (errors ?? [])
    .map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? "Schema validation failed",
    }))
    .sort((left, right) =>
      `${left.instancePath}\u0000${left.keyword}\u0000${left.message}`.localeCompare(
        `${right.instancePath}\u0000${right.keyword}\u0000${right.message}`,
        "en",
      ),
    );
}

export function validateCadSceneSeedApproval(
  value: unknown,
): SeedValidationResult<CadSceneSeedApproval> {
  if (approvalValidator(value)) return { ok: true, value };
  return { ok: false, errors: normalizeErrors(approvalValidator.errors) };
}

export const cadSceneSeedApprovalV02Schema = JSON.parse(
  readFileSync(
    new URL("../schema/cad-scene-seed-approval-v0.2.schema.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

// v0.2 reuses the NORMATIVE SceneSpec v0.5 $defs (circulation-policy-v0.2 requirements).
const approvalV02Validator = ajv.compile(
  cadSceneSeedApprovalV02Schema,
) as ValidateFunction<CadSceneSeedApprovalV02>;

export function validateCadSceneSeedApprovalV02(
  value: unknown,
): SeedValidationResult<CadSceneSeedApprovalV02> {
  if (approvalV02Validator(value)) return { ok: true, value };
  return { ok: false, errors: normalizeErrors(approvalV02Validator.errors) };
}
