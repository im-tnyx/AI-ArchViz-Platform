export type Vector3 = [number, number, number];

export interface ManagedMetadata {
  "AIArchViz.LogicalObjectId": string;
  "AIArchViz.ProjectId": string;
  "AIArchViz.SceneId": string;
  "AIArchViz.RevisionId": string;
  "AIArchViz.AssetDefinitionId"?: string;
}

export interface SemanticTransform {
  position: Vector3;
  rotationEuler: Vector3;
  scale: Vector3;
}

export interface BuildPlanNode {
  logicalId: string;
  nodeName: string;
  type: "wall" | "floor" | "ceiling" | "door_opening" | "window_opening" | "proxy_asset";
  transform: SemanticTransform;
  dimensions: Vector3;
  embeddedMetadata: ManagedMetadata;
  hostGeometryId?: string;
  start?: Vector3;
  end?: Vector3;
  offset?: number;
  sill?: number;
  materialId?: string;
  materialBaseColorRgb?: Vector3;
  assetDefinitionId?: string;
  locks?: Partial<Record<"geometry" | "transform" | "material", true>>;
}

export interface BuildPlanMaterial {
  id: string;
  baseColorRgb: Vector3;
}

export interface BuildPlanMaterialAssignment {
  id: string;
  targetId: string;
  materialId: string;
}

export interface WallSegment {
  name: string;
  hostLogicalId: string;
  center: Vector3;
  dimensions: Vector3;
  rotationZ: number;
}

export interface OpeningMarker {
  logicalId: string;
  position: Vector3;
}

export interface BuildPlanCamera {
  logicalId: string;
  nodeName: string;
  transform: SemanticTransform;
  target: Vector3;
  focalLengthMm: number;
  sensorWidthMm: number;
  embeddedMetadata: ManagedMetadata;
}

export interface GoldenBuildPlan {
  buildPlanVersion: "0.1.0";
  projectId: string;
  sceneId: string;
  revisionId: string;
  coordinateSystem: {
    linearUnit: "mm";
    angularUnit: "degree";
    upAxis: "Z";
    handedness: "right";
  };
  nodes: BuildPlanNode[];
  wallSegments: WallSegment[];
  openingMarkers: OpeningMarker[];
  cameras: BuildPlanCamera[];
  materials: BuildPlanMaterial[];
  materialAssignments: BuildPlanMaterialAssignment[];
}

interface SceneSpecSubset {
  project: { id: string };
  scene: { id: string; revisionId: string };
  coordinateSystem: {
    linearUnit: "mm";
    angularUnit: "degree";
    upAxis: "Z";
    handedness: "right";
  };
  geometry: Array<Record<string, unknown>>;
  openings: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  assetDefinitions: Array<Record<string, unknown>>;
  materials: Array<{ id: string; baseColorRgb: Vector3 }>;
  materialAssignments: Array<{ id: string; targetId: string; materialId: string }>;
  cameras: Array<Record<string, unknown>>;
}

interface WallInput {
  id: string;
  type: "wall";
  start: Vector3;
  end: Vector3;
  baseElevation: number;
  height: number;
  thickness: number;
  transform: SemanticTransform;
  locks: Record<string, unknown>;
}

interface OpeningInput {
  id: string;
  type: "door" | "window";
  hostGeometryId: string;
  offset: number;
  width: number;
  sill: number;
  height: number;
  transform: SemanticTransform;
  locks: Record<string, unknown>;
}

function vector(value: unknown): Vector3 {
  return [...(value as number[])] as Vector3;
}

function transform(value: unknown): SemanticTransform {
  const input = value as SemanticTransform;
  return {
    position: vector(input.position),
    rotationEuler: vector(input.rotationEuler),
    scale: vector(input.scale),
  };
}

function metadata(
  scene: SceneSpecSubset,
  logicalId: string,
  assetDefinitionId?: string,
): ManagedMetadata {
  return {
    "AIArchViz.LogicalObjectId": logicalId,
    "AIArchViz.ProjectId": scene.project.id,
    "AIArchViz.SceneId": scene.scene.id,
    "AIArchViz.RevisionId": scene.scene.revisionId,
    ...(assetDefinitionId ? { "AIArchViz.AssetDefinitionId": assetDefinitionId } : {}),
  };
}

interface AssetDefinitionInput {
  id: string;
  category: string;
  sourceType: "procedural_proxy" | "external_max";
  dimensions: Vector3;
  pivotPolicy: string;
  allowNonUniformScale: boolean;
}

function resolveAssetDefinitions(scene: SceneSpecSubset): Map<string, AssetDefinitionInput> {
  const definitions = new Map<string, AssetDefinitionInput>();
  for (const definition of scene.assetDefinitions) {
    const id = String(definition.id);
    if (definitions.has(id)) throw new Error(`Duplicate asset definition id ${id}`);
    definitions.set(id, {
      id,
      category: String(definition.category),
      sourceType: String(definition.sourceType) as AssetDefinitionInput["sourceType"],
      dimensions: vector(definition.dimensions),
      pivotPolicy: String(definition.pivotPolicy),
      allowNonUniformScale: Boolean(definition.allowNonUniformScale),
    });
  }
  return definitions;
}

function distance(start: Vector3, end: Vector3): number {
  return Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
}

export function wallFrame(wall: Pick<WallInput, "start" | "end">): {
  length: number;
  u: Vector3;
  exteriorNormal: Vector3;
} {
  const length = distance(wall.start, wall.end);
  if (length <= 0) throw new Error("Wall baseline must have positive length");
  const u: Vector3 = [
    (wall.end[0] - wall.start[0]) / length,
    (wall.end[1] - wall.start[1]) / length,
    (wall.end[2] - wall.start[2]) / length,
  ];
  const canonicalZero = (value: number): number => (Object.is(value, -0) ? 0 : value);
  return {
    length,
    u: u.map(canonicalZero) as Vector3,
    exteriorNormal: [canonicalZero(u[1]), canonicalZero(-u[0]), 0],
  };
}

export function openingWorldBounds(
  wall: WallInput,
  opening: OpeningInput,
): {
  start: Vector3;
  end: Vector3;
  bottom: number;
  top: number;
} {
  const { length, u } = wallFrame(wall);
  if (opening.offset + opening.width > length) {
    throw new Error(`Opening ${opening.id} exceeds host wall ${wall.id}`);
  }
  const at = (offset: number): Vector3 => [
    wall.start[0] + u[0] * offset,
    wall.start[1] + u[1] * offset,
    wall.start[2] + u[2] * offset,
  ];
  return {
    start: at(opening.offset),
    end: at(opening.offset + opening.width),
    bottom: wall.baseElevation + opening.sill,
    top: wall.baseElevation + opening.sill + opening.height,
  };
}

function wallSegments(wall: WallInput, openings: OpeningInput[]): WallSegment[] {
  const { length, u, exteriorNormal } = wallFrame(wall);
  const uBreaks = new Set([0, length]);
  const zBreaks = new Set([wall.baseElevation, wall.baseElevation + wall.height]);
  for (const opening of openings) {
    const bounds = openingWorldBounds(wall, opening);
    if (bounds.bottom < wall.baseElevation || bounds.top > wall.baseElevation + wall.height) {
      throw new Error(`Opening ${opening.id} exceeds host wall height`);
    }
    uBreaks.add(opening.offset);
    uBreaks.add(opening.offset + opening.width);
    zBreaks.add(bounds.bottom);
    zBreaks.add(bounds.top);
  }
  const sortedU = [...uBreaks].sort((left, right) => left - right);
  const sortedZ = [...zBreaks].sort((left, right) => left - right);
  const segments: WallSegment[] = [];
  for (let uIndex = 0; uIndex < sortedU.length - 1; uIndex += 1) {
    const u0 = sortedU[uIndex] as number;
    const u1 = sortedU[uIndex + 1] as number;
    for (let zIndex = 0; zIndex < sortedZ.length - 1; zIndex += 1) {
      const z0 = sortedZ[zIndex] as number;
      const z1 = sortedZ[zIndex + 1] as number;
      const uMid = (u0 + u1) / 2;
      const zMid = (z0 + z1) / 2;
      const insideOpening = openings.some(
        (opening) =>
          uMid > opening.offset &&
          uMid < opening.offset + opening.width &&
          zMid > wall.baseElevation + opening.sill &&
          zMid < wall.baseElevation + opening.sill + opening.height,
      );
      if (insideOpening || u1 === u0 || z1 === z0) continue;
      segments.push({
        name: `AVZ_INTERNAL_${wall.id}_${segments.length + 1}`,
        hostLogicalId: wall.id,
        center: [
          wall.start[0] + u[0] * uMid + exteriorNormal[0] * (wall.thickness / 2),
          wall.start[1] + u[1] * uMid + exteriorNormal[1] * (wall.thickness / 2),
          z0,
        ],
        dimensions: [u1 - u0, wall.thickness, z1 - z0],
        rotationZ: (Math.atan2(u[1], u[0]) * 180) / Math.PI,
      });
    }
  }
  return segments;
}

function boundaryDimensions(boundary: Vector3[]): Vector3 {
  const xs = boundary.map((point) => point[0]);
  const ys = boundary.map((point) => point[1]);
  return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0];
}

function nativeMaterialColor(value: Vector3): Vector3 {
  return value.map((channel) => Math.round(channel * 255) / 255) as Vector3;
}

function activeLocks(value: {
  locks?: unknown;
}): Partial<Record<"geometry" | "transform" | "material", true>> | undefined {
  const source = value.locks as Record<string, unknown> | undefined;
  const locks = Object.fromEntries(
    ["geometry", "transform", "material"]
      .filter((property) => source?.[property] === true)
      .map((property) => [property, true]),
  ) as Partial<Record<"geometry" | "transform" | "material", true>>;
  return Object.keys(locks).length > 0 ? locks : undefined;
}

function resolveMaterialAssignments(scene: SceneSpecSubset): {
  materials: BuildPlanMaterial[];
  assignments: BuildPlanMaterialAssignment[];
  byTarget: Map<string, BuildPlanMaterial>;
} {
  const materials = scene.materials.map((material) => ({
    id: String(material.id),
    baseColorRgb: nativeMaterialColor(vector(material.baseColorRgb)),
  }));
  const materialById = new Map<string, BuildPlanMaterial>();
  for (const material of materials) {
    if (materialById.has(material.id)) {
      throw new Error(`Duplicate material id ${material.id}`);
    }
    materialById.set(material.id, material);
  }
  const assignments = scene.materialAssignments.map((assignment) => ({
    id: String(assignment.id),
    targetId: String(assignment.targetId),
    materialId: String(assignment.materialId),
  }));
  const byTarget = new Map<string, BuildPlanMaterial>();
  for (const assignment of assignments) {
    const material = materialById.get(assignment.materialId);
    if (!material) {
      throw new Error(
        `Material assignment ${assignment.id} references missing material ${assignment.materialId}`,
      );
    }
    if (byTarget.has(assignment.targetId)) {
      throw new Error(`Duplicate material assignment target ${assignment.targetId}`);
    }
    byTarget.set(assignment.targetId, material);
  }
  return {
    materials: materials.sort((left, right) => left.id.localeCompare(right.id)),
    assignments: assignments.sort((left, right) => left.id.localeCompare(right.id)),
    byTarget,
  };
}

export function compileGoldenBuildPlan(value: Record<string, unknown>): GoldenBuildPlan {
  const scene = value as unknown as SceneSpecSubset;
  const materialResolution = resolveMaterialAssignments(scene);
  const assetDefinitions = resolveAssetDefinitions(scene);
  const walls = scene.geometry.filter((entry) => entry.type === "wall") as unknown as WallInput[];
  const surfaces = scene.geometry.filter(
    (entry) => entry.type === "floor" || entry.type === "ceiling",
  );
  const unsupportedGeometry = scene.geometry.filter(
    (entry) => !["wall", "floor", "ceiling"].includes(String(entry.type)),
  );
  if (unsupportedGeometry.length > 0) throw new Error("Unsupported geometry entity in Spike 1B");

  const openings = scene.openings as unknown as OpeningInput[];
  if (openings.some((entry) => !["door", "window"].includes(entry.type))) {
    throw new Error("Unsupported opening entity in Spike 1B");
  }
  const wallById = new Map(walls.map((wall) => [wall.id, wall]));
  for (const opening of openings) {
    if (!wallById.has(opening.hostGeometryId)) {
      throw new Error(`Opening ${opening.id} references missing host ${opening.hostGeometryId}`);
    }
  }

  const nodes: BuildPlanNode[] = [];
  const appendMaterial = <T extends BuildPlanNode>(node: T): T => {
    const material = materialResolution.byTarget.get(node.logicalId);
    return material
      ? {
          ...node,
          materialId: material.id,
          materialBaseColorRgb: structuredClone(material.baseColorRgb),
        }
      : node;
  };
  for (const wall of walls) {
    const locks = activeLocks(wall);
    nodes.push(
      appendMaterial({
        logicalId: wall.id,
        nodeName: `AVZ_${wall.id}`,
        type: "wall",
        transform: transform(wall.transform),
        dimensions: [wallFrame(wall).length, wall.thickness, wall.height],
        start: vector(wall.start),
        end: vector(wall.end),
        embeddedMetadata: metadata(scene, wall.id),
        ...(locks ? { locks } : {}),
      }),
    );
  }
  for (const surface of surfaces) {
    const logicalId = String(surface.id);
    const locks = activeLocks(surface);
    nodes.push(
      appendMaterial({
        logicalId,
        nodeName: `AVZ_${logicalId}`,
        type: surface.type as "floor" | "ceiling",
        transform: transform(surface.transform),
        dimensions: boundaryDimensions((surface.boundary as Vector3[]).map(vector)),
        embeddedMetadata: metadata(scene, logicalId),
        ...(locks ? { locks } : {}),
      }),
    );
  }
  for (const opening of openings) {
    const wall = wallById.get(opening.hostGeometryId) as WallInput;
    const locks = activeLocks(opening);
    openingWorldBounds(wall, opening);
    nodes.push(
      appendMaterial({
        logicalId: opening.id,
        nodeName: `AVZ_${opening.id}`,
        type: opening.type === "door" ? "door_opening" : "window_opening",
        transform: transform(opening.transform),
        dimensions: [opening.width, wall.thickness, opening.height],
        hostGeometryId: opening.hostGeometryId,
        offset: opening.offset,
        sill: opening.sill,
        embeddedMetadata: metadata(scene, opening.id),
        ...(locks ? { locks } : {}),
      }),
    );
  }
  for (const asset of scene.assets) {
    if (asset.type !== "proxy_asset") throw new Error("Unsupported asset entity in Spike 1B");
    const logicalId = String(asset.id);
    const assetDefinitionId = String(asset.assetDefinitionId);
    const definition = assetDefinitions.get(assetDefinitionId);
    if (!definition) {
      throw new Error(`Asset ${logicalId} references missing definition ${assetDefinitionId}`);
    }
    if (definition.sourceType !== "procedural_proxy") {
      throw new Error(
        `External asset definition ${assetDefinitionId} is not buildable in Spike 7A`,
      );
    }
    const locks = activeLocks(asset);
    nodes.push(
      appendMaterial({
        logicalId,
        nodeName: `AVZ_${logicalId}`,
        type: "proxy_asset",
        transform: transform(asset.transform),
        dimensions: structuredClone(definition.dimensions),
        assetDefinitionId,
        ...(asset.hostGeometryId ? { hostGeometryId: String(asset.hostGeometryId) } : {}),
        embeddedMetadata: metadata(scene, logicalId, assetDefinitionId),
        ...(locks ? { locks } : {}),
      }),
    );
  }

  const nodeIds = new Set(nodes.map((node) => node.logicalId));
  for (const assignment of materialResolution.assignments) {
    if (!nodeIds.has(assignment.targetId)) {
      throw new Error(
        `Material assignment ${assignment.id} references missing target ${assignment.targetId}`,
      );
    }
  }

  const cameras = scene.cameras.map((camera) => {
    if (camera.type !== "camera") throw new Error("Unsupported camera entity in Spike 1B");
    const logicalId = String(camera.id);
    return {
      logicalId,
      nodeName: `AVZ_${logicalId}`,
      transform: transform(camera.transform),
      target: vector(camera.target),
      focalLengthMm: Number(camera.focalLengthMm),
      sensorWidthMm: Number(camera.sensorWidthMm),
      embeddedMetadata: metadata(scene, logicalId),
    } satisfies BuildPlanCamera;
  });

  return {
    buildPlanVersion: "0.1.0",
    projectId: scene.project.id,
    sceneId: scene.scene.id,
    revisionId: scene.scene.revisionId,
    coordinateSystem: {
      linearUnit: scene.coordinateSystem.linearUnit,
      angularUnit: scene.coordinateSystem.angularUnit,
      upAxis: scene.coordinateSystem.upAxis,
      handedness: scene.coordinateSystem.handedness,
    },
    nodes: nodes.sort((left, right) => left.logicalId.localeCompare(right.logicalId)),
    wallSegments: walls.flatMap((wall) =>
      wallSegments(
        wall,
        openings.filter((opening) => opening.hostGeometryId === wall.id),
      ),
    ),
    openingMarkers: openings.map((opening) => {
      const wall = wallById.get(opening.hostGeometryId) as WallInput;
      const bounds = openingWorldBounds(wall, opening);
      const { exteriorNormal } = wallFrame(wall);
      return {
        logicalId: opening.id,
        position: [
          bounds.start[0] + exteriorNormal[0] * (wall.thickness / 2),
          bounds.start[1] + exteriorNormal[1] * (wall.thickness / 2),
          bounds.bottom,
        ],
      };
    }),
    cameras: cameras.sort((left, right) => left.logicalId.localeCompare(right.logicalId)),
    materials: materialResolution.materials,
    materialAssignments: materialResolution.assignments,
  };
}
