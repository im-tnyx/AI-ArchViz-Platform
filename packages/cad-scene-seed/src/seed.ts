import {
  type ArchitecturalExtraction,
  semanticHash,
  validateArchitecturalExtraction,
} from "@ai-archviz/cad-interpreter";
import { type SceneSpec, validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  CAD_SCENE_SEED_EXTENSION_KEY,
  CAD_SCENE_SEED_EXTENSION_VERSION,
  CAD_SCENE_SEED_POLICY_VERSION,
  type CadSceneSeedApproval,
  CadSceneSeedError,
  type CadSceneSeedErrorCode,
  type CandidateMapping,
  type SpaceMapping,
} from "./types.js";
import { validateCadSceneSeedApproval } from "./validate.js";

/*
 * cad-scene-seed-policy-v0.1. Fixed order:
 *   1. validate architectural-extraction-v0.1
 *   2. validate cad-scene-seed-approval-v0.1 (schema; no override fields)
 *   3. decision must be approved_as_is
 *   4. exact hash binding (extraction hash recomputed; source, CAD-document,
 *      and profile hashes and profileId cross-checked)
 *   5. mappings: sorted by candidateId, no duplicates, no unknown candidates,
 *      complete; all canonical logical IDs unique
 *   6. generate the complete SceneSpec v0.4 (architectural facts copied
 *      verbatim from the approved extraction)
 *   7. validateSceneSpec(), then non-CAD reference checks
 * Spatial (9A) and circulation (9C) validation follow at the worker boundary
 * before anything is written or built.
 */

/** Canonical coordinate system: seed-policy-owned, never user-selectable. */
const COORDINATE_SYSTEM = {
  linearUnit: "mm",
  angularUnit: "degree",
  upAxis: "Z",
  handedness: "right",
  axisConvention: "X_east_Y_north_Z_up",
  worldOrigin: [0, 0, 0],
} as const;

const IDENTITY_TRANSFORM = { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };

function fail(
  code: CadSceneSeedErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new CadSceneSeedError(code, message, details);
}

/** Unicode code-point order (the approval's required mapping order). */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) as number);
  const b = Array.from(right, (character) => character.codePointAt(0) as number);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** All-unlocked is the only v0.1 lock policy; it is written explicitly. */
function unlocked() {
  return { geometry: false, transform: false, material: false };
}

function resolveMappings<T extends CandidateMapping>(
  kind: string,
  mappings: readonly T[],
  candidateIds: readonly string[],
): Map<string, T> {
  const byCandidate = new Map<string, T>();
  for (const mapping of mappings) {
    if (byCandidate.has(mapping.candidateId)) {
      fail(
        "CAD_SCENE_SEED_MAPPING_DUPLICATE",
        `${kind} candidate ${mapping.candidateId} is mapped more than once`,
        {
          kind,
          candidateId: mapping.candidateId,
        },
      );
    }
    byCandidate.set(mapping.candidateId, mapping);
  }
  for (let index = 1; index < mappings.length; index += 1) {
    const previous = mappings[index - 1] as T;
    const current = mappings[index] as T;
    if (compareCodePoints(previous.candidateId, current.candidateId) > 0) {
      fail("CAD_SCENE_SEED_MAPPING_UNSORTED", `${kind} mappings must be sorted by candidateId`, {
        kind,
        candidateId: current.candidateId,
      });
    }
  }
  const known = new Set(candidateIds);
  for (const mapping of mappings) {
    if (!known.has(mapping.candidateId)) {
      fail(
        "CAD_SCENE_SEED_MAPPING_UNKNOWN_CANDIDATE",
        `${kind} mapping references unknown candidate ${mapping.candidateId}`,
        { kind, candidateId: mapping.candidateId },
      );
    }
  }
  const missing = candidateIds.filter((candidateId) => !byCandidate.has(candidateId));
  if (missing.length > 0) {
    fail("CAD_SCENE_SEED_MAPPING_INCOMPLETE", `${kind} candidates lack an explicit mapping`, {
      kind,
      candidateIds: missing,
    });
  }
  return byCandidate;
}

function mapped<T extends CandidateMapping>(map: Map<string, T>, candidateId: string): T {
  // Completeness was proven above; there is no fallback identity.
  return map.get(candidateId) as T;
}

export interface CreateSceneSpecSeedResult {
  sceneSpec: SceneSpec;
  approvalHash: string;
  architecturalExtractionHash: string;
}

export function createSceneSpecSeed(extractionInput: unknown, approvalInput: unknown): SceneSpec {
  return createSceneSpecSeedWithHashes(extractionInput, approvalInput).sceneSpec;
}

export function createSceneSpecSeedWithHashes(
  extractionInput: unknown,
  approvalInput: unknown,
): CreateSceneSpecSeedResult {
  // 1-2. Contracts first.
  const extractionResult = validateArchitecturalExtraction(extractionInput);
  if (!extractionResult.ok) {
    fail(
      "CAD_SCENE_SEED_EXTRACTION_INVALID",
      "Input is not a valid architectural-extraction-v0.1",
      {
        errors: extractionResult.errors,
      },
    );
  }
  const approvalResult = validateCadSceneSeedApproval(approvalInput);
  if (!approvalResult.ok) {
    fail("CAD_SCENE_SEED_APPROVAL_INVALID", "Input is not a valid cad-scene-seed-approval-v0.1", {
      errors: approvalResult.errors,
    });
  }
  const extraction: ArchitecturalExtraction = extractionResult.value;
  const approval: CadSceneSeedApproval = approvalResult.value;

  // 3. READY_FOR_REVIEW is not approval; only an explicit approved_as_is is.
  if (approval.decision !== "approved_as_is") {
    fail(
      "CAD_SCENE_SEED_NOT_APPROVED",
      `Approval decision ${approval.decision} is not canonicalizable`,
      {
        decision: approval.decision,
      },
    );
  }

  // 4. Exact extraction binding.
  const architecturalExtractionHash = semanticHash(extraction);
  const bound = approval.extraction;
  const mismatches = [
    ["architecturalExtractionHash", bound.architecturalExtractionHash, architecturalExtractionHash],
    ["sourceHash", bound.sourceHash, extraction.source.sourceHash],
    ["cadDocumentHash", bound.cadDocumentHash, extraction.source.cadDocumentHash],
    ["profileHash", bound.profileHash, extraction.profileHash],
    ["profileId", bound.profileId, extraction.profileId],
  ].filter(([, approved, actual]) => approved !== actual);
  if (mismatches.length > 0) {
    fail(
      "CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH",
      "Approval does not bind this exact architectural extraction (stale or foreign approval)",
      { fields: mismatches.map(([field]) => field) },
    );
  }

  // 5. Explicit, complete, unique mappings; canonical IDs only from approval.
  const levels = resolveMappings("level", approval.mappings.levels, [
    extraction.level.levelCandidateId,
  ]);
  const spaces = resolveMappings<SpaceMapping>(
    "space",
    approval.mappings.spaces,
    extraction.spaces.map((space) => space.candidateId),
  );
  const walls = resolveMappings(
    "wall",
    approval.mappings.walls,
    extraction.walls.map((wall) => wall.candidateId),
  );
  const openings = resolveMappings(
    "opening",
    approval.mappings.openings,
    extraction.openings.map((opening) => opening.candidateId),
  );
  const state = approval.nonCadState;
  const logicalIds = [
    ...approval.mappings.levels.map((mapping) => mapping.logicalId),
    ...approval.mappings.spaces.flatMap((mapping) => [
      mapping.logicalId,
      mapping.floorSurfaceId,
      mapping.ceilingSurfaceId,
    ]),
    ...approval.mappings.walls.map((mapping) => mapping.logicalId),
    ...approval.mappings.openings.map((mapping) => mapping.logicalId),
    ...[...state.assets, ...state.cameras, ...state.lights].map((entry) => String(entry.id)),
  ];
  const seen = new Set<string>();
  for (const logicalId of logicalIds) {
    if (seen.has(logicalId)) {
      fail(
        "CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE",
        `Canonical logical ID ${logicalId} is used twice`,
        {
          logicalId,
        },
      );
    }
    seen.add(logicalId);
  }

  // 6. Generate. Architectural facts are copied verbatim from the extraction.
  const level = extraction.level;
  const levelId = mapped(levels, level.levelCandidateId).logicalId;
  const elevate = ([x, y]: [number, number], z: number) => [x, y, z];
  const spaceId = (candidateId: string) => mapped(spaces, candidateId).logicalId;
  const wallId = (candidateId: string) => mapped(walls, candidateId).logicalId;

  const sceneSpaces = extraction.spaces.map((space) => ({
    id: spaceId(space.candidateId),
    levelId,
    type: space.spaceType,
    boundary: space.boundary.map((point) => elevate(point, space.floorElevationMm)),
    boundaryWinding: space.boundaryWinding,
    floorElevation: space.floorElevationMm,
    ceilingHeight: space.ceilingHeightMm,
    transform: structuredClone(IDENTITY_TRANSFORM),
  }));
  const sceneWalls = extraction.walls.map((wall) => ({
    id: wallId(wall.candidateId),
    type: "wall",
    levelId,
    spaceId: spaceId(wall.spaceCandidateId),
    start: elevate(wall.start, level.elevationMm),
    end: elevate(wall.end, level.elevationMm),
    baseElevation: wall.baseElevationMm,
    height: wall.heightMm,
    thickness: wall.thicknessMm,
    referenceLine: wall.referenceLine,
    thicknessDirection: wall.thicknessDirection,
    transform: structuredClone(IDENTITY_TRANSFORM),
    locks: unlocked(),
  }));
  const surfaces = extraction.spaces.flatMap((space) => {
    const mapping = mapped(spaces, space.candidateId);
    const boundary = space.boundary.map((point) => elevate(point, space.floorElevationMm));
    const ceilingElevation = space.floorElevationMm + space.ceilingHeightMm;
    const surface = (id: string, type: "floor" | "ceiling", elevation: number) => ({
      id,
      type,
      levelId,
      spaceId: mapping.logicalId,
      boundary: structuredClone(boundary),
      elevation,
      thickness: 0,
      extrusionDirection: "none",
      transform: { position: [0, 0, elevation], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      locks: unlocked(),
    });
    return [
      surface(mapping.floorSurfaceId, "floor", space.floorElevationMm),
      surface(mapping.ceilingSurfaceId, "ceiling", ceilingElevation),
    ];
  });
  const sceneOpenings = extraction.openings.map((opening) => {
    // Host relationship is 10B's; it is mapped, never re-resolved here.
    const common = {
      id: mapped(openings, opening.candidateId).logicalId,
      type: opening.type,
      hostGeometryId: wallId(opening.hostWallCandidateId),
      offset: opening.offsetMm,
      width: opening.widthMm,
      sill: opening.sillMm,
      height: opening.heightMm,
    };
    // Existing SceneSpec opening convention: position = [offset, 0, sill].
    const transform = {
      position: [opening.offsetMm, 0, opening.sillMm],
      rotationEuler: [0, 0, 0],
      scale: [1, 1, 1],
    };
    return opening.type === "door"
      ? {
          ...common,
          hingeSide: opening.hingeSide,
          swingDirection: opening.swingDirection,
          transform,
          locks: unlocked(),
        }
      : { ...common, transform, locks: unlocked() };
  });

  const approvalHash = semanticHash(approval);
  const byCandidateId = <T extends CandidateMapping>(items: readonly T[]) =>
    structuredClone([...items]);
  const sceneSpec: SceneSpec = {
    sceneSpecVersion: "0.4.0",
    project: structuredClone(approval.canonical.project),
    scene: {
      id: approval.canonical.scene.id,
      revisionId: approval.canonical.scene.revisionId,
      headRevisionId: approval.canonical.scene.revisionId,
    },
    coordinateSystem: structuredClone(COORDINATE_SYSTEM),
    sources: structuredClone(state.sources),
    levels: [
      {
        id: levelId,
        name: level.name,
        elevation: level.elevationMm,
        defaultCeilingHeight: level.defaultCeilingHeightMm,
      },
    ],
    spaces: sceneSpaces,
    geometry: [...sceneWalls, ...surfaces],
    openings: sceneOpenings,
    assetDefinitions: structuredClone(state.assetDefinitions),
    assets: structuredClone(state.assets),
    materials: structuredClone(state.materials),
    materialAssignments: structuredClone(state.materialAssignments),
    cameras: structuredClone(state.cameras),
    render: structuredClone(state.render),
    // An initial canonical seed: one committed revision, no parent.
    revisions: [
      {
        revisionId: approval.canonical.scene.revisionId,
        parentRevisionId: null,
        status: "committed",
        createdAt: approval.canonical.scene.createdAt,
      },
    ],
    extensions: {
      [CAD_SCENE_SEED_EXTENSION_KEY]: {
        version: CAD_SCENE_SEED_EXTENSION_VERSION,
        canonicalizationPolicy: CAD_SCENE_SEED_POLICY_VERSION,
        approvalId: approval.approvalId,
        approvalHash,
        profileId: extraction.profileId,
        sourceHash: extraction.source.sourceHash,
        cadDocumentHash: extraction.source.cadDocumentHash,
        profileHash: extraction.profileHash,
        architecturalExtractionHash,
        mappings: {
          levels: byCandidateId(approval.mappings.levels),
          spaces: byCandidateId(approval.mappings.spaces),
          walls: byCandidateId(approval.mappings.walls),
          openings: byCandidateId(approval.mappings.openings),
        },
      },
    },
    lights: structuredClone(state.lights),
    circulationRequirements: structuredClone(state.circulationRequirements),
  };

  // 7. The generated seed must satisfy SceneSpec v0.4 and its references.
  const sceneResult = validateSceneSpec(sceneSpec);
  if (!sceneResult.ok) {
    fail("CAD_SCENE_SEED_SCENESPEC_INVALID", "Generated seed is not a valid SceneSpec v0.4", {
      errors: sceneResult.errors,
    });
  }
  assertReferences(sceneSpec);
  assertSourceMetadata(sceneSpec, extraction.source.sourceHash);
  return { sceneSpec, approvalHash, architecturalExtractionHash };
}

/**
 * Source metadata is approval-supplied but must describe THIS source: a dxf
 * source content-addressed as urn:sha256:<raw DXF byte hash>. No source URI
 * may be a local filesystem path (canonical identity is content hashes).
 */
function assertSourceMetadata(sceneSpec: SceneSpec, sourceHash: string): void {
  const sources = sceneSpec.sources as { type: string; uri: string }[];
  const contentAddress = `urn:sha256:${sourceHash.slice("sha256:".length)}`;
  // Drive-letter, absolute, UNC, file:, relative (./ ../), or home (~) paths.
  const localPath = /^(?:[A-Za-z]:[\\/]|[\\/]|file:|\.{1,2}[\\/]|~)/iu;
  const pathSources = sources.filter((source) => localPath.test(source.uri));
  if (pathSources.length > 0) {
    fail(
      "CAD_SCENE_SEED_SOURCE_INVALID",
      "Source metadata must not contain a local filesystem path",
    );
  }
  if (!sources.some((source) => source.type === "dxf" && source.uri === contentAddress)) {
    fail(
      "CAD_SCENE_SEED_SOURCE_INVALID",
      "Source metadata must include the dxf source content-addressed by the approved sourceHash",
      { expectedUri: contentAddress },
    );
  }
}

function assertReferences(sceneSpec: SceneSpec): void {
  const ids = (key: string) =>
    new Set(((sceneSpec[key] as SceneSpec[] | undefined) ?? []).map((entry) => String(entry.id)));
  const spaceIds = ids("spaces");
  const geometryIds = ids("geometry");
  const materialIds = ids("materials");
  const targetIds = new Set([...geometryIds, ...ids("openings"), ...ids("assets")]);
  const problems: string[] = [];
  for (const asset of (sceneSpec.assets as SceneSpec[]) ?? []) {
    if (!spaceIds.has(String(asset.spaceId))) problems.push(`asset ${String(asset.id)} spaceId`);
    if (asset.hostGeometryId !== undefined && !geometryIds.has(String(asset.hostGeometryId))) {
      problems.push(`asset ${String(asset.id)} hostGeometryId`);
    }
  }
  for (const camera of (sceneSpec.cameras as SceneSpec[]) ?? []) {
    if (!spaceIds.has(String(camera.spaceId))) problems.push(`camera ${String(camera.id)} spaceId`);
  }
  for (const assignment of (sceneSpec.materialAssignments as SceneSpec[]) ?? []) {
    if (
      !targetIds.has(String(assignment.targetId)) ||
      !materialIds.has(String(assignment.materialId))
    ) {
      problems.push(`materialAssignment ${String(assignment.id)}`);
    }
  }
  if (problems.length > 0) {
    fail("CAD_SCENE_SEED_REFERENCE_INVALID", "Approved non-CAD state references unknown objects", {
      problems,
    });
  }
}
