import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { ArchitecturalExtraction, CadInterpretationProfile } from "./types.js";

export interface InterpretationContractError {
  instancePath: string;
  keyword: string;
  message: string;
}

export type InterpretationValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: InterpretationContractError[] };

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

export const cadInterpretationProfileSchema = readSchema(
  "cad-interpretation-profile-v0.1.schema.json",
);
export const architecturalExtractionSchema = readSchema(
  "architectural-extraction-v0.1.schema.json",
);

// Provenance maps are a shared `$ref` object whose required keys are listed
// beside the reference; that is valid 2020-12, so strictRequired is off.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  strictRequired: false,
});
addFormatsModule.default.default(ajv);
const profileValidator = ajv.compile(
  cadInterpretationProfileSchema,
) as ValidateFunction<CadInterpretationProfile>;
const extractionValidator = ajv.compile(
  architecturalExtractionSchema,
) as ValidateFunction<ArchitecturalExtraction>;

function normalizeErrors(errors: ErrorObject[] | null | undefined): InterpretationContractError[] {
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

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

/**
 * Schema validation plus the profile's semantic invariants: one role per
 * layer, globally unique rule IDs, unique label texts, and unique block
 * names across door and window rules (so every source value maps to at
 * most one meaning).
 */
export function validateCadInterpretationProfile(
  value: unknown,
): InterpretationValidationResult<CadInterpretationProfile> {
  if (!profileValidator(value)) {
    return { ok: false, errors: normalizeErrors(profileValidator.errors) };
  }
  const profile = value;
  const errors: InterpretationContractError[] = [];
  const semantic = (instancePath: string, message: string) =>
    errors.push({ instancePath, keyword: "semantic", message });
  if (duplicates(Object.values(profile.layers)).length > 0) {
    semantic("/layers", "each layer may carry exactly one architectural role");
  }
  const ruleIds = [
    ...profile.spaceLabelRules.map((rule) => rule.ruleId),
    ...profile.doorRules.map((rule) => rule.ruleId),
    ...profile.windowRules.map((rule) => rule.ruleId),
  ];
  for (const ruleId of duplicates(ruleIds)) semantic("", `duplicate ruleId ${ruleId}`);
  for (const text of duplicates(profile.spaceLabelRules.map((rule) => rule.text))) {
    semantic("/spaceLabelRules", `duplicate label text ${JSON.stringify(text)}`);
  }
  const blockNames = [...profile.doorRules, ...profile.windowRules].map((rule) => rule.blockName);
  for (const blockName of duplicates(blockNames)) {
    semantic("", `block ${JSON.stringify(blockName)} is mapped more than once`);
  }
  return errors.length === 0 ? { ok: true, value: profile } : { ok: false, errors };
}

export function validateArchitecturalExtraction(
  value: unknown,
): InterpretationValidationResult<ArchitecturalExtraction> {
  if (extractionValidator(value)) return { ok: true, value };
  return { ok: false, errors: normalizeErrors(extractionValidator.errors) };
}
