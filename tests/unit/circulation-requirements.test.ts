import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sceneChangeSetSchema,
  sceneChangeSetV02Schema,
  sceneChangeSetV03Schema,
  sceneSpecV03Schema,
  sceneSpecV04Schema,
  validateSceneSpec,
} from "@ai-archviz/scene-spec";
import {
  semanticJsonHash,
  validateCirculationRequirementEvidence,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  CirculationRequirementContractError,
  circulationRequirementEvidence,
} from "../../apps/worker/src/index.js";
import {
  analyzeCirculation,
  type CirculationRequirementEvaluation,
  evaluateCirculationRequirements,
  validateSpatialScene,
} from "../../packages/spatial-engine/src/index.js";

type Scene = Record<string, unknown>;
type Requirement = Record<string, unknown>;

const fixturePath = resolve("tests/fixtures/circulation-requirements/scene-spec-v0.4.json");
const goldenRoot = resolve("tests/fixtures/living-room-golden");
const studio = "space_studio_main";
const entryReq = "circulation_req_entry_to_east_zone";
const crossReq = "circulation_req_northwest_to_southeast";
const locks = { geometry: false, transform: false, material: false };
const identity = { position: [0, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] };

function fixtureScene(): Scene {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Scene;
}

function readJson(path: string): Scene {
  return JSON.parse(readFileSync(path, "utf8")) as Scene;
}

function requirementsOf(scene: Scene): Requirement[] {
  return scene.circulationRequirements as Requirement[];
}

interface Box {
  id: string;
  center: [number, number];
  size: [number, number];
  spaceId?: string;
}

/** Adds schema-complete proxy assets (and one definition each) so the scene stays a valid v0.4 SceneSpec. */
function withAssets(scene: Scene, boxes: Box[]): Scene {
  const clone = structuredClone(scene);
  for (const box of boxes) {
    (clone.assetDefinitions as unknown[]).push({
      id: `assetdef_${box.id}`,
      version: "1",
      category: "generic_proxy",
      sourceType: "procedural_proxy",
      dimensions: [box.size[0], box.size[1], 600],
      pivotPolicy: "floor_center",
      allowNonUniformScale: false,
    });
    (clone.assets as unknown[]).push({
      id: box.id,
      type: "proxy_asset",
      assetDefinitionId: `assetdef_${box.id}`,
      spaceId: box.spaceId ?? studio,
      transform: {
        position: [box.center[0], box.center[1], 0],
        rotationEuler: [0, 0, 0],
        scale: [1, 1, 1],
      },
      locks,
    });
  }
  return clone;
}

function withDoor(scene: Scene, id: string, hostGeometryId: string, offset: number): Scene {
  const clone = structuredClone(scene);
  (clone.openings as unknown[]).push({
    id,
    type: "door",
    hostGeometryId,
    offset,
    width: 900,
    sill: 0,
    height: 2100,
    hingeSide: "start_jamb",
    swingDirection: "into_room",
    transform: { position: [offset, 0, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
    locks,
  });
  return clone;
}

/** Adds a second canonical space on an upper level with the identical XY boundary (stacked floor). */
function withUpperSpace(scene: Scene): Scene {
  const clone = structuredClone(scene);
  (clone.levels as unknown[]).push({
    id: "level_upper",
    name: "Upper Floor",
    elevation: 3000,
    defaultCeilingHeight: 2800,
  });
  const lower = (clone.spaces as Array<{ boundary: number[][] }>)[0];
  const boundary = structuredClone(lower?.boundary ?? []);
  (clone.spaces as unknown[]).push({
    id: "space_studio_upper",
    levelId: "level_upper",
    type: "bedroom",
    boundary,
    boundaryWinding: "counter_clockwise",
    floorElevation: 3000,
    ceilingHeight: 2800,
    transform: identity,
  });
  ["south", "east", "north", "west"].forEach((side, index) => {
    (clone.geometry as unknown[]).push({
      id: `wall_upper_${side}`,
      type: "wall",
      levelId: "level_upper",
      spaceId: "space_studio_upper",
      start: boundary[index],
      end: boundary[(index + 1) % boundary.length],
      baseElevation: 3000,
      height: 2800,
      thickness: 150,
      referenceLine: "interior_face",
      thicknessDirection: "exterior_right_of_u",
      transform: identity,
      locks,
    });
  });
  return clone;
}

function withRequirements(scene: Scene, requirements: Requirement[]): Scene {
  const clone = structuredClone(scene);
  clone.circulationRequirements = requirements;
  return clone;
}

function patchRequirement(scene: Scene, index: number, patch: Requirement): Scene {
  const clone = structuredClone(scene);
  const list = requirementsOf(clone);
  list[index] = { ...list[index], ...patch };
  return clone;
}

function keywords(scene: unknown): string[] {
  const result = validateSceneSpec(scene);
  return result.ok ? [] : result.errors.map((error) => error.keyword);
}

function resultFor(evaluation: CirculationRequirementEvaluation, requirementId: string) {
  const result = evaluation.requirements.find((entry) => entry.requirementId === requirementId);
  if (!result) throw new Error(`missing ${requirementId}`);
  return result;
}

/** A closed U of three touching shelves around (4400,2500), open only to the east wall. */
const eastPocket: Box[] = [
  { id: "asset_pocket_south", center: [4350, 1950], size: [1300, 100] },
  { id: "asset_pocket_north", center: [4350, 3050], size: [1300, 100] },
  { id: "asset_pocket_west", center: [3750, 2500], size: [100, 1000] },
];

const frozenBaseline = [
  {
    requirementId: entryReq,
    spaceId: studio,
    startKind: "door_portal",
    endKind: "point",
    resolvedStartXY: [900, 1950],
    resolvedEndXY: [4400, 2500],
    status: "SATISFIED",
    startNodeId: "space_studio_main::8::19",
    endNodeId: "space_studio_main::43::24",
    distanceMm: 3707.106781,
    orthogonalStepCount: 30,
    diagonalStepCount: 5,
    failureCode: null,
    routeSemanticHash: "sha256:a64a98573ffff2a11cea3e22b9bd66152af20aaea1b4d563b5c4f27a967a157e",
  },
  {
    requirementId: crossReq,
    spaceId: studio,
    startKind: "point",
    endKind: "point",
    resolvedStartXY: [800, 3300],
    resolvedEndXY: [4400, 500],
    status: "SATISFIED",
    startNodeId: "space_studio_main::7::32",
    endNodeId: "space_studio_main::43::4",
    distanceMm: 5169.848481,
    orthogonalStepCount: 22,
    diagonalStepCount: 21,
    failureCode: null,
    routeSemanticHash: "sha256:cde8046f61f6c62e3af0230cc13f713d4eb2d6a6706c194ffec262640225c8f4",
  },
];

describe("SceneSpec v0.4 contract versioning", () => {
  it("adds only circulationRequirements and its defs on top of an otherwise identical v0.3", () => {
    const v03 = sceneSpecV03Schema as {
      required: string[];
      properties: Record<string, unknown>;
      $defs: Record<string, unknown>;
    };
    const v04 = sceneSpecV04Schema as typeof v03;
    expect(v04.required).toEqual([...v03.required, "circulationRequirements"]);
    expect(v04.properties.sceneSpecVersion).toEqual({ const: "0.4.0" });
    for (const [key, value] of Object.entries(v03.properties)) {
      if (key !== "sceneSpecVersion") expect(v04.properties[key]).toEqual(value);
    }
    for (const [key, value] of Object.entries(v03.$defs)) expect(v04.$defs[key]).toEqual(value);
    expect(Object.keys(v04.$defs).filter((key) => !(key in v03.$defs))).toEqual([
      "point2",
      "circulationRequirement",
      "circulationEndpoint",
      "circulationDoorPortalEndpoint",
      "circulationPointEndpoint",
    ]);
    // Generic constraints[] keeps its frozen v0.3 semantics.
    expect(v04.$defs.constraint).toEqual(v03.$defs.constraint);
  });

  it("validates the dedicated v0.4 fixture as a complete SceneSpec", () => {
    expect(validateSceneSpec(fixtureScene())).toMatchObject({ ok: true });
  });

  it("requires circulationRequirements in v0.4 and accepts an explicit empty array", () => {
    const missing = fixtureScene();
    delete missing.circulationRequirements;
    expect(keywords(missing)).toContain("required");
    expect(validateSceneSpec(withRequirements(fixtureScene(), []))).toMatchObject({ ok: true });
  });

  it("rejects circulationRequirements on v0.3 and rejects unknown SceneSpec versions", () => {
    const rev12 = readJson(resolve(goldenRoot, "revisions/rev_golden_0012/scene-spec.json"));
    expect(validateSceneSpec(rev12)).toMatchObject({ ok: true });
    expect(keywords({ ...rev12, circulationRequirements: [] })).toContain("additionalProperties");
    expect(validateSceneSpec({ ...fixtureScene(), sceneSpecVersion: "0.5.0" }).ok).toBe(false);
  });

  it("keeps v0.4 asset identity validation", () => {
    const scene = fixtureScene();
    const assets = scene.assets as Array<Record<string, unknown>>;
    const duplicate = structuredClone(scene);
    (duplicate.assets as unknown[]).push({ ...assets[0] });
    expect(keywords(duplicate)).toContain("uniqueLogicalAssetId");
    const unresolved = structuredClone(scene);
    (unresolved.assets as Array<Record<string, unknown>>)[0] = {
      ...assets[0],
      assetDefinitionId: "assetdef_missing",
    };
    expect(keywords(unresolved)).toContain("assetDefinitionReference");
  });

  it("keeps every historical SceneSpec valid, unmigrated, and without a rev13", () => {
    const revisions = readdirSync(resolve(goldenRoot, "revisions")).sort();
    expect(revisions.at(-1)).toBe("rev_golden_0012");
    expect(existsSync(resolve(goldenRoot, "revisions/rev_golden_0013"))).toBe(false);
    const golden = [
      resolve(goldenRoot, "scene-spec.json"),
      ...revisions.map((revision) => resolve(goldenRoot, "revisions", revision, "scene-spec.json")),
    ];
    for (const path of [
      ...golden,
      resolve("tests/fixtures/corona-adapter/scene-spec.json"),
      resolve("tests/fixtures/corona-material-appearance/scene-spec-v0.3.json"),
    ]) {
      const scene = readJson(path);
      expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
      expect(["0.2.0", "0.3.0"]).toContain(scene.sceneSpecVersion);
      expect(scene).not.toHaveProperty("circulationRequirements");
    }
    expect(readJson(golden.at(-1) as string).sceneSpecVersion).toBe("0.3.0");
  });

  it("still accepts a v0.1 SceneSpec (rev1 projected back to the v0.1 inline-asset shape)", () => {
    const scene = readJson(resolve(goldenRoot, "scene-spec.json"));
    const definitions = new Map(
      (scene.assetDefinitions as Array<Record<string, unknown>>).map((entry) => [entry.id, entry]),
    );
    scene.sceneSpecVersion = "0.1.0";
    scene.assets = (scene.assets as Array<Record<string, unknown>>).map(
      ({ assetDefinitionId, ...asset }) => {
        const definition = definitions.get(assetDefinitionId) ?? {};
        return {
          ...asset,
          category: definition.category,
          dimensions: definition.dimensions,
          pivotPolicy: definition.pivotPolicy,
          allowNonUniformScale: definition.allowNonUniformScale,
        };
      },
    );
    delete scene.assetDefinitions;
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
  });

  it("adds no circulation operation to any SceneChangeSet schema", () => {
    for (const schema of [sceneChangeSetSchema, sceneChangeSetV02Schema, sceneChangeSetV03Schema]) {
      expect(JSON.stringify(schema)).not.toMatch(/circulation/iu);
    }
  });
});

describe("SceneSpec v0.4 circulation requirement structure", () => {
  it("rejects a requirement whose space does not exist", () => {
    const scene = patchRequirement(fixtureScene(), 0, { spaceId: "space_missing" });
    expect(keywords(scene)).toContain("circulationRequirementSpaceReference");
  });

  it("rejects a door_portal that references a missing opening", () => {
    const scene = patchRequirement(fixtureScene(), 0, {
      start: { kind: "door_portal", openingId: "opening_missing" },
    });
    expect(keywords(scene)).toEqual(["circulationRequirementOpeningReference"]);
  });

  it("rejects a window used as a door portal", () => {
    const scene = patchRequirement(fixtureScene(), 0, {
      start: { kind: "door_portal", openingId: "opening_window_north" },
    });
    expect(keywords(scene)).toEqual(["circulationRequirementOpeningType"]);
  });

  it("rejects a door whose host is missing or not a wall", () => {
    for (const hostGeometryId of ["wall_missing", "surface_floor_main"]) {
      const scene = fixtureScene();
      (scene.openings as Array<Record<string, unknown>>)[0] = {
        ...(scene.openings as Array<Record<string, unknown>>)[0],
        hostGeometryId,
      };
      expect(keywords(scene)).toContain("circulationRequirementOpeningHost");
    }
  });

  it("rejects a door that belongs to another space, even with an identical XY boundary", () => {
    const scene = withDoor(
      withUpperSpace(fixtureScene()),
      "opening_upper_door",
      "wall_upper_west",
      1600,
    );
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
    const mismatched = patchRequirement(scene, 0, {
      start: { kind: "door_portal", openingId: "opening_upper_door" },
    });
    expect(keywords(mismatched)).toEqual(["circulationRequirementOpeningSpace"]);
  });

  it("rejects duplicate requirement IDs", () => {
    const scene = fixtureScene();
    const [first] = requirementsOf(scene);
    const duplicated = withRequirements(scene, [
      first as Requirement,
      { ...first, end: { kind: "point", pointXY: [4400, 600] } },
    ]);
    expect(keywords(duplicated)).toEqual(["uniqueCirculationRequirementId"]);
  });

  it("rejects unsorted requirements instead of silently reordering them", () => {
    const scene = fixtureScene();
    const reversed = withRequirements(scene, [...requirementsOf(scene)].reverse());
    expect(keywords(reversed)).toEqual(["circulationRequirementOrder"]);
    expect(requirementsOf(reversed).map((entry) => entry.id)).toEqual([crossReq, entryReq]);
  });

  it("rejects identical point and identical door_portal endpoint pairs", () => {
    const samePoint = patchRequirement(fixtureScene(), 1, {
      end: { kind: "point", pointXY: [800, 3300] },
    });
    expect(keywords(samePoint)).toEqual(["circulationRequirementDistinctEndpoints"]);
    const sameDoor = patchRequirement(fixtureScene(), 0, {
      end: { kind: "door_portal", openingId: "opening_door_west" },
    });
    expect(keywords(sameDoor)).toEqual(["circulationRequirementDistinctEndpoints"]);
  });

  it("never compares a door portal against a point geometrically during validation", () => {
    const scene = patchRequirement(fixtureScene(), 0, {
      end: { kind: "point", pointXY: [900, 1950] },
    });
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
  });

  it("pins evaluationPolicy and the single supported type and endpoint kinds in the schema", () => {
    const cases: Requirement[] = [
      { evaluationPolicy: "circulation-policy-v0.2" },
      { type: "cross_space_route" },
      { end: { kind: "asset_front", assetId: "asset_studio_sofa" } },
      { end: { kind: "point", pointXY: [4400, 2500, 0] } },
      { end: { kind: "point", pointXY: [Number.NaN, 2500] } },
      { end: { kind: "point", pointXY: [Number.POSITIVE_INFINITY, 2500] } },
      { severity: "warning" },
    ];
    for (const patch of cases) {
      expect(validateSceneSpec(patchRequirement(fixtureScene(), 0, patch)).ok).toBe(false);
    }
  });

  it("keeps blocked-endpoint and no-route scenes structurally valid", () => {
    expect(validateSceneSpec(withAssets(fixtureScene(), eastPocket))).toMatchObject({ ok: true });
    const blockedPoint = patchRequirement(fixtureScene(), 1, {
      end: { kind: "point", pointXY: [4150, 1200] },
    });
    expect(validateSceneSpec(blockedPoint)).toMatchObject({ ok: true });
  });

  it("refuses to build evidence for a structurally invalid or non-v0.4 scene", () => {
    const invalid = patchRequirement(fixtureScene(), 0, { spaceId: "space_missing" });
    expect(() => circulationRequirementEvidence(invalid)).toThrow(
      CirculationRequirementContractError,
    );
    expect(() => circulationRequirementEvidence(invalid)).toThrow(
      /circulationRequirementSpaceReference/u,
    );
    const rev12 = readJson(resolve(goldenRoot, "revisions/rev_golden_0012/scene-spec.json"));
    expect(() => circulationRequirementEvidence(rev12)).toThrow(/only in SceneSpec v0.4/u);
  });
});

describe("Technical Spike 9C: canonical requirement satisfaction", () => {
  it("satisfies both baseline requirements with frozen normalized evidence", () => {
    const evidence = circulationRequirementEvidence(fixtureScene());
    expect(validateCirculationRequirementEvidence(evidence).ok).toBe(true);
    expect(evidence).toEqual({
      evidenceVersion: "0.1.0",
      projectId: "project_circulation_requirements_001",
      sceneId: "scene_circulation_requirements_001",
      revisionId: "rev_circreq_0001",
      sceneSpecVersion: "0.4.0",
      sceneSpecHash: "sha256:3fef022d256697ee0a2f9444ef31d25e13b0135ae1e245cf281f833bf88f2bc3",
      circulationPolicyVersion: "circulation-policy-v0.1",
      spatialPolicyVersion: "spatial-policy-v0.1",
      requirementSetHash: "sha256:a7626e7eff1395f85b5219d5159b14f2783a001d01ba5ceb6661752ae4cf2b34",
      graphSemanticHash: "sha256:8b057f7a740c65571ac88d78dab3e73f748cbead16613597c02424027df2b104",
      requirements: frozenBaseline,
      status: "PASS",
    });
    expect(evidence.requirementSetHash).toBe(
      semanticJsonHash(fixtureScene().circulationRequirements),
    );
    expect(JSON.stringify(evidence)).not.toMatch(/"path"|"nodeIds"|"pointsXY"/u);
  });

  it("resolves door_portal endpoints to exactly the 9B analysis portal and node", () => {
    const scene = fixtureScene();
    const portal = analyzeCirculation(scene).spaces[0]?.doorPortals[0];
    const result = resultFor(evaluateCirculationRequirements(scene), entryReq);
    expect(result.resolvedStartXY).toEqual(portal?.portalXY);
    expect(result.startNodeId).toBe(portal?.nodeId);
  });

  it("reports CIRCULATION_NO_ROUTE for a structurally valid, 9A-valid scene with a disconnected required route", () => {
    const scene = withAssets(fixtureScene(), eastPocket);
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const evaluation = evaluateCirculationRequirements(scene);
    expect(evaluation.status).toBe("FAILED");
    expect(resultFor(evaluation, entryReq)).toMatchObject({
      status: "UNSATISFIED",
      failureCode: "CIRCULATION_NO_ROUTE",
      resolvedStartXY: [900, 1950],
      resolvedEndXY: [4400, 2500],
      startNodeId: "space_studio_main::8::19",
      distanceMm: null,
      orthogonalStepCount: null,
      diagonalStepCount: null,
      route: null,
    });
    expect(resultFor(evaluation, entryReq).endNodeId).not.toBeNull();
    expect(resultFor(evaluation, crossReq).status).toBe("SATISFIED");
    const evidence = circulationRequirementEvidence(scene);
    expect(validateCirculationRequirementEvidence(evidence).ok).toBe(true);
    expect(evidence.status).toBe("FAILED");
  });

  it("reports CIRCULATION_ENDPOINT_BLOCKED for a point inside probe clearance, without snapping", () => {
    const scene = patchRequirement(fixtureScene(), 1, {
      end: { kind: "point", pointXY: [4150, 1200] },
    });
    const evaluation = evaluateCirculationRequirements(scene);
    expect(resultFor(evaluation, crossReq)).toMatchObject({
      status: "UNSATISFIED",
      failureCode: "CIRCULATION_ENDPOINT_BLOCKED",
      resolvedEndXY: [4150, 1200],
      endNodeId: null,
      distanceMm: null,
    });
    expect(resultFor(evaluation, entryReq).status).toBe("SATISFIED");
    expect(evaluation.status).toBe("FAILED");
  });

  it("reports CIRCULATION_PORTAL_BLOCKED when furniture sits flush against a required door's clearance", () => {
    const scene = withAssets(fixtureScene(), [
      { id: "asset_entry_shelf", center: [1200, 1950], size: [600, 700] },
    ]);
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const evaluation = evaluateCirculationRequirements(scene);
    expect(resultFor(evaluation, entryReq)).toMatchObject({
      status: "UNSATISFIED",
      failureCode: "CIRCULATION_PORTAL_BLOCKED",
      resolvedStartXY: [900, 1950],
      startNodeId: null,
      distanceMm: null,
    });
    expect(resultFor(evaluation, crossReq).status).toBe("SATISFIED");
  });

  it("does not fail requirements because an unrelated, unreferenced door portal is blocked", () => {
    const scene = withAssets(withDoor(fixtureScene(), "opening_door_south", "wall_south", 500), [
      { id: "asset_south_shelf", center: [950, 1100], size: [700, 400] },
    ]);
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
    expect(validateSpatialScene(scene).status).toBe("PASS");
    const analysis = analyzeCirculation(scene);
    expect(analysis.status).toBe("FAILED");
    expect(analysis.violations).toEqual([
      expect.objectContaining({
        code: "CIRCULATION_PORTAL_BLOCKED",
        openingId: "opening_door_south",
      }),
    ]);
    const evaluation = evaluateCirculationRequirements(scene);
    expect(evaluation.status).toBe("PASS");
    expect(evaluation.requirements.map((entry) => entry.status)).toEqual([
      "SATISFIED",
      "SATISFIED",
    ]);
    expect(circulationRequirementEvidence(scene).status).toBe("PASS");
  });

  it("fails every requirement closed when the source fails spatial-policy-v0.1", () => {
    const scene = withAssets(fixtureScene(), [
      { id: "asset_colliding_box", center: [2500, 3400], size: [400, 400] },
    ]);
    expect(validateSceneSpec(scene)).toMatchObject({ ok: true });
    expect(validateSpatialScene(scene).status).toBe("FAILED");
    const evaluation = evaluateCirculationRequirements(scene);
    expect(evaluation.status).toBe("FAILED");
    for (const result of evaluation.requirements) {
      expect(result).toMatchObject({
        status: "UNSATISFIED",
        failureCode: "CIRCULATION_SOURCE_SPATIAL_INVALID",
        resolvedStartXY: null,
        resolvedEndXY: null,
      });
    }
    expect(validateCirculationRequirementEvidence(circulationRequirementEvidence(scene)).ok).toBe(
      true,
    );
    expect(evaluateCirculationRequirements(withRequirements(scene, [])).status).toBe("FAILED");
  });

  it("is unaffected by furniture in another space sharing the same XY", () => {
    const baseline = circulationRequirementEvidence(fixtureScene());
    const upperDivider: Box = {
      id: "asset_upper_divider",
      // x 1200..1400, wall to wall: clear of the sofa (x>=1500) and the door clearance (x<=900).
      center: [1300, 2000],
      size: [200, 4000],
      spaceId: "space_studio_upper",
    };
    const stacked = withAssets(withUpperSpace(fixtureScene()), [upperDivider]);
    expect(validateSceneSpec(stacked)).toMatchObject({ ok: true });
    const evidence = circulationRequirementEvidence(stacked);
    expect(evidence.requirements).toEqual(baseline.requirements);
    expect(evidence.status).toBe("PASS");

    // The same divider in the requirement's own space does break the route.
    const sameSpace = withAssets(fixtureScene(), [{ ...upperDivider, spaceId: studio }]);
    expect(resultFor(evaluateCirculationRequirements(sameSpace), entryReq).failureCode).toBe(
      "CIRCULATION_NO_ROUTE",
    );
  });
});

describe("Technical Spike 9C: determinism, immutability, and scope", () => {
  function stackedScene(): Scene {
    return withAssets(withUpperSpace(fixtureScene()), [
      {
        id: "asset_upper_bed",
        center: [2500, 2000],
        size: [1600, 2000],
        spaceId: "space_studio_upper",
      },
    ]);
  }

  it("returns deep-equal results and hashes across repeated evaluation", () => {
    expect(evaluateCirculationRequirements(stackedScene())).toEqual(
      evaluateCirculationRequirements(stackedScene()),
    );
    expect(circulationRequirementEvidence(stackedScene())).toEqual(
      circulationRequirementEvidence(stackedScene()),
    );
  });

  it("is independent of spaces/assets/definitions/geometry/openings order", () => {
    const scene = stackedScene();
    const reordered = structuredClone(scene);
    for (const key of ["spaces", "assets", "assetDefinitions", "geometry", "openings"]) {
      (reordered[key] as unknown[]).reverse();
    }
    const original = circulationRequirementEvidence(scene);
    const shuffled = circulationRequirementEvidence(reordered);
    expect(shuffled.requirements).toEqual(original.requirements);
    expect(shuffled.graphSemanticHash).toBe(original.graphSemanticHash);
    expect(shuffled.requirementSetHash).toBe(original.requirementSetHash);
    expect(shuffled.status).toBe(original.status);
    expect(
      evaluateCirculationRequirements(reordered).requirements.map((entry) => entry.requirementId),
    ).toEqual([entryReq, crossReq]);
  });

  it("never mutates the input SceneSpec", () => {
    const scene = stackedScene();
    const before = structuredClone(scene);
    const bytes = JSON.stringify(scene);
    validateSceneSpec(scene);
    analyzeCirculation(scene);
    evaluateCirculationRequirements(scene);
    circulationRequirementEvidence(scene);
    expect(scene).toEqual(before);
    expect(JSON.stringify(scene)).toBe(bytes);
  });

  it("reuses 9B instead of reimplementing grid, clearance, portal, or pathfinding logic", () => {
    const source = readFileSync(
      resolve("packages/spatial-engine/src/circulation-requirements.ts"),
      "utf8",
    );
    expect(source).toMatch(/analyzeCirculation\(/u);
    expect(source).toMatch(/findCirculationRoute\(/u);
    expect(source).not.toMatch(
      /CIRCULATION_GRID_STEP_MM|CIRCULATION_AGENT_RADIUS_MM|distancePoint|distanceSegment|buildSpaceGraph|shortestPath|MinHeap|intoRoom|wallFrame/u,
    );
  });

  it("adds no circulation enforcement to the revision or external-ingestion paths", () => {
    for (const path of [
      "apps/worker/src/revision.ts",
      "apps/worker/src/external-asset-ingestion.ts",
    ]) {
      expect(readFileSync(resolve(path), "latin1")).not.toMatch(/circulation/iu);
    }
  });
});
