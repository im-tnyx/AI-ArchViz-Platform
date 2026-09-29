import { readFileSync } from "node:fs";
import { architecturalExtractionSchema } from "@ai-archviz/cad-interpreter";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { ArchitecturalTopology } from "./types.js";

export interface TopologyContractError {
  instancePath: string;
  keyword: string;
  message: string;
}

export type TopologyValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: TopologyContractError[] };

export const architecturalTopologySchema = JSON.parse(
  readFileSync(
    new URL("../schema/architectural-topology-v0.1.schema.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

// Single-space relations embed the 10B opening candidate verbatim, so the
// schema references the NORMATIVE architectural-extraction-v0.1 door/window
// definitions instead of duplicating them (same ajv options as 10B).
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictTypes: false,
  strictRequired: false,
});
addFormatsModule.default.default(ajv);
ajv.addSchema(architecturalExtractionSchema);
const topologyValidator = ajv.compile(
  architecturalTopologySchema,
) as ValidateFunction<ArchitecturalTopology>;

function normalizeErrors(errors: ErrorObject[] | null | undefined): TopologyContractError[] {
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

export function validateArchitecturalTopology(
  value: unknown,
): TopologyValidationResult<ArchitecturalTopology> {
  if (topologyValidator(value)) return { ok: true, value };
  return { ok: false, errors: normalizeErrors(topologyValidator.errors) };
}
