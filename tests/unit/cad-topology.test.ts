import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ArchitecturalExtraction,
  CadInterpretationError,
  type CadInterpretationProfile,
  deriveSpaceWallStage,
  interpretCadDocument,
  type WallCandidate,
} from "@ai-archviz/cad-interpreter";
import { type CadDocument, parseDxfSource } from "@ai-archviz/cad-parser";
import {
  type ArchitecturalTopology,
  analyzeArchitecturalTopology,
  CAD_TOPOLOGY_EPSILON_MM,
  CAD_TOPOLOGY_POLICY_VERSION,
  CadTopologyError,
  collinearOverlap,
  detectSharedBoundaries,
  type InteriorOpeningRelation,
  type SingleSpaceOpeningRelation,
  validateArchitecturalTopology,
} from "@ai-archviz/cad-topology";
import { semanticJsonHash, validateCadTopologyEvidence } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeCadTopologyFiles,
  CadTopologyWorkerError,
  cadTopologyEvidence,
  writeCadTopology,
} from "../../apps/worker/src/cad-topology.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const topologyRoot = join(repositoryRoot, "tests/fixtures/cad/topology");
const readJson = <T>(...parts: string[]) =>
  JSON.parse(readFileSync(join(topologyRoot, ...parts), "utf8")) as T;
const profile = readJson<CadInterpretationProfile>("profile-v0.1.json");

type FixtureName = "two-room" | "three-room" | "partial-share";
const fixture = (name: FixtureName) => ({
  sourceBytes: new Uint8Array(readFileSync(join(topologyRoot, name, "source.dxf"))),
  cadDocument: readJson<CadDocument>(name, "cad-document-v0.1.json"),
  extraction:
    name === "two-room"
      ? null
      : readJson<ArchitecturalExtraction>(name, "architectural-extraction-v0.1.json"),
  topology: readJson<ArchitecturalTopology>(name, "expected-architectural-topology-v0.1.json"),
  evidence: readJson<Record<string, unknown>>(name, "expected-cad-topology-evidence-v0.1.json"),
});

const PROFILE_HASH = "sha256:120a33f5919cbc03a0c0f7db42f0770cca9645d8bfd4348d8012f269d5b63f39";
const FROZEN: Record<FixtureName, Record<string, string | null>> = {
  "two-room": {
    sourceHash: "sha256:6de69c56aac4cdc9e98f1a658c62974e4af8e53aff9f19382d352b7143fcab9e",
    cadDocumentHash: "sha256:7cdd0a8b9d47a74bc57edec6449594d59c4c46682b568c141475f9e84a3aaf29",
    architecturalExtractionHash: null,
    spaceWallStageHash: "sha256:ab13a1ac0eed9d9deec986e78bb14bbe6b04aa7119467488184a76ac3083a81a",
    architecturalTopologyHash:
      "sha256:d8be5d08652116e14a7f959adf3efcd80148c7615661d2a7448fce68f74c2f59",
  },
  "three-room": {
    sourceHash: "sha256:91b9c1a071fe5aa0d653c345c56606868634b0371f6c7311d3635d64cd709cb3",
    cadDocumentHash: "sha256:7e7f1c913bee1f680fe38dfc28f585e76de71288cf25fcd59d92ce8b2eb313a3",
    architecturalExtractionHash:
      "sha256:1d8d74c7acf790ec0e37c7da3a6cf459a9f92c63541da52a5968b2c49d9f3efd",
    spaceWallStageHash: "sha256:772999dcc0fe31196af9410ebffde72ab49a08729f5c4299cffdc1ffce579635",
    architecturalTopologyHash:
      "sha256:e2fc51c02600758999eb4d8c96fd3ed93e73e8f657e90261a749ec50b6af83c7",
  },
  "partial-share": {
    sourceHash: "sha256:a1cce56833bdacea4ffec530e6b136fe8f3ca4577916497aa2891e2d0f3f4744",
    cadDocumentHash: "sha256:61c9df0415c19dc901ac1ffb67fb34ce05cdb72b0aee2569b5687826bb1ff373",
    architecturalExtractionHash:
      "sha256:f28f5152d0228f982ad28effc4d4943a9a894cd2113f802803fa6a07b15cc40f",
    spaceWallStageHash: "sha256:60dd8770780c5c0f1a004a3599e2453cc757bd8bf8d1f79ae4111968a91d7ea0",
    architecturalTopologyHash:
      "sha256:675d9f334030f736e1491e78c496be5a126091954eab058512565c2975672cc0",
  },
};
const FIXTURES = Object.keys(FROZEN) as FixtureName[];

/** Live analysis of a frozen fixture (content assertions never read the frozen JSON). */
const live = (name: FixtureName) => {
  const { cadDocument, extraction } = fixture(name);
  return analyzeArchitecturalTopology({
    cadDocument,
    interpretationProfile: profile,
    architecturalExtraction: extraction,
  });
};

// ------------------------------------------------------------ DXF builder

type Pair = [number, string | number];
type Point = [number, number];

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
  for (const name of ["0", "A-ROOM", "A-SPACE-TEXT", "A-DOOR", "A-WINDOW"]) {
    pairs.push([0, "LAYER"], [2, name], [70, 0]);
  }
  pairs.push([0, "ENDTAB"], [0, "ENDSEC"], [0, "SECTION"], [2, "BLOCKS"]);
  for (const name of ["DOOR_900_LH_IN", "WINDOW_2400"]) {
    pairs.push([0, "BLOCK"], [8, "0"], [2, name], [70, 0], [10, 0], [20, 0]);
    pairs.push([0, "ENDBLK"], [8, "0"]);
  }
  pairs.push([0, "ENDSEC"], [0, "SECTION"], [2, "ENTITIES"]);
  for (const entity of entities) pairs.push(...entity);
  pairs.push([0, "ENDSEC"], [0, "EOF"]);
  return `${pairs.map(([code, value]) => `${code}\n${value}`).join("\n")}\n`;
}

function room(points: Point[]): Pair[] {
  const pairs: Pair[] = [
    [0, "LWPOLYLINE"],
    [8, "A-ROOM"],
    [90, points.length],
    [70, 1],
  ];
  for (const [x, y] of points) pairs.push([10, x], [20, y]);
  return pairs;
}

const label = (text: string, [x, y]: Point): Pair[] => [
  [0, "TEXT"],
  [8, "A-SPACE-TEXT"],
  [10, x],
  [20, y],
  [40, 200],
  [1, text],
];

const insert = (blockName: string, [x, y]: Point): Pair[] => [
  [0, "INSERT"],
  [8, blockName.startsWith("WINDOW") ? "A-WINDOW" : "A-DOOR"],
  [2, blockName],
  [10, x],
  [20, y],
  [50, 90],
];

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const cadDocumentOf = (entities: Pair[][]) =>
  parseDxfSource(new TextEncoder().encode(dxf(entities)));

/** Topology with the 10B extraction when 10B accepts the drawing, else the stage basis. */
function analyzeDrawing(entities: Pair[][]): ArchitecturalTopology {
  const cadDocument = cadDocumentOf(entities);
  let extraction: ArchitecturalExtraction | null = null;
  try {
    extraction = interpretCadDocument(cadDocument, profile);
  } catch (error) {
    if (!(error instanceof CadInterpretationError)) throw error;
    expect(error.code).toBe("CAD_INTERPRET_OPENING_HOST_AMBIGUOUS");
  }
  return analyzeArchitecturalTopology({
    cadDocument,
    interpretationProfile: profile,
    architecturalExtraction: extraction,
  });
}

function topologyError(action: () => unknown): CadTopologyError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CadTopologyError);
    return error as CadTopologyError;
  }
  throw new Error("expected a CadTopologyError");
}
const codeFor = (action: () => unknown) => topologyError(action).code;

const LIVING = rect(0, 0, 3000, 4000);
const BED = rect(3000, 0, 6000, 4000);
const twoRooms = (...extra: Pair[][]): Pair[][] => [
  room(LIVING),
  room(BED),
  label("LIVING ROOM", [1500, 2000]),
  label("BEDROOM", [4500, 2000]),
  ...extra,
];

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// --------------------------------------------------------------- fixtures

describe("dedicated topology fixtures", () => {
  it.each(FIXTURES)("%s: 10A and 10B reproduce the frozen upstream artifacts", (name) => {
    const { sourceBytes, cadDocument, extraction } = fixture(name);
    expect(parseDxfSource(sourceBytes)).toEqual(cadDocument);
    expect(cadDocument.sourceHash).toBe(FROZEN[name].sourceHash);
    expect(semanticJsonHash(cadDocument)).toBe(FROZEN[name].cadDocumentHash);
    expect(semanticJsonHash(profile)).toBe(PROFILE_HASH);
    if (extraction) {
      expect(interpretCadDocument(cadDocument, profile)).toEqual(extraction);
      expect(semanticJsonHash(extraction)).toBe(FROZEN[name].architecturalExtractionHash);
    }
  });

  it("two-room: the historical 10B v0.1 API still rejects the shared door as ambiguous", () => {
    const { cadDocument } = fixture("two-room");
    let caught: unknown;
    try {
      interpretCadDocument(cadDocument, profile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CadInterpretationError);
    expect((caught as CadInterpretationError).code).toBe("CAD_INTERPRET_OPENING_HOST_AMBIGUOUS");
    expect((caught as CadInterpretationError).details.hostWallCandidateIds).toEqual([
      "wall_candidate_0000_0001",
      "wall_candidate_0001_0003",
    ]);
  });

  it.each(FIXTURES)("%s: live topology and evidence equal the frozen fixtures", (name) => {
    const { cadDocument, extraction, topology, evidence } = fixture(name);
    const result = cadTopologyEvidence({
      cadDocument,
      interpretationProfile: profile,
      architecturalExtraction: extraction,
    });
    expect(result.topology).toEqual(topology);
    expect(result.evidence).toEqual(evidence);
    expect(validateArchitecturalTopology(result.topology).ok).toBe(true);
    expect(validateCadTopologyEvidence(result.evidence).ok).toBe(true);
    const frozen = FROZEN[name];
    expect(result.architecturalTopologyHash).toBe(frozen.architecturalTopologyHash);
    expect(semanticJsonHash(result.topology)).toBe(frozen.architecturalTopologyHash);
    expect(result.topology.source).toEqual({
      sourceFormat: "dxf",
      sourceHash: frozen.sourceHash,
      cadDocumentVersion: "0.1.0",
      cadDocumentHash: frozen.cadDocumentHash,
      profileId: "topology_fixture_profile",
      profileHash: PROFILE_HASH,
      interpretationPolicyVersion: "cad-interpretation-policy-v0.1",
      architecturalExtractionVersion: "0.1.0",
      candidateBasis: extraction ? "architectural_extraction" : "space_wall_stage",
      architecturalExtractionHash: frozen.architecturalExtractionHash,
      spaceWallStageHash: frozen.spaceWallStageHash,
    });
    expect(result.topology.topologyPolicyVersion).toBe(CAD_TOPOLOGY_POLICY_VERSION);
    expect(result.topology.identityScope).toBe("topology_local_non_canonical");
    expect(result.topology.status).toBe("READY_FOR_REVIEW");
  });

  it("two-room: one shared boundary, one adjacency, one interior door, six unpaired walls", () => {
    const topology = live("two-room");
    expect(topology.summary).toEqual({
      spaceCount: 2,
      wallCandidateCount: 8,
      sharedBoundaryCount: 1,
      adjacencyCount: 1,
      singleSpaceOpeningCount: 0,
      interiorOpeningCount: 1,
      unpairedWallCount: 6,
      sharedParticipantWallCount: 2,
    });
    // Full edge A (living east, up) against full edge B (bedroom west, down).
    expect(topology.sharedBoundaries).toHaveLength(1);
    const [shared] = topology.sharedBoundaries;
    expect(shared).toMatchObject({
      sharedBoundaryCandidateId: "shared_boundary_0000",
      relationship: "shared_partition_boundary",
      spaceCandidateIds: ["space_candidate_0000", "space_candidate_0001"],
      wallCandidateIds: ["wall_candidate_0000_0001", "wall_candidate_0001_0003"],
      worldStart: [3000, 0],
      worldEnd: [3000, 4000],
      lengthMm: 4000,
      directionRelationship: "opposite",
    });
    expect(topology.spaceAdjacencies).toEqual([
      expect.objectContaining({
        spaceAdjacencyCandidateId: "space_adjacency_0000_0001",
        spaceCandidateIds: ["space_candidate_0000", "space_candidate_0001"],
        sharedBoundaryCandidateIds: ["shared_boundary_0000"],
        totalSharedLengthMm: 4000,
      }),
    ]);
    // No 10B wall merging: all eight per-space candidates are still there.
    expect(topology.wallClassifications.map((wall) => wall.wallCandidateId)).toEqual([
      "wall_candidate_0000_0000",
      "wall_candidate_0000_0001",
      "wall_candidate_0000_0002",
      "wall_candidate_0000_0003",
      "wall_candidate_0001_0000",
      "wall_candidate_0001_0001",
      "wall_candidate_0001_0002",
      "wall_candidate_0001_0003",
    ]);
    expect(topology.spaces.map((space) => [space.spaceCandidateId, space.spaceType])).toEqual([
      ["space_candidate_0000", "living_room"],
      ["space_candidate_0001", "bedroom"],
    ]);
  });

  it("two-room: the single door INSERT becomes exactly one interior relation between both rooms", () => {
    const topology = live("two-room");
    const { cadDocument } = fixture("two-room");
    const doorInserts = cadDocument.entities.filter((entity) => entity.type === "INSERT");
    expect(doorInserts).toHaveLength(1);
    expect(topology.openingRelations).toHaveLength(1);
    const door = topology.openingRelations[0] as InteriorOpeningRelation;
    expect(door).toMatchObject({
      topologyOpeningId: "topology_opening_0000",
      relationKind: "interior_shared_boundary",
      type: "door",
      openingSourceOrdinal: doorInserts[0]?.sourceOrdinal,
      openingSourceHandle: "104",
      blockName: "DOOR_900_LH_IN",
      connectsSpaces: ["space_candidate_0000", "space_candidate_0001"],
      sharedBoundaryCandidateId: "shared_boundary_0000",
      centerXY: [3000, 2000],
      hostDistanceMm: 0,
      centerDistanceFromWorldStartMm: 2000,
      offsetFromWorldStartMm: 1550,
      resolvedWidthMm: 900,
      resolvedHeightMm: 2100,
      resolvedSillMm: 0,
      doorRule: { ruleId: "door_900_lh_in", hingeSide: "start_jamb", swingDirection: "into_room" },
    });
    expect(door.provenance.host).toEqual([
      { authority: "cad", sourceOrdinal: 4, sourceHandle: "104", role: "door_insert" },
      { authority: "shared_boundary", sharedBoundaryCandidateId: "shared_boundary_0000" },
      { authority: "derived", derivation: "shared_opening_resolution_v0.1" },
    ]);
    expect(door.provenance.resolvedWidthMm).toEqual([
      { authority: "profile", field: "doorRules.widthMm", ruleId: "door_900_lh_in" },
    ]);
    // The whole opening lies within the shared interval.
    expect(door.offsetFromWorldStartMm).toBeGreaterThanOrEqual(0);
    expect(door.offsetFromWorldStartMm + door.resolvedWidthMm).toBeLessThanOrEqual(4000);
  });

  it("three-room: one long hall edge shares two disjoint intervals with two rooms", () => {
    const topology = live("three-room");
    expect(
      topology.sharedBoundaries.map((boundary) => [
        boundary.sharedBoundaryCandidateId,
        boundary.spaceCandidateIds,
        boundary.wallCandidateIds,
        boundary.worldStart,
        boundary.worldEnd,
        boundary.lengthMm,
      ]),
    ).toEqual([
      [
        "shared_boundary_0000",
        ["space_candidate_0000", "space_candidate_0001"],
        ["wall_candidate_0000_0001", "wall_candidate_0001_0003"],
        [2000, 0],
        [2000, 3000],
        3000,
      ],
      [
        "shared_boundary_0001",
        ["space_candidate_0000", "space_candidate_0002"],
        ["wall_candidate_0000_0001", "wall_candidate_0002_0003"],
        [2000, 5000],
        [2000, 8000],
        3000,
      ],
    ]);
    expect(
      topology.spaceAdjacencies.map((adjacency) => [
        adjacency.spaceAdjacencyCandidateId,
        adjacency.sharedBoundaryCandidateIds,
      ]),
    ).toEqual([
      ["space_adjacency_0000_0001", ["shared_boundary_0000"]],
      ["space_adjacency_0000_0002", ["shared_boundary_0001"]],
    ]);
    const hallEast = topology.wallClassifications.find(
      (wall) => wall.wallCandidateId === "wall_candidate_0000_0001",
    );
    expect(hallEast).toEqual({
      wallCandidateId: "wall_candidate_0000_0001",
      spaceCandidateId: "space_candidate_0000",
      boundaryRole: "shared_boundary_participant",
      sharedBoundaryCandidateIds: ["shared_boundary_0000", "shared_boundary_0001"],
      lengthMm: 8000,
      sharedLengthMm: 6000,
      unpairedLengthMm: 2000,
    });
    // Interval positions along each wall's own direction.
    expect(topology.sharedBoundaries[1]?.wallIntervals).toEqual([
      {
        wallCandidateId: "wall_candidate_0000_0001",
        spaceCandidateId: "space_candidate_0000",
        fromMm: 5000,
        toMm: 8000,
      },
      {
        wallCandidateId: "wall_candidate_0002_0003",
        spaceCandidateId: "space_candidate_0002",
        fromMm: 0,
        toMm: 3000,
      },
    ]);
    expect(topology.summary.unpairedWallCount).toBe(9);
  });

  it("three-room: a perpendicular T-junction endpoint is not a shared boundary", () => {
    const topology = live("three-room");
    // Living north (6000,3000)->(2000,3000) ends ON the hall east edge.
    const livingNorth = topology.wallClassifications.find(
      (wall) => wall.wallCandidateId === "wall_candidate_0001_0002",
    );
    expect(livingNorth?.boundaryRole).toBe("exterior_or_unpaired");
    expect(livingNorth?.sharedBoundaryCandidateIds).toEqual([]);
  });

  it("partial-share: exact overlap interval, partial wall classification, T-junction ends", () => {
    const topology = live("partial-share");
    expect(topology.sharedBoundaries).toHaveLength(1);
    expect(topology.sharedBoundaries[0]).toMatchObject({
      wallCandidateIds: ["wall_candidate_0000_0002", "wall_candidate_0001_0000"],
      worldStart: [2000, 3000],
      worldEnd: [4500, 3000],
      lengthMm: 2500,
      wallIntervals: [
        {
          wallCandidateId: "wall_candidate_0000_0002",
          spaceCandidateId: "space_candidate_0000",
          fromMm: 1500,
          toMm: 4000,
        },
        {
          wallCandidateId: "wall_candidate_0001_0000",
          spaceCandidateId: "space_candidate_0001",
          fromMm: 0,
          toMm: 2500,
        },
      ],
    });
    const byId = new Map(topology.wallClassifications.map((wall) => [wall.wallCandidateId, wall]));
    expect(byId.get("wall_candidate_0000_0002")).toMatchObject({
      boundaryRole: "shared_boundary_participant",
      sharedLengthMm: 2500,
      unpairedLengthMm: 3500,
    });
    expect(byId.get("wall_candidate_0001_0000")).toMatchObject({
      sharedLengthMm: 2500,
      unpairedLengthMm: 0,
    });
    // Bedroom side walls terminate on the living north edge (T-junctions).
    for (const id of ["wall_candidate_0001_0001", "wall_candidate_0001_0003"]) {
      expect(byId.get(id)?.boundaryRole).toBe("exterior_or_unpaired");
    }
  });

  it("every 10B wall candidate is classified exactly once; nothing disappears", () => {
    for (const name of FIXTURES) {
      const topology = live(name);
      const walls =
        fixture(name).extraction?.walls ??
        deriveSpaceWallStage(fixture(name).cadDocument, profile).walls;
      expect(topology.wallClassifications.map((wall) => wall.wallCandidateId)).toEqual(
        walls.map((wall) => wall.candidateId).sort(),
      );
      for (const wall of topology.wallClassifications) {
        expect(wall.boundaryRole === "shared_boundary_participant").toBe(
          wall.sharedBoundaryCandidateIds.length > 0,
        );
        expect(wall.sharedLengthMm + wall.unpairedLengthMm).toBeCloseTo(wall.lengthMm, 9);
      }
    }
  });

  it("evidence carries identity and counts only (no geometry arrays, no paths)", () => {
    for (const name of FIXTURES) {
      const { evidence } = fixture(name);
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toMatch(/worldStart|boundary"|centerXY|\[\s*-?\d/);
      expect(serialized).not.toMatch(/[A-Za-z]:\\|\/home\/|Users|fixtures|\.json/);
      expect(Object.keys(evidence)).not.toContain("sharedBoundaries");
    }
  });
});

// -------------------------------------------------------------- geometry

describe("shared-boundary geometry", () => {
  it("orients the overlap canonically regardless of which wall is visited first", () => {
    const up = collinearOverlap([3000, 0], [3000, 4000], [3000, 4000], [3000, 0]);
    const down = collinearOverlap([3000, 4000], [3000, 0], [3000, 0], [3000, 4000]);
    expect(up).toEqual({
      worldStart: [3000, 0],
      worldEnd: [3000, 4000],
      lengthMm: 4000,
      direction: "opposite",
    });
    expect(down).toEqual(up);
    const leftward = collinearOverlap([6000, 3000], [0, 3000], [2000, 3000], [4500, 3000]);
    expect(leftward).toMatchObject({ worldStart: [2000, 3000], worldEnd: [4500, 3000] });
  });

  it("takes overlap endpoints verbatim from the input endpoints (no synthesized coordinates)", () => {
    const overlap = collinearOverlap([0, 0], [7000, 7000], [5000, 5000], [1234.5, 1234.5]);
    expect(overlap).toMatchObject({ worldStart: [1234.5, 1234.5], worldEnd: [5000, 5000] });
  });

  it.each([
    ["corner point contact", [0, 0], [3000, 0], [3000, 0], [3000, 3000]],
    ["collinear end-to-end touch", [0, 0], [3000, 0], [3000, 0], [6000, 0]],
    ["perpendicular T endpoint", [0, 3000], [6000, 3000], [2000, 3000], [2000, 6000]],
    ["parallel 150 mm gap", [3000, 0], [3000, 4000], [3150, 4000], [3150, 0]],
    ["overlap no longer than epsilon", [0, 0], [3000, 0], [3005, 0], [2999.9995, 0]],
  ] as [string, Point, Point, Point, Point][])(
    "%s is not a shared boundary",
    (_name, a, b, c, d) => {
      expect(collinearOverlap(a, b, c, d)).toBe(null);
    },
  );

  it("an overlap just longer than epsilon is shared", () => {
    expect(
      collinearOverlap([0, 0], [3000, 0], [3005, 0], [3000 - 2 * CAD_TOPOLOGY_EPSILON_MM, 0]),
    ).toMatchObject({ worldStart: [3000 - 2 * CAD_TOPOLOGY_EPSILON_MM, 0], worldEnd: [3000, 0] });
  });

  it("two spaces touching only at a corner have no shared boundary and no adjacency", () => {
    const topology = analyzeDrawing([
      room(rect(0, 0, 3000, 3000)),
      room(rect(3000, 3000, 6000, 6000)),
      label("LIVING ROOM", [1500, 1500]),
      label("BEDROOM", [4500, 4500]),
    ]);
    expect(topology.source.candidateBasis).toBe("architectural_extraction");
    expect(topology.sharedBoundaries).toEqual([]);
    expect(topology.spaceAdjacencies).toEqual([]);
    expect(topology.summary.unpairedWallCount).toBe(8);
  });

  it("parallel walls separated by a 150 mm gap are not shared (no thickness inference)", () => {
    const topology = analyzeDrawing([
      room(rect(0, 0, 3000, 4000)),
      room(rect(3150, 0, 6000, 4000)),
      label("LIVING ROOM", [1500, 2000]),
      label("BEDROOM", [4500, 2000]),
    ]);
    expect(topology.sharedBoundaries).toEqual([]);
    expect(topology.spaceAdjacencies).toEqual([]);
    expect(
      topology.wallClassifications.every((wall) => wall.boundaryRole === "exterior_or_unpaired"),
    ).toBe(true);
  });

  it("two disjoint intervals between the same two spaces form ONE adjacency", () => {
    // A C-shaped bedroom meets the living room's east edge twice; a hall
    // fills the notch between the two intervals.
    const topology = analyzeDrawing([
      room([
        [0, 0],
        [3000, 0],
        [3000, 9000],
        [0, 9000],
      ]),
      room([
        [3000, 0],
        [6000, 0],
        [6000, 9000],
        [3000, 9000],
        [3000, 6000],
        [4000, 6000],
        [4000, 3000],
        [3000, 3000],
      ]),
      room(rect(3000, 3000, 4000, 6000)),
      label("LIVING ROOM", [1500, 4500]),
      label("BEDROOM", [5000, 4500]),
      label("HALL", [3500, 4500]),
    ]);
    const livingBed = topology.spaceAdjacencies.find(
      (adjacency) => adjacency.spaceAdjacencyCandidateId === "space_adjacency_0000_0001",
    );
    expect(livingBed?.sharedBoundaryCandidateIds).toHaveLength(2);
    expect(livingBed?.totalSharedLengthMm).toBe(6000);
    expect(topology.spaceAdjacencies.map((adjacency) => adjacency.spaceCandidateIds)).toEqual([
      ["space_candidate_0000", "space_candidate_0001"],
      ["space_candidate_0000", "space_candidate_0002"],
      ["space_candidate_0001", "space_candidate_0002"],
    ]);
  });
});

// ---------------------------------------------------------- fail closed

describe("fail-closed topology", () => {
  const threeRoom = () => structuredClone(fixture("three-room")) as ReturnType<typeof fixture>;
  const withWalls = (mutate: (walls: WallCandidate[]) => void) => {
    const { cadDocument, extraction } = threeRoom();
    mutate((extraction as ArchitecturalExtraction).walls);
    return () =>
      analyzeArchitecturalTopology({
        cadDocument,
        interpretationProfile: profile,
        architecturalExtraction: extraction,
      });
  };
  const setWall = (walls: WallCandidate[], id: string, start: Point, end: Point) => {
    const wall = walls.find((candidate) => candidate.candidateId === id) as WallCandidate;
    wall.start = start;
    wall.end = end;
    wall.lengthMm = Math.hypot(end[0] - start[0], end[1] - start[1]);
  };

  it("rejects overlapping shared intervals from two neighbors on one wall", () => {
    const error = topologyError(
      withWalls((walls) =>
        // Bedroom west wall now reaches down to y=2000, overlapping living's 0..3000.
        setWall(walls, "wall_candidate_0002_0003", [2000, 8000], [2000, 2000]),
      ),
    );
    expect(error.code).toBe("CAD_TOPOLOGY_SHARED_INTERVAL_CONFLICT");
    expect(error.details).toMatchObject({
      wallCandidateId: "wall_candidate_0000_0001",
      conflictingWallCandidateIds: ["wall_candidate_0001_0003", "wall_candidate_0002_0003"],
      neighborSpaceCandidateIds: ["space_candidate_0001", "space_candidate_0002"],
      overlapMm: 1000,
    });
  });

  it("rejects same-direction coincident shared edges instead of silently reversing them", () => {
    const error = topologyError(
      withWalls((walls) => setWall(walls, "wall_candidate_0001_0003", [2000, 0], [2000, 3000])),
    );
    expect(error.code).toBe("CAD_TOPOLOGY_SHARED_EDGE_DIRECTION_INVALID");
    expect(error.details).toMatchObject({
      wallCandidateIds: ["wall_candidate_0000_0001", "wall_candidate_0001_0003"],
    });
    expect(
      codeFor(() =>
        detectSharedBoundaries([
          {
            candidateId: "wall_candidate_0000_0001",
            spaceCandidateId: "space_candidate_0000",
            start: [3000, 0],
            end: [3000, 4000],
            lengthMm: 4000,
          },
          {
            candidateId: "wall_candidate_0001_0003",
            spaceCandidateId: "space_candidate_0001",
            start: [3000, 0],
            end: [3000, 4000],
            lengthMm: 4000,
          },
        ]),
      ),
    ).toBe("CAD_TOPOLOGY_SHARED_EDGE_DIRECTION_INVALID");
  });

  it("rejects an interior door whose width extends beyond the shared interval", () => {
    const error = topologyError(() =>
      analyzeDrawing([
        room(rect(0, 0, 6000, 3000)),
        room(rect(2000, 3000, 4500, 6000)),
        label("LIVING ROOM", [3000, 1500]),
        label("BEDROOM", [3250, 4500]),
        insert("DOOR_900_LH_IN", [2300, 3000]),
      ]),
    );
    expect(error.code).toBe("CAD_TOPOLOGY_OPENING_OUTSIDE_SHARED_BOUNDARY");
    expect(error.details).toMatchObject({
      sharedBoundaryCandidateId: "shared_boundary_0000",
      centerDistanceFromWorldStartMm: 300,
      widthMm: 900,
      sharedLengthMm: 2500,
    });
  });

  it("accepts the same door once it fits the shared interval", () => {
    const topology = analyzeDrawing([
      room(rect(0, 0, 6000, 3000)),
      room(rect(2000, 3000, 4500, 6000)),
      label("LIVING ROOM", [3000, 1500]),
      label("BEDROOM", [3250, 4500]),
      insert("DOOR_900_LH_IN", [2450, 3000]),
    ]);
    const door = topology.openingRelations[0] as InteriorOpeningRelation;
    expect(door.offsetFromWorldStartMm).toBe(0);
    expect(door.centerDistanceFromWorldStartMm).toBe(450);
  });

  it("rejects a door centered on a junction of two shared intervals (never picks nearest)", () => {
    const error = topologyError(() =>
      analyzeDrawing([
        room(rect(0, 0, 2000, 8000)),
        room(rect(2000, 0, 6000, 4000)),
        room(rect(2000, 4000, 6000, 8000)),
        label("HALL", [1000, 4000]),
        label("LIVING ROOM", [4000, 2000]),
        label("BEDROOM", [4000, 6000]),
        insert("DOOR_900_LH_IN", [2000, 4000]),
      ]),
    );
    expect(error.code).toBe("CAD_TOPOLOGY_OPENING_AMBIGUOUS");
    expect(error.details).toMatchObject({
      reason: "MULTIPLE_SHARED_BOUNDARIES",
      // Hall|living, hall|bedroom, and living|bedroom all meet at [2000, 4000].
      sharedBoundaryCandidateIds: [
        "shared_boundary_0000",
        "shared_boundary_0001",
        "shared_boundary_0002",
      ],
    });
  });

  it("rejects a mapped window on a room-to-room shared boundary", () => {
    expect(codeFor(() => analyzeDrawing(twoRooms(insert("WINDOW_2400", [3000, 2000]))))).toBe(
      "CAD_TOPOLOGY_WINDOW_ON_SHARED_BOUNDARY_UNSUPPORTED",
    );
  });

  it("rejects an extraction opening that claims one host but lies on a shared boundary", () => {
    const { cadDocument, extraction } = threeRoom();
    const opening = (extraction as ArchitecturalExtraction).openings[0];
    if (!opening) throw new Error("fixture opening missing");
    opening.sourceCenter = [2000, 1500];
    expect(
      codeFor(() =>
        analyzeArchitecturalTopology({
          cadDocument,
          interpretationProfile: profile,
          architecturalExtraction: extraction,
        }),
      ),
    ).toBe("CAD_TOPOLOGY_OPENING_AMBIGUOUS");
  });

  it("uses the stage basis only when 10B v0.1 itself cannot produce an extraction", () => {
    const { cadDocument } = fixture("three-room");
    expect(
      codeFor(() =>
        analyzeArchitecturalTopology({
          cadDocument,
          interpretationProfile: profile,
          architecturalExtraction: null,
        }),
      ),
    ).toBe("CAD_TOPOLOGY_EXTRACTION_REQUIRED");
  });

  it("reports 10B rejections (never reinterprets them) in the stage basis", () => {
    const error = topologyError(() =>
      analyzeArchitecturalTopology({
        cadDocument: cadDocumentOf([
          room(rect(0, 0, 3000, 4000)),
          room(rect(2000, 0, 6000, 4000)),
          label("LIVING ROOM", [1000, 2000]),
          label("BEDROOM", [4500, 2000]),
        ]),
        interpretationProfile: profile,
        architecturalExtraction: null,
      }),
    );
    expect(error.code).toBe("CAD_TOPOLOGY_INTERPRETATION_REJECTED");
    expect(error.details.interpretationErrorCode).toBe("CAD_INTERPRET_SPACE_OVERLAP");
    expect(
      topologyError(() =>
        analyzeDrawing(
          twoRooms(insert("DOOR_900_LH_IN", [3000, 2000]), insert("DOOR_900_LH_IN", [7000, 7000])),
        ),
      ).details.interpretationErrorCode,
    ).toBe("CAD_INTERPRET_OPENING_HOST_UNRESOLVED");
  });

  it("requires the exact hash chain between cad-document, profile, and extraction", () => {
    const two = fixture("two-room");
    const three = fixture("three-room");
    const mismatch = topologyError(() =>
      analyzeArchitecturalTopology({
        cadDocument: two.cadDocument,
        interpretationProfile: profile,
        architecturalExtraction: three.extraction,
      }),
    );
    expect(mismatch.code).toBe("CAD_TOPOLOGY_INPUT_HASH_MISMATCH");
    expect(mismatch.details.mismatches).toEqual(["sourceHash", "cadDocumentHash"]);
    const otherProfile = { ...structuredClone(profile), profileId: "another_profile" };
    expect(
      topologyError(() =>
        analyzeArchitecturalTopology({
          cadDocument: three.cadDocument,
          interpretationProfile: otherProfile,
          architecturalExtraction: three.extraction,
        }),
      ).details.mismatches,
    ).toEqual(["profileHash", "profileId"]);
  });

  it("validates every input artifact before analysis", () => {
    const three = fixture("three-room");
    const invalid = [
      { cadDocument: three.cadDocument, interpretationProfile: profile },
      {
        cadDocument: { ...three.cadDocument, extra: true },
        interpretationProfile: profile,
        architecturalExtraction: three.extraction,
      },
      {
        cadDocument: three.cadDocument,
        interpretationProfile: { ...profile, layers: {} },
        architecturalExtraction: three.extraction,
      },
      {
        cadDocument: three.cadDocument,
        interpretationProfile: profile,
        architecturalExtraction: { ...three.extraction, status: "APPROVED" },
      },
    ];
    for (const input of invalid) {
      expect(
        codeFor(() =>
          analyzeArchitecturalTopology(input as Parameters<typeof analyzeArchitecturalTopology>[0]),
        ),
      ).toBe("CAD_TOPOLOGY_INPUT_INVALID");
    }
  });
});

// -------------------------------------------------------------- openings

describe("opening topology", () => {
  it("preserves uniquely hosted extraction openings verbatim as single-space relations", () => {
    const topology = live("three-room");
    const extraction = fixture("three-room").extraction as ArchitecturalExtraction;
    const single = topology.openingRelations as SingleSpaceOpeningRelation[];
    expect(single.map((relation) => relation.relationKind)).toEqual([
      "single_space",
      "single_space",
      "single_space",
    ]);
    expect(single.map((relation) => relation.openingCandidate)).toEqual(extraction.openings);
    expect(single.map((relation) => relation.connectsSpaces)).toEqual([
      ["space_candidate_0000"],
      ["space_candidate_0001"],
      ["space_candidate_0002"],
    ]);
    expect(single[0]?.provenance.relation[0]).toEqual({
      authority: "opening_candidate",
      openingCandidateId: "opening_candidate_0000",
      basisHash: FROZEN["three-room"].architecturalExtractionHash,
    });
  });

  it("stage basis: unshared openings equal exactly what 10B produces for them", () => {
    const exterior = [insert("WINDOW_2400", [1500, 0]), insert("DOOR_900_LH_IN", [6000, 2000])];
    const withShared = analyzeDrawing(
      twoRooms(...exterior, insert("DOOR_900_LH_IN", [3000, 2000])),
    );
    expect(withShared.source.candidateBasis).toBe("space_wall_stage");
    const tenB = interpretCadDocument(cadDocumentOf(twoRooms(...exterior)), profile);
    const relations = withShared.openingRelations;
    expect(relations.map((relation) => relation.relationKind)).toEqual([
      "single_space",
      "single_space",
      "interior_shared_boundary",
    ]);
    expect(
      relations
        .filter((relation) => relation.relationKind === "single_space")
        .map((relation) => (relation as SingleSpaceOpeningRelation).openingCandidate),
    ).toEqual(tenB.openings);
    expect(withShared.summary).toMatchObject({
      singleSpaceOpeningCount: 2,
      interiorOpeningCount: 1,
    });
  });

  it("orders opening relations by source ordinal with topology-local IDs", () => {
    const topology = analyzeDrawing(
      twoRooms(insert("DOOR_900_LH_IN", [3000, 2000]), insert("WINDOW_2400", [1500, 0])),
    );
    expect(
      topology.openingRelations.map((relation) => [
        relation.topologyOpeningId,
        relation.openingSourceOrdinal,
        relation.relationKind,
      ]),
    ).toEqual([
      ["topology_opening_0000", 4, "interior_shared_boundary"],
      ["topology_opening_0001", 5, "single_space"],
    ]);
  });
});

// ---------------------------------------------------- 10B compatibility

describe("10B refactor compatibility", () => {
  it("the shared space/wall stage is exactly the extraction's level, spaces, and walls", () => {
    const simple = join(repositoryRoot, "tests/fixtures/cad/interpretation/simple-living-room");
    const cases: [unknown, unknown, ArchitecturalExtraction][] = [
      [
        JSON.parse(readFileSync(join(simple, "cad-document-v0.1.json"), "utf8")),
        JSON.parse(readFileSync(join(simple, "profile-v0.1.json"), "utf8")),
        JSON.parse(
          readFileSync(join(simple, "expected-architectural-extraction-v0.1.json"), "utf8"),
        ),
      ],
      ...(["three-room", "partial-share"] as const).map(
        (name): [unknown, unknown, ArchitecturalExtraction] => [
          fixture(name).cadDocument,
          profile,
          fixture(name).extraction as ArchitecturalExtraction,
        ],
      ),
    ];
    for (const [cadDocument, withProfile, extraction] of cases) {
      const stage = deriveSpaceWallStage(cadDocument, withProfile);
      expect(stage.level).toEqual(extraction.level);
      expect(stage.spaces).toEqual(extraction.spaces);
      expect(stage.walls).toEqual(extraction.walls);
      expect(stage.unconsumedEntities).toEqual(extraction.unconsumedEntities);
      expect(stage.openingSources).toHaveLength(extraction.openings.length);
    }
    expect(
      semanticJsonHash({
        level: fixture("three-room").extraction?.level,
        spaces: fixture("three-room").extraction?.spaces,
        walls: fixture("three-room").extraction?.walls,
      }),
    ).toBe(FROZEN["three-room"].spaceWallStageHash);
  });
});

// ---------------------------------------------- determinism / immutability

describe("determinism and immutability", () => {
  it.each(FIXTURES)("%s: repeated analysis is deep-equal with the same hash", (name) => {
    const first = live(name);
    const second = live(name);
    expect(second).toEqual(first);
    expect(semanticJsonHash(second)).toBe(semanticJsonHash(first));
  });

  it.each(FIXTURES)("%s: deep-frozen inputs are never mutated", (name) => {
    const { cadDocument, extraction } = fixture(name);
    const frozenInput = deepFreeze({
      cadDocument,
      interpretationProfile: structuredClone(profile),
      architecturalExtraction: extraction,
    });
    const before = JSON.stringify(frozenInput);
    const topology = analyzeArchitecturalTopology(frozenInput);
    expect(JSON.stringify(frozenInput)).toBe(before);
    expect(semanticJsonHash(topology)).toBe(FROZEN[name].architecturalTopologyHash);
  });

  it("contains no SceneSpec, canonical wall decision, or DCC data", () => {
    for (const name of FIXTURES) {
      const serialized = JSON.stringify(live(name));
      expect(serialized).not.toMatch(
        /sceneSpec|logicalId|"walls"|centerline|dual_space|3dsmax|\.max"|renderIntent/i,
      );
    }
  });
});

// ------------------------------------------------------ worker boundary

describe("worker topology boundary", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const workspace = () => {
    const base = mkdtempSync(join(tmpdir(), "avz-cad-10d-"));
    roots.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "inputs"), { recursive: true });
    for (const name of ["two-room", "three-room"] as const) {
      copyFileSync(
        join(topologyRoot, name, "cad-document-v0.1.json"),
        join(root, "inputs", `${name}-doc.json`),
      );
    }
    copyFileSync(
      join(topologyRoot, "three-room", "architectural-extraction-v0.1.json"),
      join(root, "inputs", "three-room-extraction.json"),
    );
    copyFileSync(join(topologyRoot, "profile-v0.1.json"), join(root, "inputs", "profile.json"));
    mkdirSync(join(base, "outside"));
    return { root, outside: join(base, "outside") };
  };
  const linkDirectory = (target: string, path: string) =>
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  const workerCode = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(CadTopologyWorkerError);
      return (error as CadTopologyWorkerError).code;
    }
    throw new Error("expected failure");
  };

  it("analyzes both bases from files and writes topology + evidence inside the output root", () => {
    const { root } = workspace();
    const stage = analyzeCadTopologyFiles({
      repositoryRoot: root,
      cadDocumentPath: "inputs/two-room-doc.json",
      profilePath: "inputs/profile.json",
      extractionPath: null,
    });
    expect(stage.topology).toEqual(fixture("two-room").topology);
    const withExtraction = analyzeCadTopologyFiles({
      repositoryRoot: root,
      cadDocumentPath: "inputs/three-room-doc.json",
      profilePath: "inputs/profile.json",
      extractionPath: "inputs/three-room-extraction.json",
    });
    expect(withExtraction.evidence).toEqual(fixture("three-room").evidence);
    const paths = writeCadTopology(stage, join(root, ".workspace"), "cad/two-room.json");
    expect(JSON.parse(readFileSync(paths.topologyPath, "utf8"))).toEqual(stage.topology);
    expect(JSON.parse(readFileSync(paths.evidencePath, "utf8"))).toEqual(stage.evidence);
    expect(paths.evidencePath.endsWith("two-room.evidence.json")).toBe(true);
  });

  it("maps pure topology failures to the same codes at the worker boundary", () => {
    const two = fixture("two-room");
    expect(
      workerCode(() =>
        cadTopologyEvidence({
          cadDocument: two.cadDocument,
          interpretationProfile: profile,
          architecturalExtraction: fixture("three-room").extraction,
        }),
      ),
    ).toBe("CAD_TOPOLOGY_INPUT_HASH_MISMATCH");
  });

  it("uses physical path containment for inputs and outputs", () => {
    const { root, outside } = workspace();
    copyFileSync(join(topologyRoot, "profile-v0.1.json"), join(outside, "profile.json"));
    linkDirectory(outside, join(root, "linked-in"));
    const files = (overrides: Partial<Parameters<typeof analyzeCadTopologyFiles>[0]>) => () =>
      analyzeCadTopologyFiles({
        repositoryRoot: root,
        cadDocumentPath: "inputs/two-room-doc.json",
        profilePath: "inputs/profile.json",
        extractionPath: null,
        ...overrides,
      });
    expect(workerCode(files({ profilePath: "linked-in/profile.json" }))).toBe(
      "CAD_TOPOLOGY_INPUT_PATH_INVALID",
    );
    expect(workerCode(files({ profilePath: "../outside/profile.json" }))).toBe(
      "CAD_TOPOLOGY_INPUT_PATH_INVALID",
    );
    expect(workerCode(files({ extractionPath: "inputs/missing.json" }))).toBe(
      "CAD_TOPOLOGY_INPUT_NOT_FOUND",
    );
    writeFileSync(join(root, "inputs", "broken.json"), "{ not json");
    expect(workerCode(files({ cadDocumentPath: "inputs/broken.json" }))).toBe(
      "CAD_TOPOLOGY_INPUT_JSON_INVALID",
    );
    const result = files({})();
    const outputRoot = join(root, ".workspace");
    mkdirSync(outputRoot);
    mkdirSync(join(outside, "target"));
    linkDirectory(join(outside, "target"), join(outputRoot, "linked-out"));
    for (const outputPath of [
      "linked-out/topology.json",
      "../escape.json",
      "topology.evidence.json",
      "topology.txt",
    ]) {
      expect(workerCode(() => writeCadTopology(result, outputRoot, outputPath))).toBe(
        "CAD_TOPOLOGY_OUTPUT_PATH_INVALID",
      );
    }
    expect(readdirSync(join(outside, "target"))).toEqual([]);
    expect(existsSync(join(root, "escape.json"))).toBe(false);
    expect(
      workerCode(() => writeCadTopology(result, join(root, "inputs"), "two-room-doc.json")),
    ).toBe("CAD_TOPOLOGY_OUTPUT_PATH_INVALID");
  });
});

// ------------------------------------------------------------ static guards

describe("Spike 10D static boundary guards", () => {
  const sourceDirectory = join(repositoryRoot, "packages/cad-topology/src");
  const sources = readdirSync(sourceDirectory)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(sourceDirectory, file), "utf8") }));
  const importsOf = (text: string) =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] as string);

  it("cad-topology imports only cad-interpreter, cad-parser, schema utilities, and local modules", () => {
    const allowed = new Set([
      "@ai-archviz/cad-interpreter",
      "@ai-archviz/cad-parser",
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
    }
    // The filesystem is used only to load the package's own schema.
    for (const { file, text } of sources) {
      if (file !== "validate.ts") expect(text, file).not.toContain("node:fs");
    }
  });

  it("contains no DXF parsing, SceneSpec, DCC, renderer, process, network, or AI code", () => {
    const forbidden =
      /DxfPair|parseDxfSource|DxfSourceAdapter|interpretCadDocument\(|validateSceneSpec|scene-spec|sceneSpecVersion|child_process|node:http|node:https|node:net|\bfetch\(|process\.env|\beval\(|new Function|apps\/worker|pymxs|3dsmax|corona|openai|anthropic|embedding|confidence|probability|Math\.random|randomUUID/i;
    for (const { file, text } of sources) expect(text, file).not.toMatch(forbidden);
  });

  it("keeps the dependency direction cad-parser <- cad-interpreter <- cad-topology", () => {
    // cad-scene-seed legitimately consumes cad-topology since Spike 10F (downstream).
    for (const upstream of ["cad-parser", "cad-interpreter", "scene-spec"]) {
      const directory = join(repositoryRoot, "packages", upstream);
      expect(readFileSync(join(directory, "package.json"), "utf8")).not.toContain("cad-topology");
      for (const file of readdirSync(join(directory, "src"))) {
        expect(readFileSync(join(directory, "src", file), "utf8")).not.toContain("cad-topology");
      }
    }
    const topologyPackage = JSON.parse(
      readFileSync(join(repositoryRoot, "packages/cad-topology/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(topologyPackage.dependencies).sort()).toEqual([
      "@ai-archviz/cad-interpreter",
      "@ai-archviz/cad-parser",
      "ajv",
      "ajv-formats",
    ]);
  });

  it("keeps the worker topology boundary free of DCC modules and lexical-only paths", () => {
    const text = readFileSync(join(repositoryRoot, "apps/worker/src/cad-topology.ts"), "utf8");
    expect(importsOf(text).sort()).toEqual([
      "./paths.js",
      "./workspace.js",
      "@ai-archviz/cad-interpreter",
      "@ai-archviz/cad-parser",
      "@ai-archviz/cad-topology",
      "@ai-archviz/worker-contracts",
      "node:fs",
      "node:path",
    ]);
    expect(text).not.toMatch(/resolveWithinRoot|child_process|process\.env|dcc-|probe\.js/);
  });
});
