import { createHash } from "node:crypto";
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
  CAD_INTERPRET_HOST_TOLERANCE_MM,
  CAD_INTERPRETATION_POLICY_VERSION,
  CadInterpretationError,
  type CadInterpretationProfile,
  interpretCadDocument,
  validateArchitecturalExtraction,
  validateCadInterpretationProfile,
} from "@ai-archviz/cad-interpreter";
import { type CadDocument, DxfSourceAdapter, parseDxfSource } from "@ai-archviz/cad-parser";
import { semanticJsonHash, validateCadInterpretationEvidence } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CadInterpretationWorkerError,
  cadInterpretationEvidence,
  interpretCadFiles,
  writeCadInterpretation,
} from "../../apps/worker/src/cad-interpretation.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const fixtureDirectory = join(
  repositoryRoot,
  "tests/fixtures/cad/interpretation/simple-living-room",
);
const readFixture = (name: string) =>
  JSON.parse(readFileSync(join(fixtureDirectory, name), "utf8"));
const sourceBytes = () => new Uint8Array(readFileSync(join(fixtureDirectory, "source.dxf")));
const frozenCadDocument = readFixture("cad-document-v0.1.json") as CadDocument;
const profile = readFixture("profile-v0.1.json") as CadInterpretationProfile;
const expectedExtraction = readFixture(
  "expected-architectural-extraction-v0.1.json",
) as ArchitecturalExtraction;

const FROZEN = {
  sourceHash: "sha256:dad0ab0a7863d811d0968dcfad3572337eb33a61cddf06df51df16ce754b096d",
  cadDocumentHash: "sha256:0c89f758b39c0b6312912a34aed7ec4bc46f24be86c56244a029cef5628f7f26",
  profileHash: "sha256:8a4429606d348add059c358cb21853f246fa90a85af78b94eca62e351439a40f",
  architecturalExtractionHash:
    "sha256:b249055f4a6204c474d72cd82f613410c0f63b7145ed87f83d431f5812a33f8a",
};

// ------------------------------------------------------------ DXF builder

type Pair = [number, string | number];
type Point = [number, number];

const ROOM: Point[] = [
  [0, 0],
  [6000, 0],
  [6000, 4500],
  [0, 4500],
];

interface Block {
  name: string;
  flags?: number;
}

interface Drawing {
  layers?: string[];
  blocks?: Block[];
  entities: Pair[][];
}

const STANDARD_LAYERS = ["0", "A-ROOM", "A-SPACE-TEXT", "A-DOOR", "A-WINDOW", "A-WALL", "A-NOTES"];
const STANDARD_BLOCKS: Block[] = [
  { name: "DOOR_900_LH_IN" },
  { name: "WINDOW_2400" },
  { name: "UNKNOWN_DOOR" },
  { name: "SITE_XREF", flags: 4 },
];

function dxf(drawing: Drawing): string {
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
  for (const name of drawing.layers ?? STANDARD_LAYERS)
    pairs.push([0, "LAYER"], [2, name], [70, 0]);
  pairs.push([0, "ENDTAB"], [0, "ENDSEC"], [0, "SECTION"], [2, "BLOCKS"]);
  for (const block of drawing.blocks ?? STANDARD_BLOCKS) {
    pairs.push([0, "BLOCK"], [8, "0"], [2, block.name], [70, block.flags ?? 0], [10, 0], [20, 0]);
    pairs.push([0, "ENDBLK"], [8, "0"]);
  }
  pairs.push([0, "ENDSEC"], [0, "SECTION"], [2, "ENTITIES"]);
  for (const entity of drawing.entities) pairs.push(...entity);
  pairs.push([0, "ENDSEC"], [0, "EOF"]);
  return `${pairs.map(([code, value]) => `${code}\n${value}`).join("\n")}\n`;
}

function room(
  points: Point[],
  options: { closed?: boolean; bulge?: number; layer?: string } = {},
): Pair[] {
  const pairs: Pair[] = [
    [0, "LWPOLYLINE"],
    [8, options.layer ?? "A-ROOM"],
    [90, points.length],
    [70, options.closed === false ? 0 : 1],
  ];
  points.forEach(([x, y], index) => {
    pairs.push([10, x], [20, y]);
    if (index === 0 && options.bulge !== undefined) pairs.push([42, options.bulge]);
  });
  return pairs;
}

const label = (text: string, [x, y]: Point, layer = "A-SPACE-TEXT"): Pair[] => [
  [0, "TEXT"],
  [8, layer],
  [10, x],
  [20, y],
  [40, 200],
  [1, text],
];

function insert(
  blockName: string,
  [x, y]: Point,
  options: { layer?: string; scale?: [number, number, number] } = {},
): Pair[] {
  const pairs: Pair[] = [
    [0, "INSERT"],
    [8, options.layer ?? (blockName.startsWith("WINDOW") ? "A-WINDOW" : "A-DOOR")],
    [2, blockName],
    [10, x],
    [20, y],
    [50, 90],
  ];
  if (options.scale)
    pairs.push([41, options.scale[0]], [42, options.scale[1]], [43, options.scale[2]]);
  return pairs;
}

const circle = (layer: string): Pair[] => [
  [0, "CIRCLE"],
  [8, layer],
  [10, 0],
  [20, 0],
  [40, 10],
];
const line = (layer: string): Pair[] => [
  [0, "LINE"],
  [8, layer],
  [10, 0],
  [20, 0],
  [11, 100],
  [21, 0],
];

const livingRoom = (): Pair[][] => [
  room(ROOM),
  label("LIVING ROOM", [2400, 2250]),
  insert("DOOR_900_LH_IN", [0, 1650]),
  insert("WINDOW_2400", [3000, 4500]),
];

const cadDocumentOf = (drawing: Drawing) => parseDxfSource(new TextEncoder().encode(dxf(drawing)));
const interpret = (drawing: Drawing, withProfile: unknown = profile) =>
  interpretCadDocument(cadDocumentOf(drawing), withProfile);

function interpretationCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CadInterpretationError);
    return (error as CadInterpretationError).code;
  }
  throw new Error("expected a CadInterpretationError");
}
const codeFor = (drawing: Drawing, withProfile: unknown = profile) =>
  interpretationCode(() => interpret(drawing, withProfile));

// ---------------------------------------------------------------- fixture

describe("dedicated simple-living-room interpretation fixture", () => {
  // Content assertions run on a LIVE interpretation (not the frozen JSON), so
  // each one is load-bearing on its own; the first test pins live == frozen.
  const liveExtraction = interpretCadDocument(parseDxfSource(sourceBytes()), profile);

  it("10A extracts the fixture to the frozen cad-document, and 10B to the frozen extraction", () => {
    const cadDocument = parseDxfSource(sourceBytes());
    expect(cadDocument).toEqual(frozenCadDocument);
    const extraction = interpretCadDocument(cadDocument, profile);
    expect(extraction).toEqual(expectedExtraction);
    expect(validateArchitecturalExtraction(extraction).ok).toBe(true);
    expect(extraction.status).toBe("READY_FOR_REVIEW");
    expect(extraction.interpretationPolicyVersion).toBe(CAD_INTERPRETATION_POLICY_VERSION);
  });

  it("proves the full DXF -> cad-document -> interpretation hash chain end to end", () => {
    const bytes = sourceBytes();
    const cadDocument = new DxfSourceAdapter().parse({ bytes });
    const { extraction, architecturalExtractionHash, evidence } = cadInterpretationEvidence(
      cadDocument,
      profile,
    );
    expect(cadDocument.sourceHash).toBe(
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    );
    expect(evidence).toEqual({
      evidenceVersion: "0.1.0",
      interpretationPolicyVersion: "cad-interpretation-policy-v0.1",
      sourceHash: FROZEN.sourceHash,
      cadDocumentHash: FROZEN.cadDocumentHash,
      profileId: "golden_living_dxf_profile",
      profileHash: FROZEN.profileHash,
      architecturalExtractionVersion: "0.1.0",
      architecturalExtractionHash: FROZEN.architecturalExtractionHash,
      summary: expectedExtraction.summary,
      status: "READY_FOR_REVIEW",
    });
    expect(semanticJsonHash(cadDocument)).toBe(FROZEN.cadDocumentHash);
    expect(semanticJsonHash(profile)).toBe(FROZEN.profileHash);
    expect(semanticJsonHash(extraction)).toBe(architecturalExtractionHash);
    expect(extraction.source).toEqual({
      cadDocumentVersion: "0.1.0",
      sourceFormat: "dxf",
      sourceHash: FROZEN.sourceHash,
      cadDocumentHash: FROZEN.cadDocumentHash,
    });
    expect(validateCadInterpretationEvidence(evidence).ok).toBe(true);
    expect(validateCadInterpretationEvidence({ ...evidence, spaces: [] }).ok).toBe(false);
    expect(validateCadInterpretationEvidence({ ...evidence, status: "APPROVED" }).ok).toBe(false);
    const serialized = JSON.stringify([cadDocument, extraction, evidence]);
    expect(serialized).not.toMatch(/[A-Za-z]:\\|\/home\/|Users|fixtures/);
  });

  it("recovers the exact 6000 x 4500 room, four walls, door, and window", () => {
    const [space] = liveExtraction.spaces;
    expect(liveExtraction.spaces).toHaveLength(1);
    expect(space).toMatchObject({
      candidateId: "space_candidate_0000",
      spaceType: "living_room",
      labelText: "LIVING ROOM",
      boundary: ROOM,
      boundaryWinding: "counter_clockwise",
      sourceWinding: "counter_clockwise",
      normalization: "none",
      floorElevationMm: 0,
      ceilingHeightMm: 3000,
    });
    expect(liveExtraction.walls.map((wall) => [wall.candidateId, wall.start, wall.end])).toEqual([
      ["wall_candidate_0000_0000", [0, 0], [6000, 0]],
      ["wall_candidate_0000_0001", [6000, 0], [6000, 4500]],
      ["wall_candidate_0000_0002", [6000, 4500], [0, 4500]],
      ["wall_candidate_0000_0003", [0, 4500], [0, 0]],
    ]);
    for (const wall of liveExtraction.walls) {
      expect(wall).toMatchObject({
        thicknessMm: 150,
        heightMm: 3000,
        baseElevationMm: 0,
        referenceLine: "interior_face",
        thicknessDirection: "exterior_right_of_u",
      });
    }
    expect(liveExtraction.openings).toEqual([
      expect.objectContaining({
        type: "door",
        hostWallCandidateId: "wall_candidate_0000_0003",
        offsetMm: 2400,
        widthMm: 900,
        heightMm: 2100,
        sillMm: 0,
        hingeSide: "start_jamb",
        swingDirection: "into_room",
        sourceCenter: [0, 1650],
        hostDistanceMm: 0,
        sourceRotationDegrees: 270,
      }),
      expect.objectContaining({
        type: "window",
        hostWallCandidateId: "wall_candidate_0000_0002",
        offsetMm: 1800,
        widthMm: 2400,
        heightMm: 1500,
        sillMm: 900,
        sourceCenter: [3000, 4500],
      }),
    ]);
  });

  it("keeps CAD, profile, and derived authority distinct for every value", () => {
    const [space] = liveExtraction.spaces;
    const [wall] = liveExtraction.walls;
    const [door, window] = liveExtraction.openings;
    const authorities = (entries: { authority: string }[] | undefined) =>
      (entries ?? []).map((entry) => entry.authority);
    // 6000 x 4500 room geometry: CAD boundary + derived normalization.
    expect(space?.provenance.boundary).toEqual([
      { authority: "cad", sourceOrdinal: 0, sourceHandle: "100", role: "space_boundary" },
      { authority: "derived", derivation: "boundary_winding_normalization_v0.1" },
    ]);
    expect(wall?.provenance.geometry).toEqual([
      { authority: "cad", sourceOrdinal: 0, sourceHandle: "100", role: "space_boundary" },
      { authority: "derived", derivation: "space_boundary_edge_v0.1" },
    ]);
    // 3000 ceiling height and 150 thickness: profile only, never CAD.
    expect(space?.provenance.ceilingHeightMm).toEqual([
      { authority: "profile", field: "level.defaultCeilingHeightMm", ruleId: null },
    ]);
    expect(wall?.provenance.heightMm).toEqual(space?.provenance.ceilingHeightMm);
    expect(wall?.provenance.thicknessMm).toEqual([
      { authority: "profile", field: "wallDefaults.wallThicknessMm", ruleId: null },
    ]);
    // 900 / 2400 widths: profile rules.
    expect(door?.provenance.widthMm).toEqual([
      { authority: "profile", field: "doorRules.widthMm", ruleId: "door_900_lh_in" },
    ]);
    expect(window?.provenance.widthMm).toEqual([
      { authority: "profile", field: "windowRules.widthMm", ruleId: "window_2400" },
    ]);
    expect(door?.type).toBe("door");
    if (door?.type === "door") {
      expect(authorities(door.provenance.hingeSide)).toEqual(["profile"]);
      expect(authorities(door.provenance.swingDirection)).toEqual(["profile"]);
    }
    // Host and offset: CAD insert + deterministic derivation.
    expect(door?.provenance.host).toEqual([
      { authority: "cad", sourceOrdinal: 2, sourceHandle: "102", role: "door_insert" },
      { authority: "derived", derivation: "opening_host_projection_v0.1" },
    ]);
    expect(authorities(door?.provenance.offsetMm)).toEqual(["cad", "profile", "derived"]);
    // Space type: CAD TEXT + profile label rule.
    expect(space?.provenance.spaceType).toEqual([
      { authority: "cad", sourceOrdinal: 1, sourceHandle: "101", role: "space_label" },
      { authority: "profile", field: "spaceLabelRules.spaceType", ruleId: "living_room_exact" },
    ]);
    expect(authorities(liveExtraction.level.provenance.defaultCeilingHeightMm)).toEqual([
      "profile",
    ]);
  });

  it("matches the Golden rev13 geometry in a TEST-ONLY projection (Golden is never an input)", () => {
    const golden = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "tests/fixtures/living-room-golden/revisions/rev_golden_0013/scene-spec.json",
        ),
        "utf8",
      ),
    );
    type GoldenWall = {
      id: string;
      type: string;
      start: number[];
      end: number[];
      thickness: number;
      height: number;
    };
    const goldenWalls = (golden.geometry as GoldenWall[]).filter((item) => item.type === "wall");
    const xy = (point: number[]) => [point[0], point[1]];
    const goldenOpening = (type: string) =>
      (
        golden.openings as {
          type: string;
          hostGeometryId: string;
          offset: number;
          width: number;
          height: number;
          sill: number;
        }[]
      ).find((opening) => opening.type === type);
    const project = {
      golden: {
        boundary: golden.spaces[0].boundary.map(xy),
        walls: goldenWalls.map((wall) => [xy(wall.start), xy(wall.end)]),
        wallThickness: [...new Set(goldenWalls.map((wall) => wall.thickness))],
        wallHeight: [...new Set(goldenWalls.map((wall) => wall.height))],
        ceilingHeight: golden.spaces[0].ceilingHeight,
        openings: ["door", "window"].map((type) => {
          const opening = goldenOpening(type);
          return {
            hostEdge: goldenWalls.findIndex((wall) => wall.id === opening?.hostGeometryId),
            offset: opening?.offset,
            width: opening?.width,
            height: opening?.height,
            sill: opening?.sill,
          };
        }),
      },
      interpreted: {
        boundary: liveExtraction.spaces[0]?.boundary,
        walls: liveExtraction.walls.map((wall) => [wall.start, wall.end]),
        wallThickness: [...new Set(liveExtraction.walls.map((wall) => wall.thicknessMm))],
        wallHeight: [...new Set(liveExtraction.walls.map((wall) => wall.heightMm))],
        ceilingHeight: liveExtraction.spaces[0]?.ceilingHeightMm,
        openings: liveExtraction.openings.map((opening) => ({
          hostEdge: liveExtraction.walls.find(
            (wall) => wall.candidateId === opening.hostWallCandidateId,
          )?.edgeIndex,
          offset: opening.offsetMm,
          width: opening.widthMm,
          height: opening.heightMm,
          sill: opening.sillMm,
        })),
      },
    };
    expect(project.interpreted).toEqual(project.golden);
    // Candidate IDs are not canonical SceneSpec IDs.
    const canonicalIds = new Set([
      ...goldenWalls.map((wall) => wall.id),
      "space_living_main",
      "opening_d01",
      "opening_w01",
    ]);
    for (const id of [
      ...liveExtraction.spaces.map((space) => space.candidateId),
      ...liveExtraction.walls.map((wall) => wall.candidateId),
      ...liveExtraction.openings.map((opening) => opening.candidateId),
    ]) {
      expect(canonicalIds.has(id)).toBe(false);
      expect(id).toMatch(/_candidate_\d{4}/);
    }
  });

  it("derives walls only from boundary edges; other source is recorded, never dropped", () => {
    expect(liveExtraction.unconsumedEntities).toEqual([
      {
        sourceOrdinal: 4,
        sourceHandle: "104",
        type: "LINE",
        layer: "A-WALL",
        reason: "UNMAPPED_LAYER",
      },
      {
        sourceOrdinal: 5,
        sourceHandle: "105",
        type: "LWPOLYLINE",
        layer: "A-WALL",
        reason: "UNMAPPED_LAYER",
      },
      {
        sourceOrdinal: 6,
        sourceHandle: "106",
        type: "CIRCLE",
        layer: "A-NOTES",
        reason: "UNSUPPORTED_SOURCE_ENTITY",
      },
      {
        sourceOrdinal: 7,
        sourceHandle: "107",
        type: "TEXT",
        layer: "A-NOTES",
        reason: "UNMAPPED_LAYER",
      },
    ]);
    expect(liveExtraction.summary).toEqual({
      spaceCount: 1,
      wallCount: 4,
      openingCount: 2,
      doorCount: 1,
      windowCount: 1,
      sourceEntityCount: 8,
      consumedEntityCount: 4,
      unconsumedEntityCount: 4,
    });
  });

  it("emits no SceneSpec structure", () => {
    const keys = new Set<string>();
    const visit = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          visit(child);
        }
      }
    };
    visit(liveExtraction);
    for (const forbidden of [
      "sceneSpecVersion",
      "project",
      "scene",
      "assets",
      "materials",
      "lights",
      "cameras",
      "render",
      "revisions",
      "geometry_id",
      "hostGeometryId",
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- policy

describe("space boundary policy", () => {
  it("normalizes a clockwise boundary to the same CCW loop and records it", () => {
    const clockwise: Point[] = [
      ROOM[0] as Point,
      ROOM[3] as Point,
      ROOM[2] as Point,
      ROOM[1] as Point,
    ];
    const extraction = interpret({ entities: [room(clockwise), ...livingRoom().slice(1)] });
    expect(extraction.spaces[0]).toMatchObject({
      boundary: ROOM,
      boundaryWinding: "counter_clockwise",
      sourceWinding: "clockwise",
      normalization: "reversed_to_counter_clockwise",
    });
    expect(extraction.walls.map((wall) => [wall.start, wall.end])).toEqual(
      expectedExtraction.walls.map((wall) => [wall.start, wall.end]),
    );
    expect(
      extraction.openings.map((opening) => [opening.hostWallCandidateId, opening.offsetMm]),
    ).toEqual([
      ["wall_candidate_0000_0003", 2400],
      ["wall_candidate_0000_0002", 1800],
    ]);
  });

  it("interprets a concave (L-shaped) room into one wall per edge", () => {
    const lShape: Point[] = [
      [0, 0],
      [6000, 0],
      [6000, 2000],
      [3000, 2000],
      [3000, 4500],
      [0, 4500],
    ];
    const extraction = interpret({ entities: [room(lShape), label("LIVING ROOM", [1000, 1000])] });
    expect(extraction.walls).toHaveLength(6);
    expect(extraction.spaces[0]?.boundary).toEqual(lShape);
  });

  it.each([
    [
      "self-intersecting bow-tie",
      room([
        [0, 0],
        [6000, 4500],
        [6000, 0],
        [0, 4500],
      ]),
    ],
    ["open polyline", room(ROOM, { closed: false })],
    [
      "duplicate consecutive vertex",
      room([
        [0, 0],
        [6000, 0],
        [6000, 0],
        [6000, 4500],
        [0, 4500],
      ]),
    ],
    ["repeated closing vertex", room([...ROOM, [0, 0]])],
    [
      "collinear zero-area boundary",
      room([
        [0, 0],
        [3000, 0],
        [6000, 0],
      ]),
    ],
    [
      "too few vertices",
      room([
        [0, 0],
        [6000, 0],
      ]),
    ],
    [
      "fold-back spike",
      room([
        [0, 0],
        [6000, 0],
        [6000, 4500],
        [6000, 2000],
        [0, 4500],
      ]),
    ],
  ])("rejects a %s with CAD_INTERPRET_SPACE_BOUNDARY_INVALID", (_name, boundary) => {
    expect(codeFor({ entities: [boundary, label("LIVING ROOM", [2400, 2250])] })).toBe(
      "CAD_INTERPRET_SPACE_BOUNDARY_INVALID",
    );
  });

  it("rejects a curved boundary instead of flattening it", () => {
    expect(
      codeFor({ entities: [room(ROOM, { bulge: 0.5 }), label("LIVING ROOM", [2400, 2250])] }),
    ).toBe("CAD_INTERPRET_SPACE_BOUNDARY_CURVED_UNSUPPORTED");
  });

  it("rejects a boundary whose CAD elevation disagrees with the profile level", () => {
    const raised: Pair[] = [...room(ROOM), [38, 250]];
    expect(codeFor({ entities: [raised, label("LIVING ROOM", [2400, 2250])] })).toBe(
      "CAD_INTERPRET_SPACE_BOUNDARY_INVALID",
    );
  });

  it("fails closed when there is no space boundary at all", () => {
    expect(codeFor({ entities: [line("A-WALL")] })).toBe("CAD_INTERPRET_SPACE_MISSING");
  });
});

describe("space label policy", () => {
  it.each([
    ["missing label", [room(ROOM)], "CAD_INTERPRET_SPACE_LABEL_MISSING"],
    [
      "unmapped label",
      [room(ROOM), label("KITCHEN", [2400, 2250])],
      "CAD_INTERPRET_SPACE_LABEL_UNMAPPED",
    ],
    [
      "case-different label",
      [room(ROOM), label("Living Room", [2400, 2250])],
      "CAD_INTERPRET_SPACE_LABEL_UNMAPPED",
    ],
    [
      "two labels in one room",
      [room(ROOM), label("LIVING ROOM", [2400, 2250]), label("LIVING ROOM", [1000, 1000])],
      "CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS",
    ],
    [
      "label on the boundary",
      [room(ROOM), label("LIVING ROOM", [0, 2250])],
      "CAD_INTERPRET_SPACE_LABEL_AMBIGUOUS",
    ],
    [
      "label outside every space",
      [room(ROOM), label("LIVING ROOM", [9000, 9000])],
      "CAD_INTERPRET_SPACE_LABEL_ORPHANED",
    ],
    [
      "label inside overlapping spaces (overlap takes precedence)",
      [
        room(ROOM),
        room([
          [3000, 0],
          [9000, 0],
          [9000, 4500],
          [3000, 4500],
        ]),
        label("LIVING ROOM", [4000, 2000]),
      ],
      "CAD_INTERPRET_SPACE_OVERLAP",
    ],
  ])("%s -> deterministic failure", (_name, entities, code) => {
    expect(codeFor({ entities: entities as Pair[][] })).toBe(code);
  });
});

describe("opening policy", () => {
  const withDoor = (center: Point, blockName = "DOOR_900_LH_IN", options = {}) => ({
    entities: [room(ROOM), label("LIVING ROOM", [2400, 2250]), insert(blockName, center, options)],
  });

  it("uses one fixed 1 mm host tolerance", () => {
    expect(CAD_INTERPRET_HOST_TOLERANCE_MM).toBe(1);
  });

  it("resolves an exact host and a 0.5 mm drafting offset to the same derived offset", () => {
    for (const [center, distance] of [
      [[0, 1650], 0],
      [[0.5, 1650], 0.5],
      [[-0.5, 1650], 0.5],
    ] as [Point, number][]) {
      const [door] = interpret(withDoor(center)).openings;
      expect(door).toMatchObject({
        hostWallCandidateId: "wall_candidate_0000_0003",
        offsetMm: 2400,
        hostDistanceMm: distance,
      });
    }
  });

  it.each([
    ["farther than 1 mm", [1.5, 1650], "CAD_INTERPRET_OPENING_HOST_UNRESOLVED"],
    ["inside the room", [1000, 1650], "CAD_INTERPRET_OPENING_HOST_UNRESOLVED"],
    ["at a wall junction", [0, 0], "CAD_INTERPRET_OPENING_HOST_AMBIGUOUS"],
    ["too close to the host end (outside host)", [0, 300], "CAD_INTERPRET_OPENING_OUTSIDE_HOST"],
  ])("rejects an opening %s", (_name, center, code) => {
    expect(codeFor(withDoor(center as Point))).toBe(code);
  });

  it("rejects an opening wider than its host segment", () => {
    const wide = { ...profile, windowRules: [{ ...profile.windowRules[0], widthMm: 7000 }] };
    expect(
      codeFor(
        {
          entities: [
            room(ROOM),
            label("LIVING ROOM", [2400, 2250]),
            insert("WINDOW_2400", [3000, 4500]),
          ],
        },
        wide,
      ),
    ).toBe("CAD_INTERPRET_OPENING_OUTSIDE_HOST");
  });

  it.each([
    ["an unmapped block", "UNKNOWN_DOOR", {}, "CAD_INTERPRET_OPENING_RULE_MISSING"],
    [
      "a window block on the door layer",
      "WINDOW_2400",
      { layer: "A-DOOR" },
      "CAD_INTERPRET_OPENING_RULE_MISSING",
    ],
    ["an undefined block", "GHOST_DOOR", {}, "CAD_INTERPRET_BLOCK_REFERENCE_INVALID"],
    ["an external (XREF) block", "SITE_XREF", {}, "CAD_INTERPRET_EXTERNAL_BLOCK_UNSUPPORTED"],
    [
      "a mirrored insert",
      "DOOR_900_LH_IN",
      { scale: [-1, 1, 1] },
      "CAD_INTERPRET_OPENING_SCALE_UNSUPPORTED",
    ],
    [
      "a scaled insert",
      "DOOR_900_LH_IN",
      { scale: [2, 2, 1] },
      "CAD_INTERPRET_OPENING_SCALE_UNSUPPORTED",
    ],
  ])("rejects %s", (_name, blockName, options, code) => {
    expect(codeFor(withDoor([0, 1650], blockName, options))).toBe(code);
  });
});

describe("mapped-layer and unconsumed source handling", () => {
  it("fails closed on an unsupported entity on a mapped layer", () => {
    expect(codeFor({ entities: [...livingRoom(), circle("A-DOOR")] })).toBe(
      "CAD_INTERPRET_UNSUPPORTED_ENTITY_ON_MAPPED_LAYER",
    );
  });

  it.each([
    ["a LINE on the space-boundary layer", line("A-ROOM")],
    ["a TEXT on the door layer", label("NOTE", [10, 10], "A-DOOR")],
    ["an INSERT on the label layer", insert("DOOR_900_LH_IN", [10, 10], { layer: "A-SPACE-TEXT" })],
  ])("fails closed on %s (role mismatch)", (_name, entity) => {
    expect(codeFor({ entities: [...livingRoom(), entity] })).toBe(
      "CAD_INTERPRET_ENTITY_ROLE_MISMATCH",
    );
  });

  it("records unrelated unsupported source as unconsumed, never failing on it", () => {
    const extraction = interpret({
      entities: [...livingRoom(), circle("A-NOTES"), line("A-WALL")],
    });
    expect(extraction.unconsumedEntities).toEqual([
      {
        sourceOrdinal: 4,
        sourceHandle: null,
        type: "CIRCLE",
        layer: "A-NOTES",
        reason: "UNSUPPORTED_SOURCE_ENTITY",
      },
      {
        sourceOrdinal: 5,
        sourceHandle: null,
        type: "LINE",
        layer: "A-WALL",
        reason: "UNMAPPED_LAYER",
      },
    ]);
    expect(extraction.walls).toHaveLength(4);
  });
});

describe("multiple spaces", () => {
  const bedroom: Point[] = [
    [6000, 0],
    [9000, 0],
    [9000, 4500],
    [6000, 4500],
  ];
  const twoRooms = (): Pair[][] => [
    room(ROOM),
    room(bedroom),
    label("LIVING ROOM", [2400, 2250]),
    label("BEDROOM", [7500, 2250]),
    insert("DOOR_900_LH_IN", [0, 1650]),
    insert("DOOR_900_LH_IN", [9000, 2250]),
  ];

  it("interprets adjacent spaces with exact label ownership and space-local hosts", () => {
    const extraction = interpret({ entities: twoRooms() });
    expect(extraction.spaces.map((space) => [space.candidateId, space.spaceType])).toEqual([
      ["space_candidate_0000", "living_room"],
      ["space_candidate_0001", "bedroom"],
    ]);
    expect(extraction.walls).toHaveLength(8);
    expect(
      extraction.openings.map((opening) => [
        opening.spaceCandidateId,
        opening.hostWallCandidateId,
        opening.offsetMm,
      ]),
    ).toEqual([
      ["space_candidate_0000", "wall_candidate_0000_0003", 2400],
      ["space_candidate_0001", "wall_candidate_0001_0001", 1800],
    ]);
  });

  it("orders candidates by source boundary ordinal (explicit, documented rule)", () => {
    const [living, bed, ...rest] = twoRooms();
    const extraction = interpret({ entities: [bed as Pair[], living as Pair[], ...rest] });
    expect(extraction.spaces.map((space) => space.spaceType)).toEqual(["bedroom", "living_room"]);
  });

  it("never picks an owner for an opening on a wall shared by two spaces", () => {
    expect(codeFor({ entities: [...twoRooms(), insert("DOOR_900_LH_IN", [6000, 2250])] })).toBe(
      "CAD_INTERPRET_OPENING_HOST_AMBIGUOUS",
    );
  });

  it.each([
    [
      "partial overlap",
      [
        [3000, 1000],
        [9000, 1000],
        [9000, 4000],
        [3000, 4000],
      ],
    ],
    ["identical duplicate", ROOM],
    [
      "containment",
      [
        [1000, 1000],
        [2000, 1000],
        [2000, 2000],
        [1000, 2000],
      ],
    ],
  ])("rejects %s with CAD_INTERPRET_SPACE_OVERLAP", (_name, second) => {
    expect(
      codeFor({
        entities: [room(ROOM), room(second as Point[]), label("LIVING ROOM", [5000, 500])],
      }),
    ).toBe("CAD_INTERPRET_SPACE_OVERLAP");
  });
});

describe("determinism, immutability, and inputs", () => {
  it("repeats deep-equal and is independent of layer/block table order", () => {
    const base = interpret({ entities: livingRoom() });
    expect(interpret({ entities: livingRoom() })).toEqual(base);
    const reordered = interpret({
      layers: [...STANDARD_LAYERS].reverse(),
      blocks: [...STANDARD_BLOCKS].reverse(),
      entities: livingRoom(),
    });
    expect(reordered.source.sourceHash).not.toBe(base.source.sourceHash);
    const { source: _a, ...baseRest } = base;
    const { source: _b, ...reorderedRest } = reordered;
    expect(reorderedRest).toEqual(baseRest);
  });

  it("hashes semantically equal profiles identically regardless of bytes/key order", () => {
    const reorderedText = JSON.stringify(
      Object.fromEntries(Object.entries(profile).reverse()),
      null,
      4,
    );
    const reorderedProfile = JSON.parse(reorderedText) as unknown;
    expect(reorderedText).not.toBe(JSON.stringify(profile, null, 2));
    const first = interpretCadDocument(frozenCadDocument, profile);
    const second = interpretCadDocument(frozenCadDocument, reorderedProfile);
    expect(second).toEqual(first);
    expect(semanticJsonHash(reorderedProfile)).toBe(FROZEN.profileHash);
  });

  it("never mutates the cad-document or the profile", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const cadDocument = deepFreeze(structuredClone(frozenCadDocument));
    const frozenProfile = deepFreeze(structuredClone(profile));
    const before = JSON.stringify([cadDocument, frozenProfile]);
    expect(interpretCadDocument(cadDocument, frozenProfile)).toEqual(expectedExtraction);
    expect(JSON.stringify([cadDocument, frozenProfile])).toBe(before);
  });

  it("rejects malformed inputs before interpreting", () => {
    expect(
      interpretationCode(() => interpretCadDocument({ ...frozenCadDocument, extra: 1 }, profile)),
    ).toBe("CAD_INTERPRET_CAD_DOCUMENT_INVALID");
    const invalidProfiles = [
      { ...profile, interpretationPolicy: "latest" },
      { ...profile, extra: true },
      { ...profile, layers: { ...profile.layers, door: "A-ROOM" } },
      { ...profile, doorRules: [{ ...profile.doorRules[0], anchorPolicy: "left_jamb" }] },
      { ...profile, windowRules: [{ ...profile.windowRules[0], ruleId: "door_900_lh_in" }] },
      { ...profile, windowRules: [{ ...profile.windowRules[0], blockName: "DOOR_900_LH_IN" }] },
      { ...profile, wallDefaults: { wallThicknessMm: 0 } },
    ];
    for (const invalid of invalidProfiles) {
      expect(validateCadInterpretationProfile(invalid).ok).toBe(false);
      expect(interpretationCode(() => interpretCadDocument(frozenCadDocument, invalid))).toBe(
        "CAD_INTERPRET_PROFILE_INVALID",
      );
    }
  });
});

// ---------------------------------------------------------- worker boundary

describe("worker interpretation boundary", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const workspace = () => {
    const base = mkdtempSync(join(tmpdir(), "avz-cad-10b-"));
    roots.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "inputs"), { recursive: true });
    copyFileSync(
      join(fixtureDirectory, "cad-document-v0.1.json"),
      join(root, "inputs", "doc.json"),
    );
    copyFileSync(join(fixtureDirectory, "profile-v0.1.json"), join(root, "inputs", "profile.json"));
    mkdirSync(join(base, "outside"));
    return { base, root, outside: join(base, "outside") };
  };
  const linkDirectory = (target: string, path: string) =>
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  const workerCode = (action: () => unknown) => {
    try {
      action();
    } catch (error) {
      expect(error).toBeInstanceOf(CadInterpretationWorkerError);
      return (error as CadInterpretationWorkerError).code;
    }
    throw new Error("expected failure");
  };

  it("interprets files and writes extraction + evidence inside the output root", () => {
    const { root } = workspace();
    const result = interpretCadFiles({
      repositoryRoot: root,
      cadDocumentPath: "inputs/doc.json",
      profilePath: "inputs/profile.json",
    });
    expect(result.extraction).toEqual(expectedExtraction);
    expect(result.evidence.architecturalExtractionHash).toBe(FROZEN.architecturalExtractionHash);
    const paths = writeCadInterpretation(result, join(root, ".workspace"), "cad/room.json");
    expect(JSON.parse(readFileSync(paths.extractionPath, "utf8"))).toEqual(expectedExtraction);
    expect(JSON.parse(readFileSync(paths.evidencePath, "utf8"))).toEqual(result.evidence);
  });

  it("maps interpretation failures to the same codes at the worker boundary", () => {
    expect(
      workerCode(() => cadInterpretationEvidence(frozenCadDocument, { ...profile, extra: 1 })),
    ).toBe("CAD_INTERPRET_PROFILE_INVALID");
  });

  it("uses physical path containment for inputs and outputs (no lexical-only regression)", () => {
    const { root, outside } = workspace();
    copyFileSync(join(fixtureDirectory, "profile-v0.1.json"), join(outside, "profile.json"));
    linkDirectory(outside, join(root, "linked-in"));
    expect(
      workerCode(() =>
        interpretCadFiles({
          repositoryRoot: root,
          cadDocumentPath: "inputs/doc.json",
          profilePath: "linked-in/profile.json",
        }),
      ),
    ).toBe("CAD_INTERPRET_INPUT_PATH_INVALID");
    const result = interpretCadFiles({
      repositoryRoot: root,
      cadDocumentPath: "inputs/doc.json",
      profilePath: "inputs/profile.json",
    });
    const outputRoot = join(root, ".workspace");
    mkdirSync(outputRoot);
    mkdirSync(join(outside, "target"));
    linkDirectory(join(outside, "target"), join(outputRoot, "linked-out"));
    for (const outputPath of [
      "linked-out/room.json",
      "../escape.json",
      "room.evidence.json",
      "room.txt",
    ]) {
      expect(workerCode(() => writeCadInterpretation(result, outputRoot, outputPath))).toBe(
        "CAD_INTERPRET_OUTPUT_PATH_INVALID",
      );
    }
    expect(readdirSync(join(outside, "target"))).toEqual([]);
    expect(existsSync(join(root, "escape.json"))).toBe(false);
    expect(
      workerCode(() =>
        interpretCadFiles({
          repositoryRoot: root,
          cadDocumentPath: "inputs/missing.json",
          profilePath: "inputs/profile.json",
        }),
      ),
    ).toBe("CAD_INTERPRET_INPUT_NOT_FOUND");
    writeFileSync(join(root, "inputs", "broken.json"), "{ not json");
    expect(
      workerCode(() =>
        interpretCadFiles({
          repositoryRoot: root,
          cadDocumentPath: "inputs/broken.json",
          profilePath: "inputs/profile.json",
        }),
      ),
    ).toBe("CAD_INTERPRET_INPUT_JSON_INVALID");
  });
});

// ------------------------------------------------------------ static guards

describe("Spike 10B static boundary guards", () => {
  const sourceDirectory = join(repositoryRoot, "packages/cad-interpreter/src");
  const sources = readdirSync(sourceDirectory)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(sourceDirectory, file), "utf8") }));
  const importsOf = (text: string) =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] as string);

  it("cad-interpreter imports only cad-parser, schema/hash utilities, and local modules", () => {
    const allowed = new Set([
      "@ai-archviz/cad-parser",
      "ajv/dist/2020.js",
      "ajv-formats",
      "json-canonicalize",
      "node:crypto",
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
  });

  it("contains no DXF parsing, SceneSpec, DCC, renderer, process, network, or AI code", () => {
    const forbidden =
      /DxfPair|DxfRecord|group code|"ENDSEC"|"SECTION"|parseDxfSource|DxfSourceAdapter|validateSceneSpec|scene-spec|sceneSpecVersion|child_process|node:http|node:https|node:net|\bfetch\(|process\.env|\beval\(|new Function|apps\/worker|pymxs|3dsmax|corona|openai|anthropic|embedding/i;
    for (const { file, text } of sources) expect(text, file).not.toMatch(forbidden);
  });

  it("keeps the dependency direction cad-parser <- cad-interpreter", () => {
    const parserDirectory = join(repositoryRoot, "packages/cad-parser");
    const parserPackage = readFileSync(join(parserDirectory, "package.json"), "utf8");
    expect(parserPackage).not.toContain("cad-interpreter");
    for (const file of readdirSync(join(parserDirectory, "src"))) {
      expect(readFileSync(join(parserDirectory, "src", file), "utf8")).not.toContain(
        "cad-interpreter",
      );
    }
  });

  it("keeps the worker interpretation boundary free of DCC modules and lexical-only paths", () => {
    const text = readFileSync(
      join(repositoryRoot, "apps/worker/src/cad-interpretation.ts"),
      "utf8",
    );
    expect(importsOf(text).sort()).toEqual([
      "./paths.js",
      "./workspace.js",
      "@ai-archviz/cad-interpreter",
      "@ai-archviz/cad-parser",
      "@ai-archviz/worker-contracts",
      "node:fs",
      "node:path",
    ]);
    expect(text).not.toMatch(/resolveWithinRoot|child_process|process\.env|dcc-|probe\.js/);
  });
});
