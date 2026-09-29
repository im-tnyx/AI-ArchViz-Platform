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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ArchitecturalExtraction } from "@ai-archviz/cad-interpreter";
import { interpretCadDocument } from "@ai-archviz/cad-interpreter";
import { DxfSourceAdapter } from "@ai-archviz/cad-parser";
import {
  type CadSceneSeedApproval,
  CadSceneSeedError,
  createSceneSpecSeed,
  validateCadSceneSeedApproval,
} from "@ai-archviz/cad-scene-seed";
import { validateSceneSpec } from "@ai-archviz/scene-spec";
import { semanticJsonHash, validateCadSceneSeedEvidence } from "@ai-archviz/worker-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSeedBuildRealizable,
  CadSceneSeedWorkerError,
  createCadSceneSeed,
  seedSceneFromCadFiles,
  writeCadSceneSeed,
} from "../../apps/worker/src/cad-scene-seed.js";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const interpretationDirectory = join(
  repositoryRoot,
  "tests/fixtures/cad/interpretation/simple-living-room",
);
const seedDirectory = join(repositoryRoot, "tests/fixtures/cad/scene-seed/simple-living-room");
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const extraction = read(
  join(interpretationDirectory, "expected-architectural-extraction-v0.1.json"),
) as ArchitecturalExtraction;
const approval = read(join(seedDirectory, "approval-v0.1.json")) as CadSceneSeedApproval;
const expectedSceneSpec = read(join(seedDirectory, "expected-scene-spec-v0.4.json"));
const expectedEvidence = read(join(seedDirectory, "expected-seed-evidence-v0.1.json"));

const FROZEN = {
  sourceHash: "sha256:dad0ab0a7863d811d0968dcfad3572337eb33a61cddf06df51df16ce754b096d",
  cadDocumentHash: "sha256:0c89f758b39c0b6312912a34aed7ec4bc46f24be86c56244a029cef5628f7f26",
  profileHash: "sha256:8a4429606d348add059c358cb21853f246fa90a85af78b94eca62e351439a40f",
  architecturalExtractionHash:
    "sha256:b249055f4a6204c474d72cd82f613410c0f63b7145ed87f83d431f5812a33f8a",
  approvalHash: "sha256:4fd953313856ef014ed3506d2f73ac640df1c946c6c0f8ccd21fafb9094970e5",
  sceneSpecHash: "sha256:7286dca5257374cd964ae1d2715fb1f3c4c7e901bfa8a7d2883b0fbc1bfdcc67",
};

type Mutable = Record<string, unknown> & CadSceneSeedApproval;
const approvalWith = (mutate: (draft: Mutable) => void): Mutable => {
  const draft = structuredClone(approval) as Mutable;
  mutate(draft);
  return draft;
};

function seedCode(extractionInput: unknown, approvalInput: unknown): string {
  try {
    createSceneSpecSeed(extractionInput, approvalInput);
  } catch (error) {
    expect(error).toBeInstanceOf(CadSceneSeedError);
    return (error as CadSceneSeedError).code;
  }
  throw new Error("expected a CadSceneSeedError");
}

function workerFailure(action: () => unknown): CadSceneSeedWorkerError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CadSceneSeedWorkerError);
    return error as CadSceneSeedWorkerError;
  }
  throw new Error("expected a CadSceneSeedWorkerError");
}

// ---------------------------------------------------------------- fixture

describe("CAD scene seed fixture", () => {
  it("generates exactly the independently authored SceneSpec v0.4 and seed evidence", () => {
    const seed = createCadSceneSeed(extraction, approval);
    expect(seed.sceneSpec).toEqual(expectedSceneSpec);
    expect(seed.evidence).toEqual(expectedEvidence);
    expect(validateSceneSpec(seed.sceneSpec).ok).toBe(true);
    expect(validateCadSceneSeedEvidence(seed.evidence).ok).toBe(true);
    expect(seed.evidence.spatialValidationStatus).toBe("PASS");
    expect(seed.evidence.circulationRequirementStatus).toBe("PASS");
  });

  it("proves the full six-hash chain DXF -> 10A -> 10B -> approval -> 10C", () => {
    const bytes = new Uint8Array(readFileSync(join(interpretationDirectory, "source.dxf")));
    const cadDocument = new DxfSourceAdapter().parse({ bytes });
    const profile = read(join(interpretationDirectory, "profile-v0.1.json"));
    const interpreted = interpretCadDocument(cadDocument, profile);
    const seed = createCadSceneSeed(interpreted, approval);
    expect({
      sourceHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      cadDocumentHash: semanticJsonHash(cadDocument),
      profileHash: semanticJsonHash(profile),
      architecturalExtractionHash: semanticJsonHash(interpreted),
      approvalHash: semanticJsonHash(approval),
      sceneSpecHash: semanticJsonHash(seed.sceneSpec),
    }).toEqual(FROZEN);
    expect(seed.evidence).toMatchObject({
      sourceHash: FROZEN.sourceHash,
      cadDocumentHash: FROZEN.cadDocumentHash,
      profileHash: FROZEN.profileHash,
      architecturalExtractionHash: FROZEN.architecturalExtractionHash,
      approvalHash: FROZEN.approvalHash,
      sceneSpecHash: FROZEN.sceneSpecHash,
    });
  });

  it("records the upstream provenance chain in the aiarchviz.cad_seed extension, with no paths", () => {
    const seed = createSceneSpecSeed(extraction, approval);
    const extension = (seed.extensions as Record<string, unknown>)["aiarchviz.cad_seed"];
    expect(extension).toEqual({
      version: "0.1.0",
      canonicalizationPolicy: "cad-scene-seed-policy-v0.1",
      approvalId: "approval_cad_living_seed_001",
      approvalHash: FROZEN.approvalHash,
      profileId: "golden_living_dxf_profile",
      sourceHash: FROZEN.sourceHash,
      cadDocumentHash: FROZEN.cadDocumentHash,
      profileHash: FROZEN.profileHash,
      architecturalExtractionHash: FROZEN.architecturalExtractionHash,
      mappings: approval.mappings,
    });
    expect(JSON.stringify(seed)).not.toMatch(/[A-Za-z]:\\|\/home\/|Users|fixtures|\.dxf/);
    expect(seed.sources).toEqual([
      expect.objectContaining({ type: "dxf", uri: `urn:sha256:${FROZEN.sourceHash.slice(7)}` }),
    ]);
  });

  it("uses explicit new canonical identity and one initial committed revision (no Golden history)", () => {
    const seed = createSceneSpecSeed(extraction, approval);
    expect(seed.sceneSpecVersion).toBe("0.4.0");
    expect(seed.project).toEqual({
      id: "project_cad_seed_living_001",
      name: "CAD Seed Living Room",
    });
    expect(seed.scene).toEqual({
      id: "scene_cad_seed_living_001",
      revisionId: "rev_cad_seed_0001",
      headRevisionId: "rev_cad_seed_0001",
    });
    expect(seed.revisions).toEqual([
      {
        revisionId: "rev_cad_seed_0001",
        parentRevisionId: null,
        status: "committed",
        createdAt: "2026-09-28T12:00:00Z",
      },
    ]);
    expect(JSON.stringify(seed)).not.toMatch(/golden_living_001|rev_golden_/);
    expect(
      existsSync(
        join(repositoryRoot, "tests/fixtures/living-room-golden/revisions/rev_golden_0014"),
      ),
    ).toBe(false);
  });
});

// --------------------------------------------------- architectural facts

describe("architectural facts are copied only from the approved extraction", () => {
  const seed = createSceneSpecSeed(extraction, approval);
  const walls = (seed.geometry as Record<string, unknown>[]).filter(
    (entry) => entry.type === "wall",
  );
  const wallById = new Map(walls.map((wall) => [wall.id, wall]));
  const openings = seed.openings as Record<string, unknown>[];

  it("maps every wall candidate to its explicit logical ID with exact 10B geometry", () => {
    for (const mapping of approval.mappings.walls) {
      const candidate = extraction.walls.find((wall) => wall.candidateId === mapping.candidateId);
      expect(wallById.get(mapping.logicalId)).toMatchObject({
        start: [...(candidate?.start ?? []), 0],
        end: [...(candidate?.end ?? []), 0],
        baseElevation: candidate?.baseElevationMm,
        height: candidate?.heightMm,
        thickness: candidate?.thicknessMm,
        referenceLine: "interior_face",
        thicknessDirection: "exterior_right_of_u",
        spaceId: "space_living_main",
        levelId: "level_ground",
        locks: { geometry: false, transform: false, material: false },
      });
    }
    expect(walls.map((wall) => [wall.id, wall.thickness, wall.height])).toEqual([
      ["wall_south", 150, 3000],
      ["wall_east", 150, 3000],
      ["wall_north", 150, 3000],
      ["wall_west", 150, 3000],
    ]);
  });

  it("generates the door and window from 10B with the mapped 10B host", () => {
    expect(openings).toEqual([
      {
        id: "opening_d01",
        type: "door",
        hostGeometryId: "wall_west",
        offset: 2400,
        width: 900,
        sill: 0,
        height: 2100,
        hingeSide: "start_jamb",
        swingDirection: "into_room",
        transform: { position: [2400, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        locks: { geometry: false, transform: false, material: false },
      },
      {
        id: "opening_w01",
        type: "window",
        hostGeometryId: "wall_north",
        offset: 1800,
        width: 2400,
        sill: 900,
        height: 1500,
        transform: { position: [1800, 0, 900], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        locks: { geometry: false, transform: false, material: false },
      },
    ]);
  });

  it("generates the level, space, floor, and ceiling from 10B facts", () => {
    expect(seed.levels).toEqual([
      { id: "level_ground", name: "Ground Floor", elevation: 0, defaultCeilingHeight: 3000 },
    ]);
    const room = [
      [0, 0, 0],
      [6000, 0, 0],
      [6000, 4500, 0],
      [0, 4500, 0],
    ];
    expect(seed.spaces).toEqual([
      expect.objectContaining({
        id: "space_living_main",
        type: "living_room",
        boundary: room,
        floorElevation: 0,
        ceilingHeight: 3000,
      }),
    ]);
    const surfaces = (seed.geometry as Record<string, unknown>[]).filter(
      (entry) => entry.type !== "wall",
    );
    expect(surfaces).toEqual([
      expect.objectContaining({
        id: "surface_floor_main",
        type: "floor",
        boundary: room,
        elevation: 0,
        thickness: 0,
        extrusionDirection: "none",
        transform: { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      }),
      expect.objectContaining({
        id: "surface_ceiling_main",
        type: "ceiling",
        boundary: room,
        elevation: 3000,
        thickness: 0,
        extrusionDirection: "none",
        transform: { position: [0, 0, 3000], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
      }),
    ]);
  });

  it("keeps non-CAD state exactly as approved (asset, camera, render, empty collections)", () => {
    expect(seed.assets).toEqual(approval.nonCadState.assets);
    expect(seed.assetDefinitions).toEqual(approval.nonCadState.assetDefinitions);
    expect(seed.cameras).toEqual(approval.nonCadState.cameras);
    expect(seed.render).toEqual({ engine: "none", mode: "build_only" });
    expect([
      seed.materials,
      seed.materialAssignments,
      seed.lights,
      seed.circulationRequirements,
    ]).toEqual([[], [], [], []]);
  });

  it("matches Golden rev13 architecture in a TEST-ONLY projection (Golden is never an input)", () => {
    const golden = read(
      join(
        repositoryRoot,
        "tests/fixtures/living-room-golden/revisions/rev_golden_0013/scene-spec.json",
      ),
    );
    const project = (scene: Record<string, unknown>) => {
      const geometry = scene.geometry as Record<string, unknown>[];
      return {
        boundary: (scene.spaces as Record<string, unknown>[])[0]?.boundary,
        ceiling: (scene.spaces as Record<string, unknown>[])[0]?.ceilingHeight,
        walls: geometry
          .filter((entry) => entry.type === "wall")
          .map((wall) => [wall.id, wall.start, wall.end, wall.thickness, wall.height]),
        openings: (scene.openings as Record<string, unknown>[]).map((opening) => [
          opening.id,
          opening.type,
          opening.hostGeometryId,
          opening.offset,
          opening.width,
          opening.height,
          opening.sill,
          opening.hingeSide ?? null,
          opening.swingDirection ?? null,
        ]),
      };
    };
    expect(project(seed)).toEqual(project(golden));
  });
});

// ------------------------------------------------------------ rejections

describe("approval is explicit, exact, and never an edit layer", () => {
  it("never treats READY_FOR_REVIEW as approval: a missing or invalid approval is rejected", () => {
    for (const missing of [undefined, null, {}, { ...approval, approvalVersion: "0.2.0" }]) {
      expect(seedCode(extraction, missing)).toBe("CAD_SCENE_SEED_APPROVAL_INVALID");
    }
    expect(seedCode(extraction, { ...approval, canonicalizationPolicy: "latest" })).toBe(
      "CAD_SCENE_SEED_APPROVAL_INVALID",
    );
    expect(seedCode(extraction, { ...approval, autoApprove: true })).toBe(
      "CAD_SCENE_SEED_APPROVAL_INVALID",
    );
  });

  it.each(["rejected", "changes_requested"])("refuses a %s decision", (decision) => {
    expect(seedCode(extraction, { ...approval, decision })).toBe("CAD_SCENE_SEED_NOT_APPROVED");
  });

  it("rejects a stale approval after any architectural value changes (H1 approval vs H2 extraction)", () => {
    const changed = structuredClone(extraction);
    (changed.walls[0] as { thicknessMm: number }).thicknessMm = 160;
    expect(semanticJsonHash(changed)).not.toBe(FROZEN.architecturalExtractionHash);
    expect(seedCode(changed, approval)).toBe("CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH");
    expect(workerFailure(() => createCadSceneSeed(changed, approval)).code).toBe(
      "CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH",
    );
    for (const field of ["sourceHash", "cadDocumentHash", "profileHash"] as const) {
      const wrong = approvalWith((draft) => {
        draft.extraction[field] = `sha256:${"0".repeat(64)}`;
      });
      expect(seedCode(extraction, wrong)).toBe("CAD_SCENE_SEED_APPROVAL_HASH_MISMATCH");
    }
  });

  it.each([
    [
      "wall thickness",
      (d: Mutable) => Object.assign(d.mappings.walls[0] as object, { thicknessMm: 200 }),
    ],
    [
      "space boundary",
      (d: Mutable) =>
        Object.assign(d.mappings.spaces[0] as object, {
          boundary: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        }),
    ],
    [
      "opening width",
      (d: Mutable) => Object.assign(d.mappings.openings[0] as object, { widthMm: 1000 }),
    ],
    [
      "opening offset",
      (d: Mutable) => Object.assign(d.mappings.openings[0] as object, { offsetMm: 100 }),
    ],
    ["top-level overrides", (d: Mutable) => Object.assign(d, { overrides: { walls: [] } })],
    ["ceiling height", (d: Mutable) => Object.assign(d.canonical.scene, { ceilingHeight: 2800 })],
  ])("rejects a geometry override field (%s) at the schema", (_name, mutate) => {
    const draft = approvalWith(mutate);
    expect(validateCadSceneSeedApproval(draft).ok).toBe(false);
    expect(seedCode(extraction, draft)).toBe("CAD_SCENE_SEED_APPROVAL_INVALID");
  });
});

describe("candidate -> canonical mapping validation", () => {
  it.each([
    [
      "missing wall mapping",
      (d: Mutable) => d.mappings.walls.pop(),
      "CAD_SCENE_SEED_MAPPING_INCOMPLETE",
    ],
    [
      "missing level mapping",
      (d: Mutable) => d.mappings.levels.pop(),
      "CAD_SCENE_SEED_MAPPING_INCOMPLETE",
    ],
    [
      "missing opening mapping",
      (d: Mutable) => d.mappings.openings.shift(),
      "CAD_SCENE_SEED_MAPPING_INCOMPLETE",
    ],
    [
      "unknown wall candidate",
      (d: Mutable) =>
        d.mappings.walls.push({ candidateId: "wall_candidate_9999_9999", logicalId: "wall_extra" }),
      "CAD_SCENE_SEED_MAPPING_UNKNOWN_CANDIDATE",
    ],
    [
      "duplicate candidate mapping",
      (d: Mutable) =>
        d.mappings.walls.push({ candidateId: "wall_candidate_0000_0003", logicalId: "wall_again" }),
      "CAD_SCENE_SEED_MAPPING_DUPLICATE",
    ],
    [
      "two walls mapped to one logical ID",
      (d: Mutable) => Object.assign(d.mappings.walls[1] as object, { logicalId: "wall_south" }),
      "CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE",
    ],
    [
      "surface ID colliding with a wall ID",
      (d: Mutable) =>
        Object.assign(d.mappings.spaces[0] as object, { floorSurfaceId: "wall_east" }),
      "CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE",
    ],
    [
      "asset ID colliding with an opening ID",
      (d: Mutable) => Object.assign(d.nonCadState.assets[0] as object, { id: "opening_d01" }),
      "CAD_SCENE_SEED_LOGICAL_ID_DUPLICATE",
    ],
    [
      "unsorted wall mappings",
      (d: Mutable) => d.mappings.walls.reverse(),
      "CAD_SCENE_SEED_MAPPING_UNSORTED",
    ],
  ])("%s", (_name, mutate, code) => {
    expect(seedCode(extraction, approvalWith(mutate as (d: Mutable) => void))).toBe(code);
  });

  it("never derives a canonical ID: no candidate ID, handle, or ordinal becomes a logical ID", () => {
    const seed = createSceneSpecSeed(extraction, approval);
    const { extensions, ...rest } = seed;
    expect(JSON.stringify(rest)).not.toMatch(/candidate|sourceHandle|sourceOrdinal/);
    const approvedIds = new Set([
      ...approval.mappings.levels.map((m) => m.logicalId),
      ...approval.mappings.spaces.flatMap((m) => [
        m.logicalId,
        m.floorSurfaceId,
        m.ceilingSurfaceId,
      ]),
      ...approval.mappings.walls.map((m) => m.logicalId),
      ...approval.mappings.openings.map((m) => m.logicalId),
    ]);
    const generatedIds = [
      ...(seed.levels as { id: string }[]),
      ...(seed.spaces as { id: string }[]),
      ...(seed.geometry as { id: string }[]),
      ...(seed.openings as { id: string }[]),
    ].map((entry) => entry.id);
    for (const id of generatedIds) expect(approvedIds.has(id), id).toBe(true);
    expect(extensions).toBeDefined();
  });
});

describe("non-CAD state and pre-DCC validation", () => {
  it.each([
    [
      "bad camera space reference",
      (d: Mutable) =>
        Object.assign(d.nonCadState.cameras[0] as object, { spaceId: "space_missing" }),
      "CAD_SCENE_SEED_REFERENCE_INVALID",
    ],
    [
      "bad asset space reference",
      (d: Mutable) =>
        Object.assign(d.nonCadState.assets[0] as object, { spaceId: "space_missing" }),
      "CAD_SCENE_SEED_REFERENCE_INVALID",
    ],
    [
      "asset with unknown definition",
      (d: Mutable) =>
        Object.assign(d.nonCadState.assets[0] as object, { assetDefinitionId: "assetdef_missing" }),
      "CAD_SCENE_SEED_SCENESPEC_INVALID",
    ],
    [
      "bad source type",
      (d: Mutable) => Object.assign(d.nonCadState.sources[0] as object, { type: "http" }),
      "CAD_SCENE_SEED_APPROVAL_INVALID",
    ],
    [
      "source not content-addressed to this DXF",
      (d: Mutable) => Object.assign(d.nonCadState.sources[0] as object, { uri: "urn:sha256:00" }),
      "CAD_SCENE_SEED_SOURCE_INVALID",
    ],
    [
      "unsupported render engine",
      (d: Mutable) => Object.assign(d.nonCadState.render, { engine: "unreal" }),
      "CAD_SCENE_SEED_APPROVAL_INVALID",
    ],
    [
      "invalid camera state",
      (d: Mutable) => Object.assign(d.nonCadState.cameras[0] as object, { focalLengthMm: 0 }),
      "CAD_SCENE_SEED_APPROVAL_INVALID",
    ],
    [
      "no source metadata",
      (d: Mutable) => Object.assign(d.nonCadState, { sources: [] }),
      "CAD_SCENE_SEED_APPROVAL_INVALID",
    ],
  ])("%s", (_name, mutate, code) => {
    expect(seedCode(extraction, approvalWith(mutate as (d: Mutable) => void))).toBe(code);
  });

  it.each([
    "C:\\Users\\someone\\plan.dxf",
    "\\\\server\\share\\plan.dxf",
    "/home/someone/plan.dxf",
    "FILE:///plan.dxf",
    ".\\plan.dxf",
    "../plan.dxf",
    "~/plan.dxf",
  ])("rejects a local filesystem path in source metadata (%s)", (uri) => {
    const draft = approvalWith((d) => {
      d.nonCadState.sources.push({
        ...(d.nonCadState.sources[0] as object),
        id: "source_extra",
        uri,
      });
    });
    expect(seedCode(extraction, draft)).toBe("CAD_SCENE_SEED_SOURCE_INVALID");
  });

  it.each([
    ["door clearance", [600, 1650, 0], "SPATIAL_DOOR_CLEARANCE_BLOCKED"],
    ["outside the space", [7000, 2000, 0], null],
  ])(
    "approval cannot bypass 9A: an asset blocking %s fails before any DCC",
    (_name, position, spatialCode) => {
      const draft = approvalWith((d) => {
        (d.nonCadState.assets[0] as { transform: { position: number[] } }).transform.position =
          position as number[];
      });
      const failure = workerFailure(() => createCadSceneSeed(extraction, draft));
      expect(failure.code).toBe("CAD_SCENE_SEED_SPATIAL_INVALID");
      if (spatialCode) expect(failure.details.spatialCode).toBe(spatialCode);
      else expect(String(failure.details.spatialCode)).toMatch(/^SPATIAL_/);
    },
  );

  it("rejects colliding approved assets with the underlying spatial code", () => {
    const draft = approvalWith((d) => {
      d.nonCadState.assets.push({
        ...(structuredClone(d.nonCadState.assets[0]) as object),
        id: "asset_cad_seed_table_copy",
      });
    });
    const failure = workerFailure(() => createCadSceneSeed(extraction, draft));
    expect(failure.code).toBe("CAD_SCENE_SEED_SPATIAL_INVALID");
    expect(failure.details.spatialCode).toBe("SPATIAL_ASSET_COLLISION");
  });

  it("passes circulation with explicitly empty requirements, and enforces an explicit one", () => {
    expect(createCadSceneSeed(extraction, approval).evidence.circulationRequirementStatus).toBe(
      "PASS",
    );
    const blocked = approvalWith((d) => {
      d.nonCadState.circulationRequirements = [
        {
          id: "circulation_req_entry_to_table",
          type: "same_space_route",
          spaceId: "space_living_main",
          evaluationPolicy: "circulation-policy-v0.1",
          start: { kind: "door_portal", openingId: "opening_d01" },
          end: { kind: "point", pointXY: [3000, 2200] },
        },
      ];
    });
    expect(workerFailure(() => createCadSceneSeed(extraction, blocked)).code).toBe(
      "CAD_SCENE_SEED_CIRCULATION_UNSATISFIED",
    );
  });

  it("accepts translated and concave surfaces now that the shared build realizes exact polygons", () => {
    expect(() => assertSeedBuildRealizable(expectedSceneSpec)).not.toThrow();
    const surfacesOf = (scene: { geometry: { type: string }[] }) =>
      scene.geometry.filter((g) => g.type !== "wall") as unknown as {
        boundary: number[][];
        transform: Record<string, number[]>;
      }[];
    const shifted = structuredClone(expectedSceneSpec);
    for (const surface of surfacesOf(shifted)) {
      surface.boundary = surface.boundary.map(([x, y, z]) => [
        (x as number) + 1000,
        y as number,
        z as number,
      ]);
    }
    expect(() => assertSeedBuildRealizable(shifted)).not.toThrow();
    const lShape = structuredClone(expectedSceneSpec);
    for (const surface of surfacesOf(lShape)) {
      surface.boundary = [
        [0, 0, 0],
        [6000, 0, 0],
        [6000, 2000, 0],
        [3000, 2000, 0],
        [3000, 4500, 0],
        [0, 4500, 0],
      ];
    }
    expect(() => assertSeedBuildRealizable(lShape)).not.toThrow();
  });

  it.each([
    [
      "a rotated surface",
      (surface: Record<string, unknown>) => {
        (surface.transform as Record<string, number[]>).rotationEuler = [0, 0, 90];
      },
    ],
    [
      "a scaled surface",
      (surface: Record<string, unknown>) => {
        (surface.transform as Record<string, number[]>).scale = [2, 1, 1];
      },
    ],
    [
      "a self-intersecting surface",
      (surface: Record<string, unknown>) => {
        surface.boundary = [
          [0, 0, 0],
          [6000, 4500, 0],
          [6000, 0, 0],
          [0, 4500, 0],
        ];
      },
    ],
  ])("still refuses %s before any DCC", (_name, mutate) => {
    const scene = structuredClone(expectedSceneSpec);
    mutate(scene.geometry.find((g: { type: string }) => g.type === "floor"));
    const failure = workerFailure(() => assertSeedBuildRealizable(scene));
    expect(failure.code).toBe("CAD_SCENE_SEED_BUILD_UNSUPPORTED");
    expect(String(failure.details.reason)).toMatch(/^SURFACE_/);
  });

  it("seeds a concave (L-shaped) CAD room end to end and it is build-realizable", () => {
    const lRoom = [
      [0, 0],
      [6000, 0],
      [6000, 2000],
      [3500, 2000],
      [3500, 4500],
      [0, 4500],
    ];
    const pairs: [number, string | number][] = [
      [0, "SECTION"],
      [2, "HEADER"],
      [9, "$INSUNITS"],
      [70, 4],
      [0, "ENDSEC"],
      [0, "SECTION"],
      [2, "TABLES"],
      [0, "TABLE"],
      [2, "LAYER"],
      ...["0", "A-ROOM", "A-SPACE-TEXT", "A-DOOR", "A-WINDOW"].flatMap(
        (name): [number, string | number][] => [
          [0, "LAYER"],
          [2, name],
          [70, 0],
        ],
      ),
      [0, "ENDTAB"],
      [0, "ENDSEC"],
      [0, "SECTION"],
      [2, "BLOCKS"],
      [0, "BLOCK"],
      [8, "0"],
      [2, "DOOR_900_LH_IN"],
      [70, 0],
      [10, 0],
      [20, 0],
      [0, "ENDBLK"],
      [8, "0"],
      [0, "ENDSEC"],
      [0, "SECTION"],
      [2, "ENTITIES"],
      [0, "LWPOLYLINE"],
      [5, "A0"],
      [8, "A-ROOM"],
      [90, 6],
      [70, 1],
      ...lRoom.flatMap(([x, y]): [number, number][] => [
        [10, x as number],
        [20, y as number],
      ]),
      [0, "TEXT"],
      [5, "A1"],
      [8, "A-SPACE-TEXT"],
      [10, 1500],
      [20, 2500],
      [40, 200],
      [1, "LIVING ROOM"],
      [0, "INSERT"],
      [5, "A2"],
      [8, "A-DOOR"],
      [2, "DOOR_900_LH_IN"],
      [10, 1500],
      [20, 0],
      [0, "ENDSEC"],
      [0, "EOF"],
    ];
    const bytes = new TextEncoder().encode(
      `${pairs.map(([code, value]) => `${code}\n${value}`).join("\n")}\n`,
    );
    const cadDocument = new DxfSourceAdapter().parse({ bytes });
    const profile = read(join(interpretationDirectory, "profile-v0.1.json"));
    const lExtraction = interpretCadDocument(cadDocument, profile);
    expect(lExtraction.walls).toHaveLength(6);
    const wallNames = ["wall_l_s", "wall_l_e1", "wall_l_n1", "wall_l_e2", "wall_l_n2", "wall_l_w"];
    const lApproval = structuredClone(approval) as Mutable;
    lApproval.approvalId = "approval_cad_l_seed_001";
    lApproval.extraction = {
      ...lApproval.extraction,
      architecturalExtractionHash: semanticJsonHash(lExtraction),
      sourceHash: lExtraction.source.sourceHash,
      cadDocumentHash: lExtraction.source.cadDocumentHash,
      profileHash: lExtraction.profileHash,
    };
    lApproval.canonical = {
      project: { id: "project_cad_seed_l_001", name: "CAD Seed L Room" },
      scene: {
        id: "scene_cad_seed_l_001",
        revisionId: "rev_cad_seed_l_0001",
        createdAt: "2026-09-28T15:00:00Z",
      },
    };
    lApproval.mappings.walls = lExtraction.walls.map((wall, index) => ({
      candidateId: wall.candidateId,
      logicalId: wallNames[index] as string,
    }));
    lApproval.mappings.openings = [
      { candidateId: "opening_candidate_0000", logicalId: "opening_l_d01" },
    ];
    (lApproval.nonCadState.sources[0] as { uri: string }).uri =
      `urn:sha256:${lExtraction.source.sourceHash.slice("sha256:".length)}`;
    (lApproval.nonCadState.assets[0] as { transform: { position: number[] } }).transform.position =
      [1500, 3500, 0];
    const seed = createCadSceneSeed(lExtraction, lApproval);
    expect(seed.evidence.status).toBe("PASS");
    expect(() => assertSeedBuildRealizable(seed.sceneSpec)).not.toThrow();
    const floor = (seed.sceneSpec.geometry as Record<string, unknown>[]).find(
      (g) => g.type === "floor",
    );
    expect(floor?.boundary).toEqual(lRoom.map(([x, y]) => [x, y, 0]));
  });
});

describe("determinism and immutability", () => {
  it("repeats deep-equal with the same hashes and evidence", () => {
    const first = createCadSceneSeed(extraction, approval);
    const second = createCadSceneSeed(extraction, approval);
    expect(second).toEqual(first);
    expect(second.sceneSpecHash).toBe(FROZEN.sceneSpecHash);
  });

  it("hashes semantically identical approvals identically (key order, whitespace)", () => {
    const reorder = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reorder)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, child]) => [key, reorder(child)]),
            )
          : value;
    const text = JSON.stringify(reorder(approval), null, 7);
    expect(text).not.toBe(JSON.stringify(approval, null, 2));
    const reordered = JSON.parse(text);
    const seed = createCadSceneSeed(extraction, reordered);
    expect(seed.approvalHash).toBe(FROZEN.approvalHash);
    expect(seed.sceneSpecHash).toBe(FROZEN.sceneSpecHash);
    expect(seed.sceneSpec).toEqual(expectedSceneSpec);
  });

  it("never mutates the extraction or the approval", () => {
    const deepFreeze = <T>(value: T): T => {
      if (value && typeof value === "object") {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
      }
      return value;
    };
    const frozenExtraction = deepFreeze(structuredClone(extraction));
    const frozenApproval = deepFreeze(structuredClone(approval));
    const before = JSON.stringify([frozenExtraction, frozenApproval]);
    expect(createCadSceneSeed(frozenExtraction, frozenApproval).sceneSpec).toEqual(
      expectedSceneSpec,
    );
    expect(JSON.stringify([frozenExtraction, frozenApproval])).toBe(before);
  });
});

// ---------------------------------------------------------- worker boundary

describe("worker seed file boundary", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const workspace = () => {
    const base = mkdtempSync(join(tmpdir(), "avz-cad-10c-"));
    roots.push(base);
    const root = join(base, "root");
    mkdirSync(join(root, "inputs"), { recursive: true });
    copyFileSync(
      join(interpretationDirectory, "expected-architectural-extraction-v0.1.json"),
      join(root, "inputs", "extraction.json"),
    );
    copyFileSync(join(seedDirectory, "approval-v0.1.json"), join(root, "inputs", "approval.json"));
    mkdirSync(join(base, "outside", "target"), { recursive: true });
    return { root, outside: join(base, "outside") };
  };
  const linkDirectory = (target: string, path: string) =>
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  const options = (root: string, overrides: Record<string, string> = {}) => ({
    repositoryRoot: root,
    extractionPath: "inputs/extraction.json",
    approvalPath: "inputs/approval.json",
    ...overrides,
  });

  it("seeds from files and writes SceneSpec + evidence inside the output root", () => {
    const { root } = workspace();
    const result = seedSceneFromCadFiles(options(root));
    const paths = writeCadSceneSeed(result, join(root, ".workspace"), "seed/scene-spec.json");
    expect(read(paths.sceneSpecPath)).toEqual(expectedSceneSpec);
    expect(read(paths.evidencePath)).toEqual(expectedEvidence);
  });

  it("uses physical containment for inputs and outputs (junction escapes rejected, nothing written outside)", () => {
    const { root, outside } = workspace();
    copyFileSync(join(seedDirectory, "approval-v0.1.json"), join(outside, "approval.json"));
    linkDirectory(outside, join(root, "linked-in"));
    expect(
      workerFailure(() =>
        seedSceneFromCadFiles(options(root, { approvalPath: "linked-in/approval.json" })),
      ).code,
    ).toBe("CAD_SCENE_SEED_INPUT_PATH_INVALID");
    expect(
      workerFailure(() =>
        seedSceneFromCadFiles(options(root, { approvalPath: "../outside/approval.json" })),
      ).code,
    ).toBe("CAD_SCENE_SEED_INPUT_PATH_INVALID");
    expect(
      workerFailure(() =>
        seedSceneFromCadFiles(options(root, { approvalPath: "inputs/none.json" })),
      ).code,
    ).toBe("CAD_SCENE_SEED_INPUT_NOT_FOUND");
    const result = seedSceneFromCadFiles(options(root));
    const outputRoot = join(root, ".workspace");
    mkdirSync(outputRoot);
    linkDirectory(join(outside, "target"), join(outputRoot, "linked-out"));
    for (const outputPath of [
      "linked-out/scene-spec.json",
      "../escape.json",
      "x.evidence.json",
      "x.txt",
    ]) {
      expect(workerFailure(() => writeCadSceneSeed(result, outputRoot, outputPath)).code).toBe(
        "CAD_SCENE_SEED_OUTPUT_PATH_INVALID",
      );
    }
    expect(readdirSync(join(outside, "target"))).toEqual([]);
    const inputsRoot = join(root, "inputs");
    expect(workerFailure(() => writeCadSceneSeed(result, inputsRoot, "approval.json")).code).toBe(
      "CAD_SCENE_SEED_OUTPUT_PATH_INVALID",
    );
    expect(read(join(inputsRoot, "approval.json"))).toEqual(approval);
  });
});

// ------------------------------------------------------------ static guards

describe("Spike 10C static boundary guards", () => {
  const sourceDirectory = join(repositoryRoot, "packages/cad-scene-seed/src");
  const sources = readdirSync(sourceDirectory)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({ file, text: readFileSync(join(sourceDirectory, file), "utf8") }));
  const importsOf = (text: string) =>
    [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1] as string);

  it("cad-scene-seed imports only upstream CAD packages, scene-spec, schema utilities, and local modules", () => {
    const allowed = new Set([
      "@ai-archviz/cad-interpreter",
      // Spike 10F multi-space seed: the reviewed 10D/10E chain (upstream packages).
      "@ai-archviz/cad-partition-model",
      "@ai-archviz/cad-topology",
      "@ai-archviz/scene-spec",
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
  });

  it("has no auto-approval, DXF parsing, DCC, renderer, process, network, or AI code", () => {
    const forbidden =
      /auto_?approve|approveAutomatically|DxfPair|parseDxfSource|DxfSourceAdapter|interpretCadDocument\(|child_process|node:http|node:https|\bfetch\(|process\.env|\beval\(|new Function|apps\/worker|pymxs|3dsmax|corona|openai|anthropic/i;
    for (const { file, text } of sources) expect(text, file).not.toMatch(forbidden);
  });

  it("keeps cad-interpreter SceneSpec-independent (dependency direction)", () => {
    const interpreterDirectory = join(repositoryRoot, "packages/cad-interpreter");
    expect(readFileSync(join(interpreterDirectory, "package.json"), "utf8")).not.toMatch(
      /scene-spec|cad-scene-seed/,
    );
    for (const file of readdirSync(join(interpreterDirectory, "src"))) {
      expect(readFileSync(join(interpreterDirectory, "src", file), "utf8")).not.toMatch(
        /@ai-archviz\/scene-spec|cad-scene-seed/,
      );
    }
  });

  it("keeps the worker seed boundary on hardened paths and off the revision pipeline", () => {
    const text = readFileSync(join(repositoryRoot, "apps/worker/src/cad-scene-seed.ts"), "utf8");
    expect(text).not.toMatch(
      /resolveWithinRoot|revision\.js|SceneChangeSet|child_process|process\.env/,
    );
    expect(text).toMatch(/resolveExistingFileWithinRoot/);
    expect(text).toMatch(/resolveOutputPathWithinRoot/);
  });
});
