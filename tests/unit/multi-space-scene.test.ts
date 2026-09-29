import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ArchitecturalExtraction,
  type CadInterpretationProfile,
  interpretCadDocument,
} from "@ai-archviz/cad-interpreter";
import { type CadDocument, parseDxfSource } from "@ai-archviz/cad-parser";
import {
  type CadTopologyApproval,
  createReviewedPartitionModel,
  type ReviewedPartitionModel,
} from "@ai-archviz/cad-partition-model";
import {
  type CadSceneSeedApprovalV02,
  CadSceneSeedError,
  createMultiSpaceSceneSpecSeed,
  hostOnUnpairedSegment,
  type MultiSpaceSeedInput,
  unpairedWallSegments,
  validateCadSceneSeedApprovalV02,
} from "@ai-archviz/cad-scene-seed";
import { type ArchitecturalTopology, analyzeArchitecturalTopology } from "@ai-archviz/cad-topology";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import {
  analyzeCirculation,
  analyzeCirculationV02,
  evaluateCirculationRequirements,
  findCirculationRouteV02,
  scenePartitionSolids,
  validateSpatialScene,
  validateSpatialSceneForVersion,
  validateSpatialSceneV02,
} from "@ai-archviz/spatial-engine";
import {
  semanticJsonHash,
  validateCadSceneSeedEvidenceV02,
  validateCirculationAnalysisEvidenceV02,
  validateCirculationRequirementEvidenceV02,
  validateSpatialValidationEvidenceV02,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import { compileBuildPlanV02, compileGoldenBuildPlan } from "../../apps/worker/src/build-plan.js";
import {
  CadMultiSpaceSeedWorkerError,
  createCadMultiSpaceSeed,
} from "../../apps/worker/src/cad-multispace-seed.js";
import { circulationAnalysisEvidenceV02 } from "../../apps/worker/src/circulation-analysis.js";
import { circulationRequirementEvidenceV02 } from "../../apps/worker/src/circulation-requirement-evidence.js";
import { spatialValidationEvidenceV02 } from "../../apps/worker/src/spatial-validation.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const read = <T = Record<string, unknown>>(...parts: string[]) =>
  JSON.parse(readFileSync(join(repositoryRoot, ...parts), "utf8")) as T;
const topologyDir = "tests/fixtures/cad/topology";
const partitionDir = "tests/fixtures/cad/partition-model";
const seedDir = "tests/fixtures/cad/multispace-seed/two-room";
const profile = read<CadInterpretationProfile>(topologyDir, "profile-v0.1.json");

type Scene = Record<string, unknown> & {
  geometry: Array<Record<string, unknown>>;
  openings: Array<Record<string, unknown>>;
  spaces: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  assetDefinitions: Array<Record<string, unknown>>;
  circulationRequirements: Array<Record<string, unknown>>;
};

const seedInputs = (): MultiSpaceSeedInput & {
  sceneApproval: CadSceneSeedApprovalV02;
  reviewedPartitionModel: ReviewedPartitionModel;
} => ({
  cadDocument: read(topologyDir, "two-room", "cad-document-v0.1.json"),
  interpretationProfile: profile,
  architecturalExtraction: null,
  architecturalTopology: read(topologyDir, "two-room", "expected-architectural-topology-v0.1.json"),
  partitionApproval: read(partitionDir, "two-room", "approval-v0.1.json"),
  reviewedPartitionModel: read<ReviewedPartitionModel>(
    partitionDir,
    "two-room",
    "expected-reviewed-partition-model-v0.1.json",
  ),
  sceneApproval: read<CadSceneSeedApprovalV02>(seedDir, "scene-approval-v0.2.json"),
});
const seedScene = () => read<Scene>(seedDir, "expected-scene-spec-v0.5.json");

const FROZEN = {
  sourceHash: "sha256:6de69c56aac4cdc9e98f1a658c62974e4af8e53aff9f19382d352b7143fcab9e",
  cadDocumentHash: "sha256:7cdd0a8b9d47a74bc57edec6449594d59c4c46682b568c141475f9e84a3aaf29",
  profileHash: "sha256:120a33f5919cbc03a0c0f7db42f0770cca9645d8bfd4348d8012f269d5b63f39",
  spaceWallStageHash: "sha256:ab13a1ac0eed9d9deec986e78bb14bbe6b04aa7119467488184a76ac3083a81a",
  architecturalTopologyHash:
    "sha256:d8be5d08652116e14a7f959adf3efcd80148c7615661d2a7448fce68f74c2f59",
  partitionApprovalHash: "sha256:bcb1a14c24df3d512a2fa258f398a6cd8218d2960435cdc1a571b3351eb1f563",
  reviewedPartitionModelHash:
    "sha256:3f57213e3260437b21cc354efd1d6ed3c79bae9597ca92fe2fce59a41d8be017",
  sceneApprovalHash: "sha256:794f86595cf02585afc1ab6e7cbcf50697185e26a9d1c6872c4f6d7db8c53abb",
  sceneSpecHash: "sha256:341f67b720881d6236d8b2dca63c31671c8c64fef48f9ef299c7bc7ff851d779",
};

const partitionOf = (scene: Scene) =>
  scene.geometry.find((entry) => entry.type === "shared_partition") as Record<string, unknown> & {
    spaceFaces: Array<{ spaceId: string; side: string; start: number[]; end: number[] }>;
    adjacentSpaceIds: string[];
    start: number[];
    end: number[];
  };

const keywordsOf = (value: unknown) => {
  const result = validateSceneSpec(value);
  return result.ok ? [] : result.errors.map((error) => error.keyword);
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const PROBE_DEFINITION = {
  id: "assetdef_probe_v1",
  version: "1",
  category: "generic_proxy",
  sourceType: "procedural_proxy",
  dimensions: [60, 200, 100],
  pivotPolicy: "floor_center",
  allowNonUniformScale: false,
};

/** The seed plus one extra asset (and definition), for spatial/circulation probes. */
function withAsset(
  spaceId: string,
  position: [number, number],
  definition: Record<string, unknown> = PROBE_DEFINITION,
): Scene {
  const scene = seedScene();
  if (!scene.assetDefinitions.some((entry) => entry.id === definition.id)) {
    scene.assetDefinitions.push(structuredClone(definition));
  }
  scene.assets.push({
    id: "asset_probe",
    type: "proxy_asset",
    assetDefinitionId: definition.id,
    spaceId,
    transform: { position: [...position, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    locks: { geometry: false, transform: false, material: false },
  });
  return scene;
}

const LIVING = "space_living_main";
const BEDROOM = "space_bedroom_main";
const DOOR = "opening_d_internal_01";
const PARTITION = "partition_living_bedroom_main";

// -------------------------------------------------------- SceneSpec v0.5

describe("SceneSpec v0.5 contract", () => {
  it("dispatches every supported version explicitly and keeps history valid", () => {
    const golden = "tests/fixtures/living-room-golden";
    expect(validateSceneSpec(read(golden, "scene-spec.json")).ok).toBe(true); // v0.2
    expect(validateSceneSpec(read(golden, "revisions/rev_golden_0012/scene-spec.json")).ok).toBe(
      true,
    ); // v0.3
    expect(validateSceneSpec(read(golden, "revisions/rev_golden_0013/scene-spec.json")).ok).toBe(
      true,
    ); // v0.4
    expect(validateSceneSpec(seedScene()).ok).toBe(true); // v0.5
    expect(validateSceneSpec({ ...seedScene(), sceneSpecVersion: "0.6.0" }).ok).toBe(false);
    // (v0.1 acceptance stays covered by the circulation-requirements suite.)
  });

  it("v0.4 rejects every v0.5-only construct", () => {
    const rev13 = read<Scene>(
      "tests/fixtures/living-room-golden",
      "revisions/rev_golden_0013/scene-spec.json",
    );
    const partition = partitionOf(seedScene());
    const withPartition = structuredClone(rev13);
    withPartition.geometry.push(structuredClone(partition));
    expect(validateSceneSpec(withPartition).ok).toBe(false);
    const withPartitionDoor = structuredClone(rev13);
    withPartitionDoor.openings.push(
      structuredClone(seedScene().openings[0] as Record<string, unknown>),
    );
    expect(validateSceneSpec(withPartitionDoor).ok).toBe(false);
    expect(validateSceneSpec({ ...seedScene(), sceneSpecVersion: "0.4.0" }).ok).toBe(false);
  });

  it("freezes shared_partition schema semantics (centerline, two spaces, left then right faces)", () => {
    const mutate = (edit: (partition: ReturnType<typeof partitionOf>) => void) => {
      const scene = seedScene();
      edit(partitionOf(scene));
      return validateSceneSpec(scene).ok;
    };
    expect(mutate((p) => Object.assign(p, { referenceLine: "interior_face" }))).toBe(false);
    expect(mutate((p) => p.adjacentSpaceIds.push("space_third"))).toBe(false);
    expect(mutate((p) => p.spaceFaces.reverse())).toBe(false);
    expect(mutate((p) => p.spaceFaces.pop())).toBe(false);
    expect(mutate((p) => Object.assign(p, { spaceId: LIVING }))).toBe(false);
  });

  it("independently proves face geometry instead of trusting stored coordinates", () => {
    const faceCase = (edit: (faces: ReturnType<typeof partitionOf>["spaceFaces"]) => void) => {
      const scene = seedScene();
      edit(partitionOf(scene).spaceFaces);
      return keywordsOf(scene);
    };
    expect(faceCase((faces) => ((faces[0] as { start: number[] }).start = [2900, 0, 0]))).toContain(
      "partitionFaceGeometry",
    );
    // Reversed direction (same line, opposite traversal) is not the canonical face.
    expect(
      faceCase((faces) => {
        const face = faces[1] as { start: number[]; end: number[] };
        [face.start, face.end] = [face.end, face.start];
      }),
    ).toContain("partitionFaceGeometry");
    // Faces swapped to the wrong sides.
    expect(
      faceCase((faces) => {
        const [left, right] = faces as unknown as [{ spaceId: string }, { spaceId: string }];
        [left.spaceId, right.spaceId] = [right.spaceId, left.spaceId];
        const [l, r] = faces as unknown as [
          { start: number[]; end: number[] },
          { start: number[]; end: number[] },
        ];
        [l.start, l.end, r.start, r.end] = [r.start, r.end, l.start, l.end];
      }),
    ).toContain("partitionFaceGeometry");
    expect(faceCase((faces) => ((faces[1] as { spaceId: string }).spaceId = LIVING))).toContain(
      "partitionFaceSpaces",
    );
  });

  it("validates adjacent spaces, centerline length, and elevation", () => {
    const partitionCase = (edit: (partition: ReturnType<typeof partitionOf>) => void) => {
      const scene = seedScene();
      edit(partitionOf(scene));
      return keywordsOf(scene);
    };
    expect(partitionCase((p) => (p.adjacentSpaceIds = [LIVING, LIVING]))).toContain(
      "partitionAdjacentSpacesDistinct",
    );
    expect(partitionCase((p) => p.adjacentSpaceIds.reverse())).toContain(
      "partitionAdjacentSpacesOrder",
    );
    expect(partitionCase((p) => (p.adjacentSpaceIds[0] = "space_aaa_missing"))).toContain(
      "partitionAdjacentSpaceReference",
    );
    expect(partitionCase((p) => Object.assign(p, { levelId: "level_other" }))).toContain(
      "partitionAdjacentSpaceLevel",
    );
    expect(partitionCase((p) => (p.end = [...p.start]))).toContain("partitionCenterlineLength");
    expect(partitionCase((p) => Object.assign(p, { baseElevation: 10 }))).toContain(
      "partitionElevation",
    );
    const duplicate = seedScene();
    duplicate.geometry.push({ ...structuredClone(duplicate.geometry[0] as object) });
    expect(keywordsOf(duplicate)).toContain("uniqueLogicalId");
  });

  it("validates partition-door host, connectivity, swing space, fit, and overlap", () => {
    const openingCase = (edit: (scene: Scene) => void) => {
      const scene = seedScene();
      edit(scene);
      return keywordsOf(scene);
    };
    const door = (scene: Scene) => scene.openings[0] as Record<string, unknown>;
    expect(openingCase((s) => (door(s).connectsSpaceIds = [BEDROOM, "space_other"]))).toContain(
      "partitionOpeningConnectivity",
    );
    expect(openingCase((s) => (door(s).connectsSpaceIds = [LIVING, BEDROOM]))).toContain(
      "partitionOpeningConnectivity",
    );
    expect(openingCase((s) => (door(s).swingIntoSpaceId = "space_other"))).toContain(
      "partitionOpeningSwingSpace",
    );
    expect(openingCase((s) => (door(s).offset = 3500))).toContain("partitionOpeningFit");
    expect(openingCase((s) => (door(s).hostGeometryId = "wall_living_south"))).toContain(
      "openingHostType",
    );
    const second = (scene: Scene, offset: number) =>
      scene.openings.push({ ...structuredClone(door(scene)), id: "opening_d_internal_02", offset });
    expect(openingCase((s) => second(s, 2000))).toContain("partitionOpeningOverlap");
    // Touching jambs are allowed (1550 + 900 = 2450).
    expect(openingCase((s) => second(s, 2450))).toEqual([]);
    // A legacy wall door or a window can never be partition-hosted.
    expect(
      openingCase((s) =>
        s.openings.push({
          id: "opening_w_bad",
          type: "window",
          hostGeometryId: PARTITION,
          offset: 100,
          width: 900,
          sill: 900,
          height: 1200,
          transform: { position: [100, 0, 900], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
          locks: { geometry: false, transform: false, material: false },
        }),
      ),
    ).toContain("openingHostType");
    expect(
      openingCase((s) =>
        s.openings.push({
          id: "opening_d_legacy_bad",
          type: "door",
          hostGeometryId: PARTITION,
          offset: 100,
          width: 900,
          sill: 0,
          height: 2100,
          hingeSide: "start_jamb",
          swingDirection: "into_room",
          transform: { position: [100, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
          locks: { geometry: false, transform: false, material: false },
        }),
      ),
    ).toContain("openingHostType");
    // A legacy wall door stays valid on a regular wall.
    expect(
      openingCase((s) =>
        s.openings.push({
          id: "opening_d_legacy_ok",
          type: "door",
          hostGeometryId: "wall_living_west",
          offset: 1000,
          width: 900,
          sill: 0,
          height: 2100,
          hingeSide: "start_jamb",
          swingDirection: "into_room",
          transform: { position: [1000, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
          locks: { geometry: false, transform: false, material: false },
        }),
      ),
    ).toEqual([]);
  });

  it("v0.5 requirements pin circulation-policy-v0.2 and resolve a shared portal by space", () => {
    const requirement = (spaceId: string, policy = "circulation-policy-v0.2") => ({
      id: "req_portal",
      type: "same_space_route",
      spaceId,
      evaluationPolicy: policy,
      start: { kind: "door_portal", openingId: DOOR },
      end: { kind: "point", pointXY: [1000, 3000] },
    });
    const scene = seedScene();
    scene.circulationRequirements = [requirement(LIVING)];
    expect(validateSceneSpec(scene).ok).toBe(true);
    scene.circulationRequirements = [requirement(BEDROOM)];
    expect(validateSceneSpec(scene).ok).toBe(true);
    scene.circulationRequirements = [requirement(LIVING, "circulation-policy-v0.1")];
    expect(validateSceneSpec(scene).ok).toBe(false);
    scene.circulationRequirements = [requirement("space_other")];
    expect(keywordsOf(scene)).toContain("circulationRequirementOpeningSpace");
  });
});

// ------------------------------------------------------------ seed v0.2

describe("reviewed multi-space seed (cad-scene-seed-policy-v0.2)", () => {
  it("reproduces the frozen SceneSpec v0.5 and full hash chain", () => {
    const inputs = seedInputs();
    const result = createCadMultiSpaceSeed(inputs);
    expect(result.sceneSpec).toEqual(seedScene());
    expect(result.evidence).toEqual(read(seedDir, "expected-seed-evidence-v0.2.json"));
    expect(validateCadSceneSeedEvidenceV02(result.evidence).ok).toBe(true);
    expect(validateCadSceneSeedApprovalV02(inputs.sceneApproval).ok).toBe(true);
    expect(result.evidence).toMatchObject({
      sourceHash: FROZEN.sourceHash,
      cadDocumentHash: FROZEN.cadDocumentHash,
      profileHash: FROZEN.profileHash,
      candidateBasis: "space_wall_stage",
      architecturalExtractionHash: null,
      spaceWallStageHash: FROZEN.spaceWallStageHash,
      architecturalTopologyHash: FROZEN.architecturalTopologyHash,
      partitionApprovalHash: FROZEN.partitionApprovalHash,
      reviewedPartitionModelHash: FROZEN.reviewedPartitionModelHash,
      sceneApprovalHash: FROZEN.sceneApprovalHash,
      sceneSpecHash: FROZEN.sceneSpecHash,
      projectId: "project_cad_multispace_001",
      sceneId: "scene_cad_multispace_001",
      revisionId: "rev_cad_multispace_0001",
      mappingSummary: {
        levelCount: 1,
        spaceCount: 2,
        wallCount: 6,
        sharedPartitionCount: 1,
        surfaceCount: 4,
        openingCount: 1,
        partitionDoorCount: 1,
      },
      spatialPolicyVersion: "spatial-policy-v0.2",
      circulationPolicyVersion: "circulation-policy-v0.2",
      status: "PASS",
    });
    expect(semanticJsonHash(result.sceneSpec)).toBe(FROZEN.sceneSpecHash);
  });

  it("keeps the null extraction hash in the provenance extension (never a placeholder)", () => {
    const extension = (seedScene().extensions as Record<string, Record<string, unknown>>)[
      "aiarchviz.cad_multispace_seed"
    ];
    expect(extension).toMatchObject({
      seedPolicy: "cad-scene-seed-policy-v0.2",
      sceneApprovalId: "approval_cad_multispace_seed_001",
      sceneApprovalHash: FROZEN.sceneApprovalHash,
      partitionApprovalId: "approval_partitions_two_room",
      partitionApprovalHash: FROZEN.partitionApprovalHash,
      reviewedPartitionModelHash: FROZEN.reviewedPartitionModelHash,
      architecturalTopologyHash: FROZEN.architecturalTopologyHash,
      spaceWallStageHash: FROZEN.spaceWallStageHash,
      candidateBasis: "space_wall_stage",
      architecturalExtractionHash: null,
      profileHash: FROZEN.profileHash,
      cadDocumentHash: FROZEN.cadDocumentHash,
      sourceHash: FROZEN.sourceHash,
    });
    expect(JSON.stringify(extension)).not.toMatch(/not_applicable|"none"|0{64}|[A-Za-z]:\\\\/);
  });

  it("canonicalizes 2 spaces, 6 unpaired walls, 1 shared partition, 4 surfaces, 1 shared door", () => {
    const scene = seedScene();
    const walls = scene.geometry.filter((entry) => entry.type === "wall");
    expect(walls.map((wall) => wall.id)).toEqual([
      "wall_living_south",
      "wall_living_north",
      "wall_living_west",
      "wall_bedroom_south",
      "wall_bedroom_east",
      "wall_bedroom_north",
    ]);
    // No ordinary wall duplicates the shared interval on x = 3000.
    for (const wall of walls) {
      const [start, end] = [wall.start as number[], wall.end as number[]];
      expect(start[0] === 3000 && end[0] === 3000).toBe(false);
      expect(wall.referenceLine).toBe("interior_face");
      expect(wall.thicknessDirection).toBe("exterior_right_of_u");
    }
    expect(partitionOf(scene)).toMatchObject({
      id: PARTITION,
      adjacentSpaceIds: [BEDROOM, LIVING],
      start: [3000, 0, 0],
      end: [3000, 4000, 0],
      baseElevation: 0,
      height: 3000,
      thickness: 150,
      referenceLine: "centerline",
      spaceFaces: [
        { spaceId: LIVING, side: "left", start: [2925, 0, 0], end: [2925, 4000, 0] },
        { spaceId: BEDROOM, side: "right", start: [3075, 0, 0], end: [3075, 4000, 0] },
      ],
    });
    expect(
      scene.geometry.filter((entry) => ["floor", "ceiling"].includes(String(entry.type))),
    ).toHaveLength(4);
    expect(scene.openings).toEqual([
      expect.objectContaining({
        id: DOOR,
        type: "door",
        hostGeometryId: PARTITION,
        connectsSpaceIds: [BEDROOM, LIVING],
        offset: 1550,
        width: 900,
        sill: 0,
        height: 2100,
        hingeEndpoint: "host_start",
        swingIntoSpaceId: BEDROOM,
      }),
    ]);
  });

  it("keeps reviewed room boundaries meeting at x = 3000 (no rewrite to 2925 / 3075)", () => {
    const scene = seedScene();
    const boundaries = Object.fromEntries(scene.spaces.map((space) => [space.id, space.boundary]));
    expect(boundaries[LIVING]).toEqual([
      [0, 0, 0],
      [3000, 0, 0],
      [3000, 4000, 0],
      [0, 4000, 0],
    ]);
    expect(boundaries[BEDROOM]).toEqual([
      [3000, 0, 0],
      [6000, 0, 0],
      [6000, 4000, 0],
      [3000, 4000, 0],
    ]);
    for (const surface of scene.geometry.filter((entry) =>
      ["floor", "ceiling"].includes(String(entry.type)),
    )) {
      expect(surface.boundary).toEqual(boundaries[String(surface.spaceId)]);
    }
    expect(JSON.stringify(scene.spaces)).not.toMatch(/2925|3075/);
  });

  it("fails closed on stale, unapproved, incomplete, duplicate, or overriding approvals", () => {
    const codeOf = (edit: (inputs: ReturnType<typeof seedInputs>) => void) => {
      const inputs = seedInputs();
      edit(inputs);
      try {
        createMultiSpaceSceneSpecSeed(inputs);
      } catch (error) {
        expect(error).toBeInstanceOf(CadSceneSeedError);
        return (error as CadSceneSeedError).code;
      }
      throw new Error("expected a CadSceneSeedError");
    };
    expect(
      codeOf((inputs) => {
        inputs.sceneApproval.reviewedPartitionModel.reviewedPartitionModelHash = `sha256:${"1".repeat(64)}`;
      }),
    ).toBe("CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH");
    expect(codeOf((inputs) => Object.assign(inputs.sceneApproval, { decision: "rejected" }))).toBe(
      "CAD_SCENE_SEED_NOT_APPROVED",
    );
    expect(codeOf((inputs) => inputs.sceneApproval.mappings.walls.pop())).toBe(
      "CAD_SCENE_SEED_MAPPING_INCOMPLETE",
    );
    expect(
      codeOf((inputs) =>
        inputs.sceneApproval.mappings.partitions.push({
          candidateId: "partition_candidate_0009",
          logicalId: "partition_extra",
        }),
      ),
    ).toBe("CAD_SCENE_SEED_MAPPING_UNKNOWN_CANDIDATE");
    expect(
      codeOf((inputs) => {
        (inputs.sceneApproval.mappings.partitions[0] as { logicalId: string }).logicalId =
          "wall_living_south";
      }),
    ).toBe("CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE");
    expect(
      codeOf((inputs) =>
        Object.assign(inputs.sceneApproval.mappings.partitions[0] as object, { thickness: 200 }),
      ),
    ).toBe("CAD_SCENE_SEED_APPROVAL_INVALID");
    // The stage basis has no extraction: a non-null extraction hash is invalid, never "fixed".
    expect(
      codeOf((inputs) => {
        inputs.sceneApproval.reviewedPartitionModel.architecturalExtractionHash = `sha256:${"2".repeat(64)}`;
      }),
    ).toBe("CAD_SCENE_SEED_APPROVAL_INVALID");
    // A supplied model that differs from the 10E derivation of its inputs is rejected.
    expect(
      codeOf((inputs) => {
        (inputs.reviewedPartitionModel.sharedPartitions[0] as { thicknessMm: number }).thicknessMm =
          200;
      }),
    ).toBe("CAD_SCENE_SEED_PARTITION_MODEL_MISMATCH");
  });

  it("hosts an unshared opening on exactly one unpaired segment with a segment-local offset", () => {
    const segments = [
      { candidateId: "seg_a", wallCandidateId: "w", ordinal: 0, fromMm: 0, toMm: 1500 },
      { candidateId: "seg_b", wallCandidateId: "w", ordinal: 1, fromMm: 4000, toMm: 6000 },
    ];
    expect(
      hostOnUnpairedSegment({ candidateId: "o", offsetMm: 4750, widthMm: 900 }, segments),
    ).toEqual({
      segment: segments[1],
      localOffsetMm: 750,
    });
    for (const offsetMm of [3500, 1000, 5500]) {
      let code = "";
      try {
        hostOnUnpairedSegment({ candidateId: "o", offsetMm, widthMm: 900 }, segments);
      } catch (error) {
        code = (error as CadSceneSeedError).code;
      }
      expect(code).toBe("CAD_SCENE_SEED_OPENING_SEGMENT_INVALID");
    }
  });

  it("seeds a partial-share source end to end, re-hosting a door onto its unpaired segment", () => {
    const pipeline = partialShareSeed();
    const scene = pipeline.sceneSpec as Scene;
    const walls = scene.geometry.filter((entry) => entry.type === "wall");
    expect(walls).toHaveLength(8);
    const north = walls.filter((wall) => String(wall.id).startsWith("wall_c0000_0002"));
    expect(north.map((wall) => [wall.start, wall.end])).toEqual([
      [
        [6000, 3000, 0],
        [4500, 3000, 0],
      ],
      [
        [2000, 3000, 0],
        [0, 3000, 0],
      ],
    ]);
    expect(partitionOf(scene)).toMatchObject({ start: [2000, 3000, 0], end: [4500, 3000, 0] });
    const northDoor = scene.openings.find(
      (opening) => opening.hostGeometryId === "wall_c0000_0002_s0001",
    );
    // 10B offset 4750 on the 6000 mm wall -> 750 on the segment starting at 4000.
    expect(northDoor).toMatchObject({ offset: 750, width: 900, hingeSide: "start_jamb" });
    expect(validateSpatialSceneV02(scene).status).toBe("PASS");
  });

  it("is deterministic and never mutates its seven frozen inputs", () => {
    const frozen = deepFreeze(seedInputs());
    const before = JSON.stringify(frozen);
    const first = createCadMultiSpaceSeed(frozen);
    const second = createCadMultiSpaceSeed(seedInputs());
    expect(JSON.stringify(frozen)).toBe(before);
    expect(second.sceneSpec).toEqual(first.sceneSpec);
    expect(second.evidence).toEqual(first.evidence);
    expect(second.sceneApprovalHash).toBe(FROZEN.sceneApprovalHash);
  });

  it("maps pure seed failures through the worker boundary", () => {
    const inputs = seedInputs();
    inputs.sceneApproval.decision = "changes_requested";
    let caught: unknown;
    try {
      createCadMultiSpaceSeed(inputs);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CadMultiSpaceSeedWorkerError);
    expect((caught as CadMultiSpaceSeedWorkerError).code).toBe("CAD_SCENE_SEED_NOT_APPROVED");
  });
});

// -------------------------------------------------------- spatial v0.2

describe("spatial-policy-v0.2", () => {
  it("dispatches by version: v0.1 refuses v0.5; v0.4 stays under v0.1", () => {
    expect(() => validateSpatialScene(seedScene())).toThrow(/spatial-policy-v0.2/);
    expect(validateSpatialSceneForVersion(seedScene()).policyVersion).toBe("spatial-policy-v0.2");
    const rev13 = read(
      "tests/fixtures/living-room-golden",
      "revisions/rev_golden_0013/scene-spec.json",
    );
    expect(validateSpatialSceneForVersion(rev13)).toEqual(validateSpatialScene(rev13));
  });

  it("the canonical seed passes with door-subtracted solids and two-sided clearances", () => {
    const evidence = spatialValidationEvidenceV02(seedScene());
    expect(evidence).toEqual(read(seedDir, "expected-spatial-evidence-v0.2.json"));
    expect(validateSpatialValidationEvidenceV02(evidence).ok).toBe(true);
    const result = validateSpatialSceneV02(seedScene());
    expect(result.status).toBe("PASS");
    expect(
      result.partitionSolids.map((solid) => [
        solid.solidId,
        solid.fromMm,
        solid.toMm,
        solid.cornersXY,
      ]),
    ).toEqual([
      [
        `${PARTITION}::solid::0000`,
        0,
        1550,
        [
          [3075, 0],
          [3075, 1550],
          [2925, 1550],
          [2925, 0],
        ],
      ],
      [
        `${PARTITION}::solid::0001`,
        2450,
        4000,
        [
          [3075, 2450],
          [3075, 4000],
          [2925, 4000],
          [2925, 2450],
        ],
      ],
    ]);
    expect(
      result.doorwayClearances.map((clearance) => [
        clearance.spaceId,
        clearance.side,
        clearance.cornersXY,
      ]),
    ).toEqual([
      [
        BEDROOM,
        "right",
        [
          [3075, 1550],
          [3075, 2450],
          [3975, 2450],
          [3975, 1550],
        ],
      ],
      [
        LIVING,
        "left",
        [
          [2925, 1550],
          [2925, 2450],
          [2025, 2450],
          [2025, 1550],
        ],
      ],
    ]);
  });

  it("rejects an in-room asset that intrudes into the partition half-volume", () => {
    const box = seedScene().assetDefinitions[0] as Record<string, unknown>; // 600 x 400
    const scene = withAsset(LIVING, [2640, 800], box); // x 2340..2940: inside x <= 3000
    const result = validateSpatialSceneV02(scene);
    expect(result.violations).toEqual([
      expect.objectContaining({
        code: "SPATIAL_ASSET_PARTITION_OVERLAP",
        assetId: "asset_probe",
        spaceId: LIVING,
        partitionId: PARTITION,
        partitionSolidId: `${PARTITION}::solid::0000`,
      }),
    ]);
    // The same asset is perfectly acceptable to the space boundary alone.
    const boundaryOnly = result.violations.filter(
      (violation) => violation.code === "SPATIAL_ASSET_OUTSIDE_SPACE",
    );
    expect(boundaryOnly).toEqual([]);
    expect(validateSpatialSceneV02(withAsset(LIVING, [2620, 800], box)).status).toBe("PASS");
  });

  it("a door void is never partition solid (clearance may still apply)", () => {
    const solids = scenePartitionSolids(seedScene());
    const inside = (point: [number, number]) =>
      solids.some(
        ({ cornersXY }) =>
          point[0] >= Math.min(...cornersXY.map((c) => c[0])) &&
          point[0] <= Math.max(...cornersXY.map((c) => c[0])) &&
          point[1] >= Math.min(...cornersXY.map((c) => c[1])) &&
          point[1] <= Math.max(...cornersXY.map((c) => c[1])),
      );
    expect(inside([3000, 2000])).toBe(false);
    expect(inside([3000, 1000])).toBe(true);
    // A probe in the living half of the void: no partition overlap, no clearance overlap.
    expect(validateSpatialSceneV02(withAsset(LIVING, [2960, 2000])).violations).toEqual([]);
    // The same probe beside the void hits the solid.
    expect(
      validateSpatialSceneV02(withAsset(LIVING, [2960, 1400])).violations.map((v) => v.code),
    ).toEqual(["SPATIAL_ASSET_PARTITION_OVERLAP"]);
    // Inside the living clearance: a clearance violation, not a solid overlap.
    expect(validateSpatialSceneV02(withAsset(LIVING, [2800, 2000])).violations).toEqual([
      expect.objectContaining({
        code: "SPATIAL_DOOR_CLEARANCE_BLOCKED",
        openingId: DOOR,
        spaceId: LIVING,
      }),
    ]);
  });

  it("blocking one side's clearance names exactly that side", () => {
    const violations = validateSpatialSceneV02(withAsset(BEDROOM, [3500, 2000])).violations;
    expect(violations).toEqual([
      expect.objectContaining({
        code: "SPATIAL_DOOR_CLEARANCE_BLOCKED",
        openingId: DOOR,
        spaceId: BEDROOM,
      }),
    ]);
  });
});

// ---------------------------------------------------- circulation v0.2

describe("circulation-policy-v0.2", () => {
  it("v0.1 refuses a v0.5 scene; v0.2 analyzes it with its own policy identity", () => {
    expect(() => analyzeCirculation(seedScene())).toThrow(/circulation-policy-v0.2/);
    const analysis = analyzeCirculationV02(seedScene());
    expect(analysis).toMatchObject({
      policyVersion: "circulation-policy-v0.2",
      spatialPolicyVersion: "spatial-policy-v0.2",
      gridStepMm: 100,
      agentRadiusMm: 300,
      status: "PASS",
    });
    const evidence = circulationAnalysisEvidenceV02(seedScene());
    expect(validateCirculationAnalysisEvidenceV02(evidence).ok).toBe(true);
    expect(circulationAnalysisEvidenceV02(seedScene())).toEqual(evidence);
  });

  it("one shared door yields two portals keyed by (openingId, spaceId)", () => {
    const analysis = analyzeCirculationV02(seedScene());
    const portals = analysis.spaces.flatMap((space) => space.doorPortals);
    expect(
      portals.map((portal) => [portal.openingId, portal.spaceId, portal.portalXY, portal.status]),
    ).toEqual([
      [DOOR, BEDROOM, [3975, 2000], "RESOLVED"],
      [DOOR, LIVING, [2025, 2000], "RESOLVED"],
    ]);
    const [bedroom, living] = portals;
    expect(bedroom?.nodeId).not.toBe(living?.nodeId);
    expect(bedroom?.nodeId?.startsWith(`${BEDROOM}::`)).toBe(true);
    expect(living?.nodeId?.startsWith(`${LIVING}::`)).toBe(true);
  });

  it("measures agent clearance from the physical partition face (living centers x <= 2625)", () => {
    const route = (x: number) =>
      findCirculationRouteV02(seedScene(), {
        spaceId: LIVING,
        startXY: [x, 800],
        endXY: [1000, 3000],
      });
    expect(route(2624).status).toBe("PASS");
    expect(route(2626).violations[0]?.code).toBe("CIRCULATION_ENDPOINT_BLOCKED");
    const living = analyzeCirculationV02(seedScene()).graph.spaces.find(
      (space) => space.spaceId === LIVING,
    );
    const besideSolid = (living?.nodes ?? [])
      .map((node) => node.split("::").map(Number))
      .map(([, ix, iy]) => [50 + (ix as number) * 100, 50 + (iy as number) * 100])
      .filter(([, y]) => (y as number) <= 1250);
    expect(Math.max(...besideSolid.map(([x]) => x as number))).toBe(2550);
    // Bedroom side mirrors it: centers x >= 3375.
    expect(
      findCirculationRouteV02(seedScene(), {
        spaceId: BEDROOM,
        startXY: [3374, 800],
        endXY: [5000, 3000],
      }).violations[0]?.code,
    ).toBe("CIRCULATION_ENDPOINT_BLOCKED");
  });

  it("never connects the two space graphs (same-space routing only)", () => {
    const graph = analyzeCirculationV02(seedScene()).graph;
    for (const space of graph.spaces) {
      for (const [a, b] of space.edges) {
        expect(a.startsWith(`${space.spaceId}::`) && b.startsWith(`${space.spaceId}::`)).toBe(true);
      }
    }
    const crossing = findCirculationRouteV02(seedScene(), {
      spaceId: LIVING,
      startXY: [1000, 2000],
      endXY: [5000, 2000],
    });
    expect(crossing.status).toBe("FAILED");
    expect(crossing.violations[0]?.code).toBe("CIRCULATION_ENDPOINT_BLOCKED");
  });
});

// --------------------------------------------- requirement evaluation v0.2

describe("circulation requirements under circulation-policy-v0.2", () => {
  const twoSided = (scene: Scene = seedScene()) => {
    scene.circulationRequirements = [
      {
        id: "req_a_living_portal",
        type: "same_space_route",
        spaceId: LIVING,
        evaluationPolicy: "circulation-policy-v0.2",
        start: { kind: "door_portal", openingId: DOOR },
        end: { kind: "point", pointXY: [1000, 3000] },
      },
      {
        id: "req_b_bedroom_portal",
        type: "same_space_route",
        spaceId: BEDROOM,
        evaluationPolicy: "circulation-policy-v0.2",
        start: { kind: "door_portal", openingId: DOOR },
        end: { kind: "point", pointXY: [5000, 3000] },
      },
    ];
    return scene;
  };

  it("resolves each requirement to its own side's portal; both SATISFIED", () => {
    const scene = twoSided();
    expect(validateSceneSpec(scene).ok).toBe(true);
    const evaluation = evaluateCirculationRequirements(scene);
    expect(evaluation.circulationPolicyVersion).toBe("circulation-policy-v0.2");
    expect(
      evaluation.requirements.map((result) => [
        result.requirementId,
        result.status,
        result.resolvedStartXY,
      ]),
    ).toEqual([
      ["req_a_living_portal", "SATISFIED", [2025, 2000]],
      ["req_b_bedroom_portal", "SATISFIED", [3975, 2000]],
    ]);
    const [living, bedroom] = evaluation.requirements;
    expect(living?.startNodeId).not.toBe(bedroom?.startNodeId);
    const evidence = circulationRequirementEvidenceV02(scene);
    expect(validateCirculationRequirementEvidenceV02(evidence).ok).toBe(true);
    expect(evidence.status).toBe("PASS");
    // v0.4 evaluation is unchanged in identity.
    const rev13 = read(
      "tests/fixtures/living-room-golden",
      "revisions/rev_golden_0013/scene-spec.json",
    );
    expect(evaluateCirculationRequirements(rev13).circulationPolicyVersion).toBe(
      "circulation-policy-v0.1",
    );
  });

  it("blocking only the living-side portal fails only the living requirement", () => {
    // A 300 x 400 box whose face sits 5 mm beyond the living clearance edge (x = 2025):
    // no spatial violation, but the living portal is no longer a clear agent center.
    const blocker = {
      ...(seedScene().assetDefinitions[0] as Record<string, unknown>),
      id: "assetdef_blocker_v1",
      dimensions: [300, 400, 450],
    };
    const scene = twoSided(withAsset(LIVING, [1870, 2000], blocker));
    expect(validateSpatialSceneV02(scene).status).toBe("PASS");
    const evaluation = evaluateCirculationRequirements(scene);
    expect(
      evaluation.requirements.map((result) => [
        result.requirementId,
        result.status,
        result.failureCode,
      ]),
    ).toEqual([
      ["req_a_living_portal", "UNSATISFIED", "CIRCULATION_PORTAL_BLOCKED"],
      ["req_b_bedroom_portal", "SATISFIED", null],
    ]);
    const portals = analyzeCirculationV02(scene).spaces.flatMap((space) => space.doorPortals);
    expect(portals.map((portal) => [portal.spaceId, portal.status])).toEqual([
      [BEDROOM, "RESOLVED"],
      [LIVING, "BLOCKED"],
    ]);
  });

  it("is deterministic across repeated evaluation", () => {
    const first = circulationRequirementEvidenceV02(twoSided());
    expect(circulationRequirementEvidenceV02(twoSided())).toEqual(first);
  });
});

// ------------------------------------------------------ DCC incapability

describe("no SceneSpec v0.5 physical realization (10G)", () => {
  it("the existing build plans refuse a shared partition instead of skipping or approximating it", () => {
    expect(() => compileGoldenBuildPlan(seedScene())).toThrow(/Unsupported geometry/);
    expect(() => compileBuildPlanV02(seedScene())).toThrow(/Unsupported geometry/);
  });

  it("introduces no SceneChangeSet v0.5, build plan v0.3, or Golden rev14", () => {
    const schemaDir = join(repositoryRoot, "packages/scene-spec/schema");
    expect(existsSync(join(schemaDir, "scene-change-set-v0.5.schema.json"))).toBe(false);
    expect(
      existsSync(
        join(repositoryRoot, "tests/fixtures/living-room-golden/revisions/rev_golden_0014"),
      ),
    ).toBe(false);
    expect(readFileSync(join(repositoryRoot, "apps/worker/src/build-plan.ts"), "utf8")).not.toMatch(
      /0\.3\.0|shared_partition/,
    );
  });
});

// ------------------------------------------------ partial-share pipeline

type Pair = [number, string | number];
function dxf(entities: Pair[][]): string {
  const pairs: Pair[] = [
    [0, "SECTION"],
    [2, "HEADER"],
    [9, "$INSUNITS"],
    [70, 4],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "TABLES"],
    [0, "TABLE"],
    [2, "LAYER"],
  ];
  for (const name of ["0", "A-ROOM", "A-SPACE-TEXT", "A-DOOR", "A-WINDOW"])
    pairs.push([0, "LAYER"], [2, name], [70, 0]);
  pairs.push([0, "ENDTAB"], [0, "ENDSEC"], [0, "SECTION"], [2, "BLOCKS"]);
  for (const name of ["DOOR_900_LH_IN", "WINDOW_2400"]) {
    pairs.push(
      [0, "BLOCK"],
      [8, "0"],
      [2, name],
      [70, 0],
      [10, 0],
      [20, 0],
      [0, "ENDBLK"],
      [8, "0"],
    );
  }
  pairs.push([0, "ENDSEC"], [0, "SECTION"], [2, "ENTITIES"]);
  for (const entity of entities) pairs.push(...entity);
  pairs.push([0, "ENDSEC"], [0, "EOF"]);
  return `${pairs.map(([code, value]) => `${code}\n${value}`).join("\n")}\n`;
}
const room = (points: [number, number][]): Pair[] => [
  [0, "LWPOLYLINE"],
  [8, "A-ROOM"],
  [90, points.length],
  [70, 1],
  ...points.flatMap(([x, y]): Pair[] => [
    [10, x],
    [20, y],
  ]),
];
const text = (value: string, [x, y]: [number, number]): Pair[] => [
  [0, "TEXT"],
  [8, "A-SPACE-TEXT"],
  [10, x],
  [20, y],
  [40, 200],
  [1, value],
];
const insert = (block: string, [x, y]: [number, number]): Pair[] => [
  [0, "INSERT"],
  [8, block.startsWith("WINDOW") ? "A-WINDOW" : "A-DOOR"],
  [2, block],
  [10, x],
  [20, y],
  [50, 90],
];

/** Test-only explicit review intent for the partial-share source (no door to review). */
function partialShareSeed() {
  const cadDocument: CadDocument = parseDxfSource(
    new TextEncoder().encode(
      dxf([
        room([
          [0, 0],
          [6000, 0],
          [6000, 3000],
          [0, 3000],
        ]),
        room([
          [2000, 3000],
          [4500, 3000],
          [4500, 6000],
          [2000, 6000],
        ]),
        text("LIVING ROOM", [3000, 1500]),
        text("BEDROOM", [3250, 4500]),
        insert("DOOR_900_LH_IN", [800, 3000]),
      ]),
    ),
  );
  const extraction: ArchitecturalExtraction = interpretCadDocument(cadDocument, profile);
  const topology: ArchitecturalTopology = analyzeArchitecturalTopology({
    cadDocument,
    interpretationProfile: profile,
    architecturalExtraction: extraction,
  });
  const partitionApproval: CadTopologyApproval = {
    approvalVersion: "0.1.0",
    approvalId: "approval_partitions_partial_test",
    partitionPolicy: "cad-shared-partition-policy-v0.1",
    decision: "approved_as_shared_partition_model",
    topology: {
      architecturalTopologyVersion: "0.1.0",
      architecturalTopologyHash: semanticJsonHash(topology),
      candidateBasis: topology.source.candidateBasis,
      sourceHash: topology.source.sourceHash,
      cadDocumentHash: topology.source.cadDocumentHash,
      profileHash: topology.source.profileHash,
      spaceWallStageHash: topology.source.spaceWallStageHash,
      architecturalExtractionHash: topology.source.architecturalExtractionHash,
    },
    sharedBoundaryReviews: [
      {
        sharedBoundaryCandidateId: "shared_boundary_0000",
        referencePolicy: "partition_centerline",
      },
    ],
    interiorDoorReviews: [],
  };
  const base = {
    cadDocument,
    interpretationProfile: profile,
    architecturalExtraction: extraction,
    architecturalTopology: topology,
  };
  const model = createReviewedPartitionModel({ ...base, approval: partitionApproval });
  const segments = unpairedWallSegments(model);
  const template = seedInputs().sceneApproval;
  const sceneApproval: CadSceneSeedApprovalV02 = {
    ...structuredClone(template),
    approvalId: "approval_cad_multispace_partial_test",
    reviewedPartitionModel: {
      reviewedPartitionModelVersion: "0.1.0",
      reviewedPartitionModelHash: semanticJsonHash(model),
      partitionPolicyVersion: "cad-shared-partition-policy-v0.1",
      architecturalTopologyHash: model.source.architecturalTopologyHash,
      candidateBasis: model.source.candidateBasis,
      sourceHash: model.source.sourceHash,
      cadDocumentHash: model.source.cadDocumentHash,
      profileHash: model.source.profileHash,
      spaceWallStageHash: model.source.spaceWallStageHash,
      architecturalExtractionHash: model.source.architecturalExtractionHash,
    },
    mappings: {
      levels: [{ candidateId: "level_candidate_ground", logicalId: "level_ground" }],
      spaces: template.mappings.spaces,
      walls: segments.map((segment) => ({
        candidateId: segment.candidateId,
        logicalId: `wall_c${segment.wallCandidateId.slice("wall_candidate_".length)}_s${String(segment.ordinal).padStart(4, "0")}`,
      })),
      partitions: [
        { candidateId: "partition_candidate_0000", logicalId: "partition_partial_test" },
      ],
      openings: topology.openingRelations.map((relation) => ({
        candidateId: relation.topologyOpeningId,
        logicalId: `opening_partial_${relation.topologyOpeningId.slice(-4)}`,
      })),
    },
    nonCadState: {
      ...structuredClone(template.nonCadState),
      sources: [
        {
          id: "source_partial_dxf",
          type: "dxf",
          uri: `urn:sha256:${cadDocument.sourceHash.slice("sha256:".length)}`,
          authority: "A3",
          confidence: 1,
          verified: true,
        },
      ],
      assets: [
        {
          ...structuredClone(template.nonCadState.assets[1] as Record<string, unknown>),
          transform: { position: [1000, 1000, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
      cameras: [
        {
          ...structuredClone(template.nonCadState.cameras[0] as Record<string, unknown>),
          transform: {
            position: [1000, 500, 1500],
            rotationEuler: [-2.84471, 0, 206.565051],
            scale: [1, 1, 1],
          },
          target: [3000, 2500, 1300],
        },
      ],
    },
  };
  return createCadMultiSpaceSeed({
    ...base,
    partitionApproval,
    reviewedPartitionModel: model,
    sceneApproval,
  });
}
