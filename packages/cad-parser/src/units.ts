import { CadSourceError, type CadSourceUnits, type CadUnitName } from "./types.js";

/**
 * `$INSUNITS` is the single v0.1 unit authority. Only these codes are
 * supported; every other value (including 0 = unitless) fails closed. Units
 * are never guessed from extents, text, layer names, or file names.
 */
const SUPPORTED_INSUNITS: ReadonlyMap<number, { name: CadUnitName; scaleToMillimeters: number }> =
  new Map([
    [1, { name: "inches", scaleToMillimeters: 25.4 }],
    [2, { name: "feet", scaleToMillimeters: 304.8 }],
    [4, { name: "millimeters", scaleToMillimeters: 1 }],
    [5, { name: "centimeters", scaleToMillimeters: 10 }],
    [6, { name: "meters", scaleToMillimeters: 1000 }],
  ]);

export const SUPPORTED_INSUNITS_CODES: readonly number[] = [...SUPPORTED_INSUNITS.keys()];

export function resolveSourceUnits(insunitsCode: number | null): CadSourceUnits {
  if (insunitsCode === null || insunitsCode === 0) {
    throw new CadSourceError(
      "CAD_UNITS_UNSPECIFIED",
      insunitsCode === null
        ? "DXF header does not declare $INSUNITS; source units cannot be established"
        : "DXF header declares $INSUNITS = 0 (unitless); source units cannot be established",
      { insunitsCode },
    );
  }
  const unit = SUPPORTED_INSUNITS.get(insunitsCode);
  if (!unit) {
    throw new CadSourceError(
      "CAD_UNITS_UNSUPPORTED",
      `DXF $INSUNITS code ${insunitsCode} is not supported by cad-document-v0.1`,
      { insunitsCode, supportedCodes: SUPPORTED_INSUNITS_CODES },
    );
  }
  return { insunitsCode, name: unit.name, scaleToMillimeters: unit.scaleToMillimeters };
}

/**
 * Deterministic length conversion: one multiplication by the exact scale,
 * no rounding. Negative zero is normalized to zero so the document is
 * JSON-round-trip stable; non-finite results fail closed.
 */
export function toMillimeters(value: number, units: CadSourceUnits, context: string): number {
  const scaled = value * units.scaleToMillimeters;
  if (!Number.isFinite(scaled)) {
    throw new CadSourceError(
      "CAD_NUMERIC_NON_FINITE",
      `${context} is not finite after conversion to millimeters`,
      { context },
    );
  }
  return scaled === 0 ? 0 : scaled;
}
