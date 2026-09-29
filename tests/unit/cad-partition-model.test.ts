import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ArchitecturalExtraction,
  type CadInterpretationError,
  type CadInterpretationProfile,
  interpretCadDocument,
  type WallCandidate,
} from "@ai-archviz/cad-interpreter";
import type { CadDocument } from "@ai-archviz/cad-parser";
import {
  CadPartitionError,
  type CadTopologyApproval,
  createReviewedPartitionModel,
  distanceToLine,
  normals,
  offsetSegment,
  type ReviewedPartitionModel,
  type ReviewedPartitionModelInput,
  unitDirection,
  validateCadTopologyApproval,
  validateReviewedPartitionModel,
} from "@ai-archviz/cad-partition-model";
import {
  type ArchitecturalTopology,
  analyzeArchitecturalTopology,
  type InteriorOpeningRelation,
} from "@ai-archviz/cad-topology";
import { semanticJsonHash, validateCadPartitionModelEvidence } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CadPartitionWorkerError,
  cadPartitionModelEvidence,
  reviewCadPartitionFiles,
  writeCadPartitionModel,
} from "../../apps/worker/src/cad-partition-model.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const topologyRoot = join(repositoryRoot, "tests/fixtures/cad/topology");
const partitionRoot = join(repositoryRoot, "tests/fixtures/cad/partition-model");
const readJson = <T>(...parts: string[]) => JSON.parse(readFileSync(join(...parts), "utf8")) as T;
const profile = readJson<CadInterpretationProfile>(topologyRoot, "profile-v0.1.json");

type FixtureName = "two-room" | "three-room" | "partial-share";
const FIXTURES: FixtureName[] = ["two-room", "three-room", "partial-share"];

const inputsOf = (
  name: FixtureName,
): ReviewedPartitionModelInput & {
  architecturalTopology: ArchitecturalTopology;
  approval: CadTopologyApproval;
  architecturalExtraction: ArchitecturalExtraction | null;
} => {
  const extractionPath = join(topologyRoot, name, "architectural-extraction-v0.1.json");
  return {
    cadDocument: readJson<CadDocument>(topologyRoot, name, "cad-document-v0.1.json"),
    interpretationProfile: profile,
    architecturalExtraction: existsSync(extractionPath)
      ? readJson<ArchitecturalExtraction>(extractionPath)
      : null,
    architecturalTopology: readJson<ArchitecturalTopology>(
      topologyRoot,
      name,
      "expected-architectural-topology-v0.1.json",
    ),
    approval: readJson<CadTopologyApproval>(partitionRoot, name, "approval-v0.1.json"),
  };
};
const expectedModel = (name: FixtureName) =>
  readJson<ReviewedPartitionModel>(
    partitionRoot,
    name,
    "expected-reviewed-partition-model-v0.1.json",
  );
const expectedEvidence = (name: FixtureName) =>
  readJson<Record<string, unknown>>(
    partitionRoot,
    name,
    "expected-cad-partition-model-evidence-v0.1.json",
  );

const FROZEN: Record<FixtureName, Record<string, string | null>> = {
  "two-room": {
    approvalHash: "sha256:bcb1a14c24df3d512a2fa258f398a6cd8218d2960435cdc1a571b3351eb1f563",
    architecturalTopologyHash:
      "sha256:d8be5d08652116e14a7f959adf3efcd80148c7615661d2a7448fce68f74c2f59",
    architecturalExtractionHash: null,
    spaceWallStageHash: "sha256:ab13a1ac0eed9d9deec986e78bb14bbe6b04aa7119467488184a76ac3083a81a",
    reviewedPartitionModelHash:
      "sha256:3f57213e3260437b21cc354efd1d6ed3c79bae9597ca92fe2fce59a41d8be017",
  },
  "three-room": {
    approvalHash: "sha256:8d8461d319864276ee1a6469d0a226d1ada51ec05e9b3028db60faee057f765e",
    architecturalTopologyHash:
      "sha256:e2fc51c02600758999eb4d8c96fd3ed93e73e8f657e90261a749ec50b6af83c7",
    architecturalExtractionHash:
      "sha256:1d8d74c7acf790ec0e37c7da3a6cf459a9f92c63541da52a5968b2c49d9f3efd",
    spaceWallStageHash: "sha256:772999dcc0fe31196af9410ebffde72ab49a08729f5c4299cffdc1ffce579635",
    reviewedPartitionModelHash:
      "sha256:2ecc1a9de8ea76bce72f69395a3a4e196a29ca781b337c577224e43e125b95ac",
  },
  "partial-share": {
    approvalHash: "sha256:f713df5034423321bd502d00f17b8335a91462b82c54ecd5dc7a4e1d529de643",
    architecturalTopologyHash:
      "sha256:675d9f334030f736e1491e78c496be5a126091954eab058512565c2975672cc0",
    architecturalExtractionHash:
      "sha256:f28f5152d0228f982ad28effc4d4943a9a894cd2113f802803fa6a07b15cc40f",
    spaceWallStageHash: "sha256:60dd8770780c5c0f1a004a3599e2453cc757bd8bf8d1f79ae4111968a91d7ea0",
    reviewedPartitionModelHash:
      "sha256:f0c474871b1a1108e116e590f2c3b5da8bf8835127a453b3e49ad864aea07c0d",
  },
};

const live = (name: FixtureName) => createReviewedPartitionModel(inputsOf(name));

/** Approval bound to an exact topology, with explicit synthetic review intent. */
function approvalFor(
  topology: ArchitecturalTopology,
  interiorDoorReviews: CadTopologyApproval["interiorDoorReviews"] = [],
): CadTopologyApproval {
  return {
    approvalVersion: "0.1.0",
    approvalId: "approval_partitions_test",
    partitionPolicy: "cad-shared-partition-policy-v0.1",
    decision: "approved_as_shared_partition_model",
    topology: {
      architecturalTopologyVersion: topology.architecturalTopologyVersion,
      architecturalTopologyHash: semanticJsonHash(topology),
      candidateBasis: topology.source.candidateBasis,
      sourceHash: topology.source.sourceHash,
      cadDocumentHash: topology.source.cadDocumentHash,
      profileHash: topology.source.profileHash,
      spaceWallStageHash: topology.source.spaceWallStageHash,
      architecturalExtractionHash: topology.source.architecturalExtractionHash,
    },
    sharedBoundaryReviews: topology.sharedBoundaries.map((boundary) => ({
      sharedBoundaryCandidateId: boundary.sharedBoundaryCandidateId,
      referencePolicy: "partition_centerline",
    })),
    interiorDoorReviews,
  };
}

function partitionError(action: () => unknown): CadPartitionError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CadPartitionError);
    return error as CadPartitionError;
  }
  throw new Error("expected a CadPartitionError");
}
const codeFor = (action: () => unknown) => partitionError(action).code;

/** A tampered-but-hash-consistent extraction basis re-analyzed by the real 10D analyzer. */
function partialShareWith(mutate: (walls: WallCandidate[]) => void) {
  const inputs = inputsOf("partial-share");
  const extraction = structuredClone(inputs.architecturalExtraction) as ArchitecturalExtraction;
  mutate(extraction.walls);
  const topology = analyzeArchitecturalTopology({
    cadDocument: inputs.cadDocument,
    interpretationProfile: profile,
    architecturalExtraction: extraction,
  });
  return {
    ...inputs,
    architecturalExtraction: extraction,
    architecturalTopology: topology,
    approval: approvalFor(topology),
  };
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// --------------------------------------------------------------- fixtures

describe("reviewed partition fixtures", () => {
  it.each(FIXTURES)("%s: live model and evidence equal the frozen fixtures", (name) => {
    const inputs = inputsOf(name);
    const result = cadPartitionModelEvidence(inputs);
    expect(result.model).toEqual(expectedModel(name));
    expect(result.evidence).toEqual(expectedEvidence(name));
    expect(validateReviewedPartitionModel(result.model).ok).toBe(true);
    expect(validateCadPartitionModelEvidence(result.evidence).ok).toBe(true);
    expect(validateCadTopologyApproval(inputs.approval).ok).toBe(true);
    const frozen = FROZEN[name];
    expect(result.evidence).toMatchObject({
      approvalHash: frozen.approvalHash,
      architecturalTopologyHash: frozen.architecturalTopologyHash,
      architecturalExtractionHash: frozen.architecturalExtractionHash,
      spaceWallStageHash: frozen.spaceWallStageHash,
      reviewedPartitionModelHash: frozen.reviewedPartitionModelHash,
    });
    expect(result.reviewedPartitionModelHash).toBe(frozen.reviewedPartitionModelHash);
    expect(semanticJsonHash(inputs.architecturalTopology)).toBe(frozen.architecturalTopologyHash);
    expect(result.model.status).toBe("APPROVED_FOR_SCENE_CANONICALIZATION");
    expect(result.model.partitionPolicyVersion).toBe("cad-shared-partition-policy-v0.1");
    expect(result.model.identityScope).toBe("model_local_non_canonical");
  });

  it("two-room (stage basis): the null extraction hash is preserved end to end", () => {
    const inputs = inputsOf("two-room");
    expect(inputs.architecturalExtraction).toBe(null);
    expect(inputs.architecturalTopology.source.candidateBasis).toBe("space_wall_stage");
    expect(inputs.architecturalTopology.source.architecturalExtractionHash).toBe(null);
    expect(inputs.approval.topology.architecturalExtractionHash).toBe(null);
    const model = live("two-room");
    expect(model.source.architecturalExtractionHash).toBe(null);
    expect(model.source.spaceWallStageHash).toBe(FROZEN["two-room"].spaceWallStageHash);
    expect(expectedEvidence("two-room").architecturalExtractionHash).toBe(null);
    // The historical 10B API still refuses this source; nothing synthesizes an extraction.
    let caught: unknown;
    try {
      interpretCadDocument(inputs.cadDocument, profile);
    } catch (error) {
      caught = error;
    }
    expect((caught as CadInterpretationError).code).toBe("CAD_INTERPRET_OPENING_HOST_AMBIGUOUS");
  });

  it("two-room: one 150 mm partition on the x = 3000 centerline with faces exactly 75 mm each side", () => {
    const model = live("two-room");
    expect(model.summary).toEqual({
      spaceCount: 2,
      sharedPartitionCount: 1,
      reviewedInteriorDoorCount: 1,
      unsharedOpeningCount: 0,
      wallCandidateCount: 8,
      sharedWallIntervalCount: 2,
      unpairedWallIntervalCount: 6,
    });
    const [partition] = model.sharedPartitions;
    expect(partition).toMatchObject({
      partitionCandidateId: "partition_candidate_0000",
      sharedBoundaryCandidateId: "shared_boundary_0000",
      adjacentSpaceCandidateIds: ["space_candidate_0000", "space_candidate_0001"],
      sourceWallCandidateIds: ["wall_candidate_0000_0001", "wall_candidate_0001_0003"],
      referencePolicy: "partition_centerline",
      centerLineStart: [3000, 0],
      centerLineEnd: [3000, 4000],
      lengthMm: 4000,
      unitDirection: [0, 1],
      leftNormal: [-1, 0],
      rightNormal: [1, 0],
      baseElevationMm: 0,
      heightMm: 3000,
      thicknessMm: 150,
    });
    // Living (x < 3000) resolves left, bedroom right; faces keep the centerline direction.
    expect(partition?.spaceFaces).toEqual([
      {
        side: "left",
        spaceCandidateId: "space_candidate_0000",
        sourceWallCandidateId: "wall_candidate_0000_0001",
        start: [2925, 0],
        end: [2925, 4000],
        offsetFromCenterlineMm: 75,
      },
      {
        side: "right",
        spaceCandidateId: "space_candidate_0001",
        sourceWallCandidateId: "wall_candidate_0001_0003",
        start: [3075, 0],
        end: [3075, 4000],
        offsetFromCenterlineMm: 75,
      },
    ]);
    expect(partition?.thicknessMm).toBe(profile.wallDefaults.wallThicknessMm);
    expect(model.spaces).toEqual([
      {
        spaceCandidateId: "space_candidate_0000",
        spaceType: "living_room",
        partitionCandidateIds: ["partition_candidate_0000"],
        adjacentSpaceCandidateIds: ["space_candidate_0001"],
      },
      {
        spaceCandidateId: "space_candidate_0001",
        spaceType: "bedroom",
        partitionCandidateIds: ["partition_candidate_0000"],
        adjacentSpaceCandidateIds: ["space_candidate_0000"],
      },
    ]);
  });

  it("two-room: the interior door is hosted on the partition with reviewed hinge and swing", () => {
    const inputs = inputsOf("two-room");
    const relation = inputs.architecturalTopology.openingRelations[0] as InteriorOpeningRelation;
    const door = live("two-room").sharedPartitions[0]?.openings[0];
    expect(door).toMatchObject({
      topologyOpeningId: "topology_opening_0000",
      type: "door",
      openingSourceOrdinal: relation.openingSourceOrdinal,
      openingSourceHandle: relation.openingSourceHandle,
      connectsSpaces: relation.connectsSpaces,
      centerXY: relation.centerXY,
      centerDistanceFromWorldStartMm: relation.centerDistanceFromWorldStartMm,
      offsetFromWorldStartMm: relation.offsetFromWorldStartMm,
      widthMm: relation.resolvedWidthMm,
      heightMm: relation.resolvedHeightMm,
      sillMm: relation.resolvedSillMm,
      hingeEndpoint: "world_start",
      hingeJambCenterlinePoint: [3000, 1550],
      swingIntoSpaceCandidateId: "space_candidate_0001",
      swingIntoSide: "right",
      profileDoorRule: {
        ruleId: "door_900_lh_in",
        hingeSide: "start_jamb",
        swingDirection: "into_room",
      },
    });
    expect(door?.provenance.hingeEndpoint).toEqual([
      {
        authority: "approval",
        approvalId: "approval_partitions_two_room",
        field: "interiorDoorReviews.hingeEndpoint",
      },
      { authority: "derived", derivation: "partition_hinge_jamb_v0.1" },
    ]);
    expect(door?.provenance.swingIntoSpaceCandidateId[0]).toMatchObject({ authority: "approval" });
    expect(door?.provenance.profileDoorRule).toEqual([
      { authority: "profile", field: "doorRules.hingeSide", ruleId: "door_900_lh_in" },
      { authority: "profile", field: "doorRules.swingDirection", ruleId: "door_900_lh_in" },
    ]);
    expect(door?.provenance.source).toEqual([
      { authority: "cad", sourceOrdinal: 4, sourceHandle: "104", role: "door_insert" },
    ]);
    expect(door?.provenance.host).toEqual([
      { authority: "topology", relation: "shared_boundary", id: "shared_boundary_0000" },
      { authority: "partition", partitionCandidateId: "partition_candidate_0000" },
      { authority: "derived", derivation: "partition_opening_host_v0.1" },
    ]);
  });

  it("the reviewed hinge endpoint and swing space drive the derived jamb and side", () => {
    const inputs = inputsOf("two-room");
    const approval = approvalFor(inputs.architecturalTopology, [
      {
        topologyOpeningId: "topology_opening_0000",
        hingeEndpoint: "world_end",
        swingIntoSpaceCandidateId: "space_candidate_0000",
      },
    ]);
    const door = createReviewedPartitionModel({ ...inputs, approval }).sharedPartitions[0]
      ?.openings[0];
    expect(door).toMatchObject({
      hingeEndpoint: "world_end",
      hingeJambCenterlinePoint: [3000, 2450],
      swingIntoSpaceCandidateId: "space_candidate_0000",
      swingIntoSide: "left",
    });
    // The profile rule is unchanged provenance regardless of the reviewed orientation.
    expect(door?.profileDoorRule).toEqual({
      ruleId: "door_900_lh_in",
      hingeSide: "start_jamb",
      swingDirection: "into_room",
    });
  });

  it("partition provenance separates topology, wall-candidate, approval, profile, and derived authority", () => {
    const provenance = live("two-room").sharedPartitions[0]?.provenance;
    expect(provenance?.referencePolicy).toEqual([
      {
        authority: "approval",
        approvalId: "approval_partitions_two_room",
        field: "sharedBoundaryReviews.referencePolicy",
      },
    ]);
    expect(provenance?.centerLine[0]).toEqual({
      authority: "topology",
      relation: "shared_boundary",
      id: "shared_boundary_0000",
    });
    expect(provenance?.thicknessMm.map((entry) => entry.authority)).toEqual([
      "wall_candidate",
      "wall_candidate",
      "profile",
    ]);
    expect(provenance?.thicknessMm[2]).toEqual({
      authority: "profile",
      field: "wallDefaults.wallThicknessMm",
      ruleId: null,
    });
    expect(provenance?.spaceSides.at(-1)).toEqual({
      authority: "derived",
      derivation: "partition_space_side_v0.1",
    });
    expect(provenance?.spaceFaces).toEqual([
      { authority: "derived", derivation: "partition_face_offset_v0.1" },
    ]);
    expect(JSON.stringify(provenance)).not.toMatch(/confidence|probability/);
  });

  it("three-room: two disjoint partitions on one hall wall, never bridged over the gap", () => {
    const model = live("three-room");
    expect(
      model.sharedPartitions.map((partition) => [
        partition.partitionCandidateId,
        partition.centerLineStart,
        partition.centerLineEnd,
        partition.lengthMm,
        partition.adjacentSpaceCandidateIds,
      ]),
    ).toEqual([
      [
        "partition_candidate_0000",
        [2000, 0],
        [2000, 3000],
        3000,
        ["space_candidate_0000", "space_candidate_0001"],
      ],
      [
        "partition_candidate_0001",
        [2000, 5000],
        [2000, 8000],
        3000,
        ["space_candidate_0000", "space_candidate_0002"],
      ],
    ]);
    const hallEast = model.wallSegments.find(
      (segment) => segment.wallCandidateId === "wall_candidate_0000_0001",
    );
    expect(hallEast?.intervals).toEqual([
      {
        fromMm: 0,
        toMm: 3000,
        role: "shared_partition",
        partitionCandidateId: "partition_candidate_0000",
      },
      { fromMm: 3000, toMm: 5000, role: "unpaired", partitionCandidateId: null },
      {
        fromMm: 5000,
        toMm: 8000,
        role: "shared_partition",
        partitionCandidateId: "partition_candidate_0001",
      },
    ]);
    expect(model.spaces[0]?.adjacentSpaceCandidateIds).toEqual([
      "space_candidate_0001",
      "space_candidate_0002",
    ]);
    expect(
      model.unsharedOpeningReferences.map((reference) => reference.openingCandidateId),
    ).toEqual(["opening_candidate_0000", "opening_candidate_0001", "opening_candidate_0002"]);
  });

  it("partial-share: one exactly 2500 mm partition; long wall is unpaired/shared/unpaired", () => {
    const model = live("partial-share");
    expect(model.sharedPartitions).toHaveLength(1);
    const [partition] = model.sharedPartitions;
    expect(partition).toMatchObject({
      centerLineStart: [2000, 3000],
      centerLineEnd: [4500, 3000],
      lengthMm: 2500,
    });
    // Bedroom lies above y = 3000 (left of the eastward centerline).
    expect(
      partition?.spaceFaces.map((face) => [face.side, face.spaceCandidateId, face.start, face.end]),
    ).toEqual([
      ["left", "space_candidate_0001", [2000, 3075], [4500, 3075]],
      ["right", "space_candidate_0000", [2000, 2925], [4500, 2925]],
    ]);
    const livingNorth = model.wallSegments.find(
      (segment) => segment.wallCandidateId === "wall_candidate_0000_0002",
    );
    expect(livingNorth).toEqual({
      wallCandidateId: "wall_candidate_0000_0002",
      spaceCandidateId: "space_candidate_0000",
      lengthMm: 6000,
      intervals: [
        { fromMm: 0, toMm: 1500, role: "unpaired", partitionCandidateId: null },
        {
          fromMm: 1500,
          toMm: 4000,
          role: "shared_partition",
          partitionCandidateId: "partition_candidate_0000",
        },
        { fromMm: 4000, toMm: 6000, role: "unpaired", partitionCandidateId: null },
      ],
    });
  });

  it("every wall segmentation covers its wall exactly once (no gaps, no overlap)", () => {
    for (const name of FIXTURES) {
      const model = live(name);
      for (const segment of model.wallSegments) {
        const { intervals, lengthMm } = segment;
        expect(intervals[0]?.fromMm).toBe(0);
        expect(intervals.at(-1)?.toMm).toBe(lengthMm);
        for (let index = 1; index < intervals.length; index += 1) {
          expect(intervals[index]?.fromMm).toBe(intervals[index - 1]?.toMm);
        }
        const total = intervals.reduce((sum, interval) => sum + interval.toMm - interval.fromMm, 0);
        expect(Math.abs(total - lengthMm)).toBeLessThanOrEqual(0.001);
        for (const interval of intervals) {
          expect(interval.role === "shared_partition").toBe(interval.partitionCandidateId !== null);
        }
      }
    }
  });

  it("face-distance proof: each face is T/2 from the centerline and T from the other face", () => {
    for (const name of FIXTURES) {
      for (const partition of live(name).sharedPartitions) {
        const { centerLineStart: start, centerLineEnd: end, thicknessMm } = partition;
        const [left, right] = partition.spaceFaces;
        for (const face of [left, right]) {
          expect(Math.abs(distanceToLine(face.start, start, end) - thicknessMm / 2)).toBeLessThan(
            0.001,
          );
          expect(Math.abs(distanceToLine(face.end, start, end) - thicknessMm / 2)).toBeLessThan(
            0.001,
          );
        }
        expect(
          Math.abs(distanceToLine(right.start, left.start, left.end) - thicknessMm),
        ).toBeLessThan(0.001);
      }
    }
    // A non-axis-aligned centerline (3-4-5) keeps the same proof.
    const start: [number, number] = [0, 0];
    const end: [number, number] = [3000, 4000];
    const unit = unitDirection(start, end);
    expect(unit).toEqual([0.6, 0.8]);
    const { left, right } = normals(unit);
    expect(left).toEqual([-0.8, 0.6]);
    expect(right).toEqual([0.8, -0.6]);
    const leftFace = offsetSegment(start, end, left, 75);
    const rightFace = offsetSegment(start, end, right, 75);
    expect(leftFace[0]).toEqual([-60, 45]);
    expect(Math.abs(distanceToLine(leftFace[1], start, end) - 75)).toBeLessThan(1e-9);
    expect(Math.abs(distanceToLine(rightFace[0], leftFace[0], leftFace[1]) - 150)).toBeLessThan(
      1e-9,
    );
  });

  it("does not rewrite room boundaries or emit SceneSpec, assets, cameras, or renderer data", () => {
    for (const name of FIXTURES) {
      const serialized = JSON.stringify(live(name));
      expect(serialized).not.toMatch(
        /"boundary"|sceneSpec|logicalId|"assets"|"cameras"|renderer|renderIntent|"revision/i,
      );
    }
  });
});

// ---------------------------------------------------------- fail closed

describe("fail-closed partition model", () => {
  it("rejects participating walls with different thicknesses (never averages)", () => {
    const inputs = partialShareWith((walls) => {
      (
        walls.find((wall) => wall.candidateId === "wall_candidate_0001_0000") as WallCandidate
      ).thicknessMm = 200;
    });
    const error = partitionError(() => createReviewedPartitionModel(inputs));
    expect(error.code).toBe("CAD_PARTITION_THICKNESS_CONFLICT");
    expect(error.details.thicknessMm).toEqual([150, 200]);
  });

  it.each([
    ["heightMm", 2800],
    ["baseElevationMm", 100],
  ] as const)("rejects participating walls that disagree on %s", (field, value) => {
    const inputs = partialShareWith((walls) => {
      (walls.find((wall) => wall.candidateId === "wall_candidate_0001_0000") as WallCandidate)[
        field
      ] = value;
    });
    expect(codeFor(() => createReviewedPartitionModel(inputs))).toBe(
      "CAD_PARTITION_VERTICAL_CONFLICT",
    );
  });

  it("rejects candidate geometry that puts both spaces on the same side (no ID fallback)", () => {
    const inputs = inputsOf("partial-share");
    const extraction = structuredClone(inputs.architecturalExtraction) as ArchitecturalExtraction;
    const wall = extraction.walls.find(
      (candidate) => candidate.candidateId === "wall_candidate_0001_0000",
    ) as WallCandidate;
    [wall.start, wall.end] = [wall.end, wall.start];
    // 10D itself refuses this; a hash-consistent tampered topology is built by hand.
    const topology = structuredClone(inputs.architecturalTopology);
    topology.source.architecturalExtractionHash = semanticJsonHash(extraction);
    topology.source.spaceWallStageHash = semanticJsonHash({
      level: extraction.level,
      spaces: extraction.spaces,
      walls: extraction.walls,
    });
    const error = partitionError(() =>
      createReviewedPartitionModel({
        ...inputs,
        architecturalExtraction: extraction,
        architecturalTopology: topology,
        approval: approvalFor(topology),
      }),
    );
    expect(error.code).toBe("CAD_PARTITION_SPACE_SIDE_INVALID");
    expect(error.details.sides).toEqual([
      {
        wallCandidateId: "wall_candidate_0000_0002",
        spaceCandidateId: "space_candidate_0000",
        side: "right",
      },
      {
        wallCandidateId: "wall_candidate_0001_0000",
        spaceCandidateId: "space_candidate_0001",
        side: "right",
      },
    ]);
  });

  it("rejects a stale approval after any topology relation changes", () => {
    const inputs = inputsOf("two-room");
    const topology = structuredClone(inputs.architecturalTopology);
    (topology.openingRelations[0] as InteriorOpeningRelation).doorRule.swingDirection =
      "out_of_room";
    const error = partitionError(() =>
      createReviewedPartitionModel({ ...inputs, architecturalTopology: topology }),
    );
    expect(error.code).toBe("CAD_PARTITION_APPROVAL_HASH_MISMATCH");
    expect(error.details.mismatches).toEqual(["architecturalTopologyHash"]);
  });

  it("requires the exact candidate basis and upstream hash chain", () => {
    const two = inputsOf("two-room");
    const three = inputsOf("three-room");
    expect(
      partitionError(() => createReviewedPartitionModel({ ...two, cadDocument: three.cadDocument }))
        .details.mismatches,
    ).toEqual(["sourceHash", "cadDocumentHash", "spaceWallStageHash"]);
    // Stage basis must carry no extraction; extraction basis must carry the exact one.
    expect(
      codeFor(() =>
        createReviewedPartitionModel({
          ...two,
          architecturalExtraction: three.architecturalExtraction,
        }),
      ),
    ).toBe("CAD_PARTITION_INPUT_INVALID");
    expect(
      codeFor(() => createReviewedPartitionModel({ ...three, architecturalExtraction: null })),
    ).toBe("CAD_PARTITION_INPUT_INVALID");
    const otherExtraction = structuredClone(
      three.architecturalExtraction,
    ) as ArchitecturalExtraction;
    otherExtraction.summary.sourceEntityCount += 1;
    expect(
      partitionError(() =>
        createReviewedPartitionModel({ ...three, architecturalExtraction: otherExtraction }),
      ).details.mismatches,
    ).toEqual(["architecturalExtractionHash"]);
  });

  it.each([
    [
      "missing",
      (reviews: CadTopologyApproval["sharedBoundaryReviews"]) => reviews.slice(1),
      "CAD_PARTITION_APPROVAL_REVIEW_MISSING",
    ],
    [
      "unknown",
      (reviews: CadTopologyApproval["sharedBoundaryReviews"]) => [
        ...reviews,
        {
          sharedBoundaryCandidateId: "shared_boundary_9999",
          referencePolicy: "partition_centerline" as const,
        },
      ],
      "CAD_PARTITION_APPROVAL_REVIEW_UNKNOWN",
    ],
    [
      "duplicate",
      (reviews: CadTopologyApproval["sharedBoundaryReviews"]) => [reviews[0], ...reviews],
      "CAD_PARTITION_APPROVAL_REVIEW_DUPLICATE",
    ],
    [
      "unsorted",
      (reviews: CadTopologyApproval["sharedBoundaryReviews"]) => [...reviews].reverse(),
      "CAD_PARTITION_APPROVAL_REVIEW_UNSORTED",
    ],
  ] as const)("rejects a %s shared-boundary review", (_name, edit, code) => {
    const inputs = inputsOf("three-room");
    const approval = structuredClone(inputs.approval);
    approval.sharedBoundaryReviews = edit(
      approval.sharedBoundaryReviews,
    ) as typeof approval.sharedBoundaryReviews;
    expect(codeFor(() => createReviewedPartitionModel({ ...inputs, approval }))).toBe(code);
  });

  it("rejects missing, unknown, and bad-swing interior door reviews", () => {
    const inputs = inputsOf("two-room");
    const withDoors = (interiorDoorReviews: unknown[]) => {
      const approval = structuredClone(inputs.approval);
      approval.interiorDoorReviews = interiorDoorReviews as typeof approval.interiorDoorReviews;
      return () => createReviewedPartitionModel({ ...inputs, approval });
    };
    const review = inputs.approval.interiorDoorReviews[0];
    expect(codeFor(withDoors([]))).toBe("CAD_PARTITION_APPROVAL_REVIEW_MISSING");
    expect(
      codeFor(withDoors([review, { ...review, topologyOpeningId: "topology_opening_0005" }])),
    ).toBe("CAD_PARTITION_APPROVAL_REVIEW_UNKNOWN");
    expect(
      codeFor(withDoors([{ ...review, swingIntoSpaceCandidateId: "space_candidate_0002" }])),
    ).toBe("CAD_PARTITION_DOOR_SWING_SPACE_INVALID");
    expect(codeFor(withDoors([{ ...review, hingeEndpoint: "left" }]))).toBe(
      "CAD_PARTITION_APPROVAL_INVALID",
    );
    const { hingeEndpoint: _omitted, ...withoutHinge } = review as NonNullable<typeof review>;
    expect(codeFor(withDoors([withoutHinge]))).toBe("CAD_PARTITION_APPROVAL_INVALID");
  });

  it("the approval schema admits no geometry override anywhere", () => {
    const inputs = inputsOf("two-room");
    const overrides: ((approval: CadTopologyApproval) => void)[] = [
      (approval) =>
        Object.assign(approval.sharedBoundaryReviews[0] as object, { thicknessMm: 200 }),
      (approval) =>
        Object.assign(approval.sharedBoundaryReviews[0] as object, { worldStart: [0, 0] }),
      (approval) => Object.assign(approval.interiorDoorReviews[0] as object, { widthMm: 1000 }),
      (approval) =>
        Object.assign(approval.interiorDoorReviews[0] as object, { offsetFromWorldStartMm: 0 }),
      (approval) => Object.assign(approval, { heightMm: 2500 }),
      (approval) => Object.assign(approval.topology, { faces: [] }),
      (approval) =>
        Object.assign(approval.sharedBoundaryReviews[0] as object, {
          referencePolicy: "interior_face",
        }),
    ];
    for (const override of overrides) {
      const approval = structuredClone(inputs.approval);
      override(approval);
      expect(validateCadTopologyApproval(approval).ok).toBe(false);
      expect(codeFor(() => createReviewedPartitionModel({ ...inputs, approval }))).toBe(
        "CAD_PARTITION_APPROVAL_INVALID",
      );
    }
  });

  it("only an approved decision produces a model", () => {
    const inputs = inputsOf("two-room");
    for (const decision of ["rejected", "changes_requested"] as const) {
      const approval = { ...structuredClone(inputs.approval), decision };
      expect(codeFor(() => createReviewedPartitionModel({ ...inputs, approval }))).toBe(
        "CAD_PARTITION_APPROVAL_NOT_APPROVED",
      );
    }
  });

  it("names a shared window explicitly when a tampered topology carries one", () => {
    const inputs = inputsOf("two-room");
    const topology = structuredClone(inputs.architecturalTopology) as unknown as {
      openingRelations: { type: string }[];
    };
    (topology.openingRelations[0] as { type: string }).type = "window";
    expect(
      codeFor(() => createReviewedPartitionModel({ ...inputs, architecturalTopology: topology })),
    ).toBe("CAD_PARTITION_SHARED_WINDOW_INVALID");
  });

  it("revalidates (never repairs) the door interval against the partition", () => {
    const inputs = inputsOf("two-room");
    const topology = structuredClone(inputs.architecturalTopology);
    const door = topology.openingRelations[0] as InteriorOpeningRelation;
    door.offsetFromWorldStartMm = 3500;
    door.centerDistanceFromWorldStartMm = 3950;
    door.centerXY = [3000, 3950];
    const approval = approvalFor(topology, inputs.approval.interiorDoorReviews);
    expect(
      codeFor(() =>
        createReviewedPartitionModel({ ...inputs, architecturalTopology: topology, approval }),
      ),
    ).toBe("CAD_PARTITION_OPENING_OUTSIDE_PARTITION");
  });

  it("rejects a topology interval that disagrees with the bound wall candidates", () => {
    const inputs = inputsOf("partial-share");
    const topology = structuredClone(inputs.architecturalTopology);
    const boundary = topology.sharedBoundaries[0];
    if (!boundary) throw new Error("fixture boundary missing");
    boundary.worldEnd = [5000, 3000];
    boundary.lengthMm = 3000;
    expect(
      codeFor(() =>
        createReviewedPartitionModel({
          ...inputs,
          architecturalTopology: topology,
          approval: approvalFor(topology),
        }),
      ),
    ).toBe("CAD_PARTITION_TOPOLOGY_INCONSISTENT");
  });
});

// ---------------------------------------------- determinism / immutability

describe("determinism and immutability", () => {
  it.each(FIXTURES)("%s: repeated creation is deep-equal with the same model hash", (name) => {
    const first = cadPartitionModelEvidence(inputsOf(name));
    const second = cadPartitionModelEvidence(inputsOf(name));
    expect(second.model).toEqual(first.model);
    expect(second.reviewedPartitionModelHash).toBe(first.reviewedPartitionModelHash);
  });

  it("semantically identical approval JSON with reordered properties hashes the same", () => {
    const inputs = inputsOf("two-room");
    const reordered = JSON.parse(
      JSON.stringify(
        Object.fromEntries(Object.entries(inputs.approval).reverse()),
        (_key, value) =>
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).reverse())
            : value,
      ),
    ) as CadTopologyApproval;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(inputs.approval));
    const original = cadPartitionModelEvidence(inputs);
    const result = cadPartitionModelEvidence({ ...inputs, approval: reordered });
    expect(result.evidence.approvalHash).toBe(original.evidence.approvalHash);
    expect(result.reviewedPartitionModelHash).toBe(original.reviewedPartitionModelHash);
  });

  it.each(FIXTURES)("%s: all five deep-frozen inputs are never mutated", (name) => {
    const frozen = deepFreeze(inputsOf(name));
    const before = JSON.stringify(frozen);
    const model = createReviewedPartitionModel(frozen);
    expect(JSON.stringify(frozen)).toBe(before);
    expect(semanticJsonHash(model)).toBe(FROZEN[name].reviewedPartitionModelHash);
  });
});

// ------------------------------------------------------ worker boundary

describe("worker partition boundary", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const workspace = () => {
    const base = mkdtempSync(join(tmpdir(), "avz-cad-10e-"));
    roots.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "inputs"), { recursive: true });
    copyFileSync(
      join(topologyRoot, "two-room", "cad-document-v0.1.json"),
      join(root, "inputs", "doc.json"),
    );
    copyFileSync(join(topologyRoot, "profile-v0.1.json"), join(root, "inputs", "profile.json"));
    copyFileSync(
      join(topologyRoot, "two-room", "expected-architectural-topology-v0.1.json"),
      join(root, "inputs", "topology.json"),
    );
    copyFileSync(
      join(partitionRoot, "two-room", "approval-v0.1.json"),
      join(root, "inputs", "approval.json"),
    );
    mkdirSync(join(base, "outside"));
    return { root, outside: join(base, "outside") };
  };
  const workerCode = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(CadPartitionWorkerError);
      return (error as CadPartitionWorkerError).code;
    }
    throw new Error("expected failure");
  };
  const options = (root: string) => ({
    repositoryRoot: root,
    cadDocumentPath: "inputs/doc.json",
    profilePath: "inputs/profile.json",
    extractionPath: null,
    topologyPath: "inputs/topology.json",
    approvalPath: "inputs/approval.json",
  });

  it("reviews files and writes model + evidence inside the output root", () => {
    const { root } = workspace();
    const result = reviewCadPartitionFiles(options(root));
    expect(result.model).toEqual(expectedModel("two-room"));
    const paths = writeCadPartitionModel(result, join(root, ".workspace"), "cad/two-room.json");
    expect(JSON.parse(readFileSync(paths.modelPath, "utf8"))).toEqual(result.model);
    expect(JSON.parse(readFileSync(paths.evidencePath, "utf8"))).toEqual(result.evidence);
  });

  it("maps pure failures to the same codes and recomputes every hash", () => {
    const inputs = inputsOf("two-room");
    expect(
      workerCode(() =>
        cadPartitionModelEvidence({
          ...inputs,
          approval: { ...inputs.approval, decision: "rejected" },
        }),
      ),
    ).toBe("CAD_PARTITION_APPROVAL_NOT_APPROVED");
  });

  it("uses physical path containment for inputs and outputs", () => {
    const { root, outside } = workspace();
    copyFileSync(
      join(partitionRoot, "two-room", "approval-v0.1.json"),
      join(outside, "approval.json"),
    );
    symlinkSync(
      outside,
      join(root, "linked-in"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      workerCode(() =>
        reviewCadPartitionFiles({ ...options(root), approvalPath: "linked-in/approval.json" }),
      ),
    ).toBe("CAD_PARTITION_INPUT_PATH_INVALID");
    expect(
      workerCode(() =>
        reviewCadPartitionFiles({ ...options(root), topologyPath: "inputs/missing.json" }),
      ),
    ).toBe("CAD_PARTITION_INPUT_NOT_FOUND");
    const result = reviewCadPartitionFiles(options(root));
    for (const outputPath of ["../escape.json", "model.evidence.json", "model.txt"]) {
      expect(
        workerCode(() => writeCadPartitionModel(result, join(root, ".workspace"), outputPath)),
      ).toBe("CAD_PARTITION_OUTPUT_PATH_INVALID");
    }
    expect(
      workerCode(() => writeCadPartitionModel(result, join(root, "inputs"), "approval.json")),
    ).toBe("CAD_PARTITION_OUTPUT_PATH_INVALID");
    expect(existsSync(join(root, "escape.json"))).toBe(false);
  });
});

// ------------------------------------------------------------ static guards

describe("Spike 10E static boundary guards", () => {
  const sourceDirectory = join(repositoryRoot, "packages/cad-partition-model/src");
  const sources = readdirSync(sourceDirectory)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(sourceDirectory, file), "utf8") }));
  const importsOf = (text: string) =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] as string);

  it("cad-partition-model imports only upstream CAD packages, schema utilities, and local modules", () => {
    const allowed = new Set([
      "@ai-archviz/cad-interpreter",
      "@ai-archviz/cad-parser",
      "@ai-archviz/cad-topology",
      "ajv/dist/2020.js",
      "ajv-formats",
      "node:fs",
    ]);
    for (const { file, text } of sources) {
      for (const specifier of importsOf(text)) {
        expect(
          allowed.has(specifier) || /^\.\/[a-z-]+\.js$/.test(specifier),
          `${file}: ${specifier}`,
        ).toBe(true);
      }
      if (file !== "validate.ts") expect(text, file).not.toContain("node:fs");
    }
  });

  it("contains no SceneSpec, worker, DCC, renderer, process, network, AI, or eval code", () => {
    const forbidden =
      /validateSceneSpec|scene-spec|sceneSpecVersion|parseDxfSource|interpretCadDocument\(|analyzeArchitecturalTopology\(|child_process|node:http|node:https|node:net|\bfetch\(|process\.env|\beval\(|new Function|apps\/worker|pymxs|3dsmax|corona|openai|anthropic|confidence|probability|Math\.random|randomUUID|rotationDegrees/i;
    for (const { file, text } of sources) expect(text, file).not.toMatch(forbidden);
  });

  it("keeps the dependency direction parser <- interpreter <- topology <- partition model", () => {
    for (const upstream of [
      "cad-parser",
      "cad-interpreter",
      "cad-topology",
      "scene-spec",
      "cad-scene-seed",
    ]) {
      const directory = join(repositoryRoot, "packages", upstream);
      expect(readFileSync(join(directory, "package.json"), "utf8")).not.toContain(
        "cad-partition-model",
      );
      for (const file of readdirSync(join(directory, "src"))) {
        expect(readFileSync(join(directory, "src", file), "utf8")).not.toContain(
          "cad-partition-model",
        );
      }
    }
    const partitionPackage = JSON.parse(
      readFileSync(join(repositoryRoot, "packages/cad-partition-model/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(partitionPackage.dependencies).sort()).toEqual([
      "@ai-archviz/cad-interpreter",
      "@ai-archviz/cad-parser",
      "@ai-archviz/cad-topology",
      "ajv",
      "ajv-formats",
    ]);
  });

  it("keeps the worker partition boundary free of DCC modules and lexical-only paths", () => {
    const text = readFileSync(
      join(repositoryRoot, "apps/worker/src/cad-partition-model.ts"),
      "utf8",
    );
    expect(importsOf(text).sort()).toEqual([
      "./paths.js",
      "./workspace.js",
      "@ai-archviz/cad-interpreter",
      "@ai-archviz/cad-parser",
      "@ai-archviz/cad-partition-model",
      "@ai-archviz/worker-contracts",
      "node:fs",
      "node:path",
    ]);
    expect(text).not.toMatch(/resolveWithinRoot|child_process|process\.env|dcc-|probe\.js/);
  });

  it("introduces no SceneSpec version and leaves the SceneSpec package untouched", () => {
    const schemas = readdirSync(join(repositoryRoot, "packages/scene-spec/schema"));
    expect(schemas.some((file) => file.includes("v0.5"))).toBe(false);
  });
});
