import { readFileSync } from "node:fs";
import { sceneSpecV04Schema } from "@ai-archviz/scene-spec";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { CadSceneSeedApproval } from "./types.js";

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
