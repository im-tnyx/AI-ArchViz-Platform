import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import { DxfSourceAdapter, type DxfSourceAdapterOptions } from "./dxf-adapter.js";
import type { CadDocument } from "./types.js";

export {
  CAD_SOURCE_MAX_BYTES,
  DxfSourceAdapter,
  type DxfSourceAdapterOptions,
} from "./dxf-adapter.js";
export { assembleCadDocument, type CadDocumentParts, compareCodePoints } from "./normalize.js";
export * from "./types.js";
export { resolveSourceUnits, SUPPORTED_INSUNITS_CODES, toMillimeters } from "./units.js";

export interface CadContractValidationError {
  instancePath: string;
  keyword: string;
  message: string;
}

export type CadValidationResult =
  | { ok: true; value: CadDocument }
  | { ok: false; errors: CadContractValidationError[] };

export const cadDocumentSchema = JSON.parse(
  readFileSync(new URL("../schema/cad-document-v0.1.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
addFormatsModule.default.default(ajv);
const cadDocumentValidator = ajv.compile(cadDocumentSchema) as ValidateFunction<CadDocument>;

function normalizeErrors(errors: ErrorObject[] | null | undefined): CadContractValidationError[] {
  return (errors ?? [])
    .map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
      message: error.message ?? "Schema validation failed",
    }))
    .sort((left, right) =>
      `${left.instancePath}\u0000${left.keyword}`.localeCompare(
        `${right.instancePath}\u0000${right.keyword}`,
        "en",
      ),
    );
}

export function validateCadDocument(value: unknown): CadValidationResult {
  if (cadDocumentValidator(value)) return { ok: true, value };
  return { ok: false, errors: normalizeErrors(cadDocumentValidator.errors) };
}

/** Parse already-loaded ASCII DXF bytes into cad-document-v0.1. */
export function parseDxfSource(bytes: Uint8Array, options: DxfSourceAdapterOptions = {}) {
  return new DxfSourceAdapter(options).parse({ bytes });
}
