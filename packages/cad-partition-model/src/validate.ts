import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { CadTopologyApproval, ReviewedPartitionModel } from "./types.js";

export interface PartitionContractError {
  instancePath: string;
  keyword: string;
  message: string;
}

export type PartitionValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: PartitionContractError[] };

const readSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

export const cadTopologyApprovalSchema = readSchema("cad-topology-approval-v0.1.schema.json");
export const reviewedPartitionModelSchema = readSchema("reviewed-partition-model-v0.1.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false });
addFormatsModule.default.default(ajv);
const approvalValidator = ajv.compile(
  cadTopologyApprovalSchema,
) as ValidateFunction<CadTopologyApproval>;
const modelValidator = ajv.compile(
  reviewedPartitionModelSchema,
) as ValidateFunction<ReviewedPartitionModel>;

function normalizeErrors(errors: ErrorObject[] | null | undefined): PartitionContractError[] {
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

export function validateCadTopologyApproval(
  value: unknown,
): PartitionValidationResult<CadTopologyApproval> {
  if (approvalValidator(value)) return { ok: true, value };
  return { ok: false, errors: normalizeErrors(approvalValidator.errors) };
}

export function validateReviewedPartitionModel(
  value: unknown,
): PartitionValidationResult<ReviewedPartitionModel> {
  if (modelValidator(value)) return { ok: true, value };
  return { ok: false, errors: normalizeErrors(modelValidator.errors) };
}
