export type ManifestDifferenceCode =
  | "MISSING_NODE"
  | "UNEXPECTED_NODE"
  | "TYPE_MISMATCH"
  | "POSITION_MISMATCH"
  | "ROTATION_MISMATCH"
  | "DIMENSION_MISMATCH"
  | "HOST_MISMATCH"
  | "CAMERA_MISMATCH"
  | "MATERIAL_ID_MISMATCH"
  | "ASSET_DEFINITION_ID_MISMATCH"
  | "MATERIAL_COLOR_MISMATCH"
  | "LOCK_MISMATCH"
  | "UNIT_MISMATCH"
  | "LOGICAL_ID_MISSING";

export interface ManifestDifference {
  code: ManifestDifferenceCode;
  path: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface ManifestTolerances {
  geometryToleranceMm: number;
  transformToleranceMm: number;
  rotationToleranceDeg: number;
}

interface SemanticManifest {
  manifestVersion: string;
  projectId: string;
  sceneId: string;
  revisionId: string;
  coordinateSystem: Record<string, unknown>;
  nodes: Array<Record<string, unknown>>;
  cameras: Array<Record<string, unknown>>;
}

const materialColorTolerance = 0.01;

function normalizeLocks(value: unknown): Record<string, true> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    ["geometry", "transform", "material"]
      .filter((property) => (value as Record<string, unknown>)[property] === true)
      .map((property) => [property, true]),
  ) as Record<string, true>;
}

function difference(
  differences: ManifestDifference[],
  code: ManifestDifferenceCode,
  path: string,
  expected: unknown,
  actual: unknown,
): void {
  differences.push({
    code,
    path,
    expected,
    actual,
    message: `${code} at ${path}`,
  });
}

function compareNumber(
  differences: ManifestDifference[],
  code: ManifestDifferenceCode,
  path: string,
  expected: unknown,
  actual: unknown,
  tolerance: number,
): void {
  if (
    typeof expected !== "number" ||
    typeof actual !== "number" ||
    !Number.isFinite(actual) ||
    Math.abs(expected - actual) > tolerance
  ) {
    difference(differences, code, path, expected, actual);
  }
}

function compareVector(
  differences: ManifestDifference[],
  code: ManifestDifferenceCode,
  path: string,
  expected: unknown,
  actual: unknown,
  tolerance: number,
): void {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
    difference(differences, code, path, expected, actual);
    return;
  }
  for (let index = 0; index < expected.length; index += 1) {
    compareNumber(differences, code, `${path}/${index}`, expected[index], actual[index], tolerance);
  }
}

function compareExact(
  differences: ManifestDifference[],
  code: ManifestDifferenceCode,
  path: string,
  expected: unknown,
  actual: unknown,
): void {
  if (!isDeepStrictEqual(expected, actual)) {
    difference(differences, code, path, expected, actual);
  }
}

function compareTransform(
  differences: ManifestDifference[],
  path: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  tolerances: ManifestTolerances,
): void {
  compareVector(
    differences,
    "POSITION_MISMATCH",
    `${path}/position`,
    expected.position,
    actual.position,
    tolerances.transformToleranceMm,
  );
  compareVector(
    differences,
    "ROTATION_MISMATCH",
    `${path}/rotationEuler`,
    expected.rotationEuler,
    actual.rotationEuler,
    tolerances.rotationToleranceDeg,
  );
  compareVector(
    differences,
    "POSITION_MISMATCH",
    `${path}/scale`,
    expected.scale,
    actual.scale,
    tolerances.transformToleranceMm,
  );
}

function indexByLogicalId(
  values: Array<Record<string, unknown>>,
  collection: "nodes" | "cameras",
  differences: ManifestDifference[],
): Map<string, Record<string, unknown>> {
  const indexed = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as Record<string, unknown>;
    if (typeof value.logicalId !== "string" || value.logicalId.length === 0) {
      difference(
        differences,
        "LOGICAL_ID_MISSING",
        `/${collection}/${index}/logicalId`,
        "non-empty logicalId",
        value.logicalId,
      );
      continue;
    }
    if (indexed.has(value.logicalId)) {
      difference(
        differences,
        "UNEXPECTED_NODE",
        `/${collection}/${value.logicalId}`,
        "unique logicalId",
        "duplicate logicalId",
      );
      continue;
    }
    indexed.set(value.logicalId, value);
  }
  return indexed;
}

function compareNode(
  differences: ManifestDifference[],
  logicalId: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  tolerances: ManifestTolerances,
): void {
  const path = `/nodes/${logicalId}`;
  compareExact(differences, "TYPE_MISMATCH", `${path}/type`, expected.type, actual.type);
  compareExact(
    differences,
    "TYPE_MISMATCH",
    `${path}/nodeName`,
    expected.nodeName,
    actual.nodeName,
  );
  compareTransform(
    differences,
    `${path}/transform`,
    expected.transform as Record<string, unknown>,
    actual.transform as Record<string, unknown>,
    tolerances,
  );
  compareVector(
    differences,
    "DIMENSION_MISMATCH",
    `${path}/dimensions`,
    expected.dimensions,
    actual.dimensions,
    tolerances.geometryToleranceMm,
  );
  for (const field of ["start", "end"] as const) {
    if (field in expected || field in actual) {
      compareVector(
        differences,
        "DIMENSION_MISMATCH",
        `${path}/${field}`,
        expected[field],
        actual[field],
        tolerances.geometryToleranceMm,
      );
    }
  }
  for (const field of ["offset", "sill"] as const) {
    if (field in expected || field in actual) {
      compareNumber(
        differences,
        "DIMENSION_MISMATCH",
        `${path}/${field}`,
        expected[field],
        actual[field],
        tolerances.geometryToleranceMm,
      );
    }
  }
  compareExact(
    differences,
    "MATERIAL_ID_MISMATCH",
    `${path}/materialId`,
    expected.materialId,
    actual.materialId,
  );
  if ("assetDefinitionId" in expected || "assetDefinitionId" in actual) {
    compareExact(
      differences,
      "ASSET_DEFINITION_ID_MISMATCH",
      `${path}/assetDefinitionId`,
      expected.assetDefinitionId,
      actual.assetDefinitionId,
    );
  }
  if ("materialBaseColorRgb" in expected || "materialBaseColorRgb" in actual) {
    compareVector(
      differences,
      "MATERIAL_COLOR_MISMATCH",
      `${path}/materialBaseColorRgb`,
      expected.materialBaseColorRgb,
      actual.materialBaseColorRgb,
      materialColorTolerance,
    );
  }
  // Manifest lock omission is canonical false. Only active lock categories are emitted.
  compareExact(
    differences,
    "LOCK_MISMATCH",
    `${path}/locks`,
    normalizeLocks(expected.locks),
    normalizeLocks(actual.locks),
  );
  compareExact(
    differences,
    "HOST_MISMATCH",
    `${path}/hostGeometryId`,
    expected.hostGeometryId,
    actual.hostGeometryId,
  );
  compareExact(
    differences,
    "LOGICAL_ID_MISSING",
    `${path}/embeddedMetadata`,
    expected.embeddedMetadata,
    actual.embeddedMetadata,
  );
}

function compareCamera(
  differences: ManifestDifference[],
  logicalId: string,
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  tolerances: ManifestTolerances,
): void {
  const path = `/cameras/${logicalId}`;
  compareExact(
    differences,
    "CAMERA_MISMATCH",
    `${path}/nodeName`,
    expected.nodeName,
    actual.nodeName,
  );
  compareTransform(
    differences,
    `${path}/transform`,
    expected.transform as Record<string, unknown>,
    actual.transform as Record<string, unknown>,
    tolerances,
  );
  compareVector(
    differences,
    "CAMERA_MISMATCH",
    `${path}/target`,
    expected.target,
    actual.target,
    tolerances.transformToleranceMm,
  );
  for (const field of ["focalLengthMm", "sensorWidthMm"] as const) {
    compareNumber(
      differences,
      "CAMERA_MISMATCH",
      `${path}/${field}`,
      expected[field],
      actual[field],
      tolerances.geometryToleranceMm,
    );
  }
  compareExact(
    differences,
    "LOGICAL_ID_MISSING",
    `${path}/embeddedMetadata`,
    expected.embeddedMetadata,
    actual.embeddedMetadata,
  );
}

export function compareSceneManifests(
  expectedValue: Record<string, unknown>,
  actualValue: Record<string, unknown>,
  tolerances: ManifestTolerances,
): { ok: true; differences: [] } | { ok: false; differences: ManifestDifference[] } {
  const expected = expectedValue as unknown as SemanticManifest;
  const actual = actualValue as unknown as SemanticManifest;
  const differences: ManifestDifference[] = [];
  for (const field of ["manifestVersion", "projectId", "sceneId", "revisionId"] as const) {
    compareExact(differences, "TYPE_MISMATCH", `/${field}`, expected[field], actual[field]);
  }
  compareExact(
    differences,
    "UNIT_MISMATCH",
    "/coordinateSystem",
    expected.coordinateSystem,
    actual.coordinateSystem,
  );

  const expectedNodes = indexByLogicalId(expected.nodes, "nodes", differences);
  const actualNodes = indexByLogicalId(actual.nodes, "nodes", differences);
  for (const [logicalId, expectedNode] of expectedNodes) {
    const actualNode = actualNodes.get(logicalId);
    if (!actualNode) {
      difference(differences, "MISSING_NODE", `/nodes/${logicalId}`, expectedNode, undefined);
      continue;
    }
    compareNode(differences, logicalId, expectedNode, actualNode, tolerances);
  }
  for (const [logicalId, actualNode] of actualNodes) {
    if (!expectedNodes.has(logicalId)) {
      difference(differences, "UNEXPECTED_NODE", `/nodes/${logicalId}`, undefined, actualNode);
    }
  }

  const expectedCameras = indexByLogicalId(expected.cameras, "cameras", differences);
  const actualCameras = indexByLogicalId(actual.cameras, "cameras", differences);
  for (const [logicalId, expectedCamera] of expectedCameras) {
    const actualCamera = actualCameras.get(logicalId);
    if (!actualCamera) {
      difference(differences, "MISSING_NODE", `/cameras/${logicalId}`, expectedCamera, undefined);
      continue;
    }
    compareCamera(differences, logicalId, expectedCamera, actualCamera, tolerances);
  }
  for (const [logicalId, actualCamera] of actualCameras) {
    if (!expectedCameras.has(logicalId)) {
      difference(differences, "UNEXPECTED_NODE", `/cameras/${logicalId}`, undefined, actualCamera);
    }
  }

  differences.sort((left, right) => {
    const leftKey = `${left.path}\u0000${left.code}`;
    const rightKey = `${right.path}\u0000${right.code}`;
    return leftKey.localeCompare(rightKey);
  });
  return differences.length === 0 ? { ok: true, differences: [] } : { ok: false, differences };
}

import { isDeepStrictEqual } from "node:util";
