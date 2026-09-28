import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  sceneChangeSetV03Schema,
  sceneChangeSetV04Schema,
  validateSceneChangeSet,
  validateSceneSpec,
} from "@ai-archviz/scene-spec";
import {
  canonicalCameraStateSchema,
  canonicalCameraStateV02Schema,
  canonicalMaterialStateSchema,
  canonicalMaterialStateV02Schema,
  semanticJsonHash,
  validateCanonicalCameraStateEvidence,
  validateCanonicalCameraStateEvidenceV02,
  validateCanonicalMaterialStateEvidence,
  validateCanonicalMaterialStateEvidenceV02,
  validateCanonicalRenderStateEvidence,
  validateCirculationRequirementEvidence,
} from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import type { AssetArtifactRegistry } from "../../apps/worker/src/asset-trust.js";
import {
  ExternalAssetIngestionError,
  ingestVerifiedExternalMaxAsset,
  preflightExternalAssetIngestion,
  type TrustedExternalAssetCatalog,
} from "../../apps/worker/src/external-asset-ingestion.js";
import {
  applySceneChangeSet,
  assertRevisionDiff,
  CirculationRequirementUnsatisfiedError,
  canonicalCameraStateExpectation,
  canonicalMaterialStateExpectation,
  canonicalRenderStateExpectation,
  circulationAnalysisEvidence,
  circulationEvidencePromotionFailure,
  circulationRequirementEvidence,
  diffSemanticManifests,
  planSceneRevision,
  RevisionValidationError,
} from "../../apps/worker/src/index.js";

type Json = Record<string, unknown>;

const goldenRoot = resolve("tests/fixtures/living-room-golden");
const enforcementPath = resolve(
  "tests/fixtures/circulation-requirements/enforcement/scene-spec-v0.4.json",
);
const goldenRequirementId = "circulation_req_entry_to_east_clear_point";

function read(path: string): Json {
  return JSON.parse(readFileSync(path, "utf8")) as Json;
}
const golden = (path: string): Json => read(resolve(goldenRoot, path));
const rev12 = (): Json => golden("revisions/rev_golden_0012/scene-spec.json");
const rev13 = (): Json => golden("revisions/rev_golden_0013/scene-spec.json");
const migrationChangeSet = (): Json =>
  golden("changesets/migrate-circulation-requirement-contract-r13.json");
const enforcementScene = (): Json => read(enforcementPath);

function migrationOperation(changeSet: Json): Json {
  return (changeSet.operations as Json[])[0] as Json;
}

function migrationRequirements(changeSet: Json): Json[] {
  return (migrationOperation(changeSet).parameters as Json).circulationRequirements as Json[];
}

/** A tracked Golden changeset re-targeted as a candidate (never written to disk). */
function candidate(
  name: string,
  baseRevisionId: string,
  targetRevisionId: string,
  schemaVersion = "0.4.0",
): Json {
  const changeSet = golden(`changesets/${name}`);
  changeSet.schemaVersion = schemaVersion;
  changeSet.baseRevisionId = baseRevisionId;
  changeSet.targetRevisionId = targetRevisionId;
  changeSet.changeSetId = `chg_candidate_${targetRevisionId}`;
  return changeSet;
}

function moveCoffeeTable(base: string, target: string, position: number[], version = "0.4.0") {
  const changeSet = candidate("move-coffee-table-r2.json", base, target, version);
  ((migrationOperation(changeSet).parameters as Json).transform as Json).position = position;
  return changeSet;
}

function moveCabinet(position: number[], rotationZ = 0): Json {
  const base = enforcementScene();
  return {
    schemaVersion: "0.4.0",
    changeSetId: "chg_enforcement_move_cabinet",
    projectId: (base.project as Json).id,
    sceneId: (base.scene as Json).id,
    baseRevisionId: "rev_circenf_0001",
    targetRevisionId: "rev_circenf_0002",
    requestedBy: { type: "operator", id: "operator_enforcement_fixture" },
    source: { type: "manual_edit", referenceIds: ["source_circulation_enforcement_fixture"] },
    intent: "Candidate placement of the mobile cabinet.",
    riskLevel: "low",
    operations: [
      {
        operationId: "op_enforcement_move_cabinet",
        type: "MoveObject",
        targetId: "asset_mobile_cabinet",
        reason: "Candidate cabinet placement.",
        riskLevel: "low",
        parameters: {
          transform: { position, rotationEuler: [0, 0, rotationZ], scale: [1, 1, 1] },
        },
        preconditions: [],
        provenance: [],
        expectedImpact: { affectedLogicalIds: ["asset_mobile_cabinet"] },
      },
    ],
    preconditions: [],
    metadata: { createdAt: "2026-09-27T01:00:00Z" },
  };
}

function planError(base: Json, changeSet: Json): RevisionValidationError {
  try {
    planSceneRevision(base, changeSet);
  } catch (error) {
    if (error instanceof RevisionValidationError) return error;
    throw error;
  }
  throw new Error("expected planSceneRevision to reject");
}

function expectGateFailure(
  base: Json,
  changeSet: Json,
  requirementId: string,
  failureCode: string,
) {
  const error = planError(base, changeSet);
  expect(error).toBeInstanceOf(CirculationRequirementUnsatisfiedError);
  expect(error.code).toBe("CIRCULATION_REQUIREMENT_UNSATISFIED");
  expect((error as CirculationRequirementUnsatisfiedError).requirementId).toBe(requirementId);
  expect((error as CirculationRequirementUnsatisfiedError).failureCode).toBe(failureCode);
}

describe("SceneChangeSet v0.4 contract", () => {
  it("is v0.3 plus exactly one new operation and its requirement definitions", () => {
    const v03 = sceneChangeSetV03Schema as { properties: Json; $defs: Json };
    const v04 = sceneChangeSetV04Schema as typeof v03;
    const operations = v04.properties.operations as Json as {
      minItems: number;
      maxItems: number;
      items: { oneOf: unknown[] };
    };
    expect(operations.minItems).toBe(1);
    expect(operations.maxItems).toBe(1);
    expect(operations.items.oneOf).toEqual([
      ...((v03.properties.operations as Json).items as { oneOf: unknown[] }).oneOf,
      { $ref: "#/$defs/migrateCirculationRequirementContract" },
    ]);
    for (const [key, value] of Object.entries(v03.$defs)) expect(v04.$defs[key]).toEqual(value);
    expect(
      Object.keys(v04.$defs)
        .filter((key) => !(key in v03.$defs))
        .sort(),
    ).toEqual([
      "circulationDoorPortalEndpoint",
      "circulationEndpoint",
      "circulationPointEndpoint",
      "circulationRequirement",
      "migrateCirculationRequirementContract",
      "point2",
    ]);
  });

  it("accepts the r13 migration only under schemaVersion 0.4.0", () => {
    expect(validateSceneChangeSet(migrationChangeSet())).toMatchObject({ ok: true });
    for (const schemaVersion of ["0.1.0", "0.2.0", "0.3.0"]) {
      expect(validateSceneChangeSet({ ...migrationChangeSet(), schemaVersion }).ok).toBe(false);
    }
    const unsupported = validateSceneChangeSet({ ...migrationChangeSet(), schemaVersion: "0.5.0" });
    expect(unsupported.ok).toBe(false);
    expect(unsupported.ok ? [] : unsupported.errors.map((error) => error.keyword)).toEqual([
      "unsupportedSchemaVersion",
    ]);
  });

  it("keeps the single-operation invariant and pins the target SceneSpec version", () => {
    const composite = migrationChangeSet();
    (composite.operations as unknown[]).push(structuredClone(migrationOperation(composite)));
    expect(validateSceneChangeSet(composite).ok).toBe(false);
    const wrongTarget = migrationChangeSet();
    (migrationOperation(wrongTarget).parameters as Json).targetSceneSpecVersion = "0.3.0";
    expect(validateSceneChangeSet(wrongTarget).ok).toBe(false);
  });

  it("still carries earlier deterministic operations under v0.4", () => {
    const camera = candidate("set-camera-r12.json", "rev_golden_0013", "rev_golden_0014");
    expect(validateSceneChangeSet(camera)).toMatchObject({ ok: true });
  });
});

describe("Technical Spike 9D: rev12 -> rev13 migration", () => {
  it("declares exactly the hand-authored canonical Golden requirement", () => {
    expect(migrationRequirements(migrationChangeSet())).toEqual([
      {
        id: goldenRequirementId,
        type: "same_space_route",
        spaceId: "space_living_main",
        evaluationPolicy: "circulation-policy-v0.1",
        start: { kind: "door_portal", openingId: "opening_d01" },
        end: { kind: "point", pointXY: [5000, 1500] },
      },
    ]);
  });

  it("produces the committed rev13 fixture and differs from rev12 only in version, identity, history, and requirements", () => {
    const base = rev12();
    const before = structuredClone(base);
    const planned = planSceneRevision(base, migrationChangeSet());
    expect(base).toEqual(before);
    expect(planned.targetSceneSpec).toEqual(rev13());
    const target = rev13();
    expect(validateSceneSpec(target)).toMatchObject({ ok: true });
    const { sceneSpecVersion, scene, revisions, circulationRequirements, ...rest } = target;
    const {
      sceneSpecVersion: baseVersion,
      scene: baseScene,
      revisions: baseRevisions,
      ...baseRest
    } = base;
    expect(rest).toEqual(baseRest);
    expect([baseVersion, sceneSpecVersion]).toEqual(["0.3.0", "0.4.0"]);
    expect(scene).toEqual({
      ...(baseScene as Json),
      revisionId: "rev_golden_0013",
      headRevisionId: "rev_golden_0013",
    });
    expect(revisions).toEqual([
      ...(baseRevisions as unknown[]),
      {
        revisionId: "rev_golden_0013",
        parentRevisionId: "rev_golden_0012",
        status: "committed",
        createdAt: "2026-09-27T06:00:00Z",
      },
    ]);
    expect(circulationRequirements).toEqual(migrationRequirements(migrationChangeSet()));
    expect(base).not.toHaveProperty("circulationRequirements");
  });

  it("builds a scene-scoped revision plan v0.4 bound to the exact requirement set", () => {
    const { plan } = planSceneRevision(rev12(), migrationChangeSet());
    const requirements = migrationRequirements(migrationChangeSet());
    expect(plan).toMatchObject({
      revisionPlanVersion: "0.4.0",
      changeSetId: "chg_migrate_circulation_contract_r13",
      projectId: "project_golden_living_001",
      sceneId: "scene_golden_living_001",
      baseRevisionId: "rev_golden_0012",
      targetRevisionId: "rev_golden_0013",
      operation: {
        operationId: "op_migrate_circulation_contract_r13",
        type: "MigrateCirculationRequirementContract",
        targetId: "scene_golden_living_001",
        targetSceneSpecVersion: "0.4.0",
        requirementCount: 1,
        requirementSetHash: semanticJsonHash(requirements),
        circulationRequirements: requirements,
      },
    });
    expect(plan.operation).toMatchObject({
      requirementSetHash: "sha256:44aa5d1a7814f83b1d46c11c0d46146fdf3804dbf63ad2ad68d02e8811890108",
    });
    expect(plan.expectedManagedLogicalIds).toHaveLength(14);
  });

  it("keeps revision plans v0.1/v0.2/v0.3 for earlier operations", () => {
    expect(
      planSceneRevision(golden("scene-spec.json"), golden("changesets/move-coffee-table-r2.json"))
        .plan.revisionPlanVersion,
    ).toBe("0.1.0");
    expect(
      planSceneRevision(
        golden("revisions/rev_golden_0010/scene-spec.json"),
        golden("changesets/migrate-material-appearance-r11.json"),
      ).plan.revisionPlanVersion,
    ).toBe("0.2.0");
    expect(
      planSceneRevision(
        golden("revisions/rev_golden_0011/scene-spec.json"),
        golden("changesets/set-camera-r12.json"),
      ).plan.revisionPlanVersion,
    ).toBe("0.3.0");
  });

  it("expects zero semantic node/camera change: 14 unchanged entries, revision metadata only", () => {
    const before = golden("revisions/rev_golden_0012/expected-scene-manifest.json");
    const after = golden("revisions/rev_golden_0013/expected-scene-manifest.json");
    const diff = diffSemanticManifests(before, after);
    expect(diff).toMatchObject({
      revision: { before: "rev_golden_0012", after: "rev_golden_0013" },
      changed: [],
      added: [],
      removed: [],
    });
    expect(diff.unchanged).toHaveLength(14);
    const { changeSet } = planSceneRevision(rev12(), migrationChangeSet());
    expect(() => assertRevisionDiff(diff, changeSet)).not.toThrow();
  });

  it("rejects every invalid migration before any DCC work", () => {
    const code = (base: Json, changeSet: Json) => planError(base, changeSet).code;
    const wrongScene = migrationChangeSet();
    migrationOperation(wrongScene).targetId = "scene_other_001";
    expect(code(rev12(), wrongScene)).toBe("TARGET_NOT_FOUND");

    const again = candidate(
      "migrate-circulation-requirement-contract-r13.json",
      "rev_golden_0013",
      "rev_golden_0014",
    );
    expect(code(rev13(), again)).toBe("CIRCULATION_REQUIREMENT_CONTRACT_ALREADY_CANONICAL");

    const fromV02 = candidate(
      "migrate-circulation-requirement-contract-r13.json",
      "rev_golden_0010",
      "rev_golden_0099_test_only",
    );
    expect(code(golden("revisions/rev_golden_0010/scene-spec.json"), fromV02)).toBe(
      "SCENE_SPEC_VERSION_TRANSITION_UNSUPPORTED",
    );

    const [requirement] = migrationRequirements(migrationChangeSet()) as [Json];
    const withRequirements = (requirements: Json[]) => {
      const changeSet = migrationChangeSet();
      (migrationOperation(changeSet).parameters as Json).circulationRequirements = requirements;
      return changeSet;
    };
    const second = {
      ...requirement,
      id: "circulation_req_zz_second_route",
      end: { kind: "point", pointXY: [5000, 1000] },
    };
    expect(code(rev12(), withRequirements([second, requirement]))).toBe(
      "CIRCULATION_REQUIREMENT_SET_UNSORTED",
    );
    expect(
      code(
        rev12(),
        withRequirements([
          requirement,
          { ...requirement, end: { kind: "point", pointXY: [5000, 1000] } },
        ]),
      ),
    ).toBe("CIRCULATION_REQUIREMENT_ID_DUPLICATE");
    expect(
      code(
        rev12(),
        withRequirements([
          { ...requirement, start: { kind: "door_portal", openingId: "opening_w01" } },
        ]),
      ),
    ).toBe("CIRCULATION_REQUIREMENT_REFERENCE_INVALID");
    expect(code(rev12(), withRequirements([{ ...requirement, spaceId: "space_missing" }]))).toBe(
      "CIRCULATION_REQUIREMENT_REFERENCE_INVALID",
    );

    // A migration may not introduce already-failing mandatory intent (end inside the sofa).
    expectGateFailure(
      rev12(),
      withRequirements([{ ...requirement, end: { kind: "point", pointXY: [3000, 3350] } }]),
      goldenRequirementId,
      "CIRCULATION_ENDPOINT_BLOCKED",
    );
  });

  it("keeps material appearance migration rejected on an already-canonical v0.4 base", () => {
    const migration = candidate(
      "migrate-material-appearance-r11.json",
      "rev_golden_0013",
      "rev_golden_0014",
      "0.2.0",
    );
    expect(planError(rev13(), migration).code).toBe("MATERIAL_APPEARANCE_ALREADY_CANONICAL");
  });
});

describe("Technical Spike 9D: Golden rev13 requirement evaluation", () => {
  it("satisfies the Golden requirement with the already-proven 9B route and an unchanged graph", () => {
    const evidence = circulationRequirementEvidence(rev13());
    expect(validateCirculationRequirementEvidence(evidence).ok).toBe(true);
    expect(evidence).toMatchObject({
      revisionId: "rev_golden_0013",
      sceneSpecVersion: "0.4.0",
      sceneSpecHash: semanticJsonHash(rev13()),
      requirementSetHash: "sha256:44aa5d1a7814f83b1d46c11c0d46146fdf3804dbf63ad2ad68d02e8811890108",
      status: "PASS",
    });
    // Requirements express intent; they do not change the routing geometry.
    expect(evidence.graphSemanticHash).toBe(circulationAnalysisEvidence(rev12()).graphSemanticHash);
    expect(evidence.graphSemanticHash).toBe(
      "sha256:eb8060e47781de4ed6659ba08dec07644d1fe4887508ceae2cdb5af886281895",
    );
    expect(evidence.requirements).toEqual([
      {
        requirementId: goldenRequirementId,
        spaceId: "space_living_main",
        startKind: "door_portal",
        endKind: "point",
        resolvedStartXY: [900, 1650],
        resolvedEndXY: [5000, 1500],
        status: "SATISFIED",
        startNodeId: "space_living_main::8::16",
        endNodeId: "space_living_main::49::14",
        distanceMm: 4182.842712,
        orthogonalStepCount: 39,
        diagonalStepCount: 2,
        failureCode: null,
        routeSemanticHash:
          "sha256:7b90bb36c727a9fb8061d4ea23805fd938cefdf35dc53a848068d1726fdc3860",
      },
    ]);
  });

  it("keeps rev1-rev12 byte-identical (LF-normalized content hashes) and adds no rev14", () => {
    const frozen: Record<string, string> = {
      "scene-spec.json": "sha256:f40a028bf054cdd01570c8497fa65f168908928c8e87dffb0af78d2df32868fc",
      rev_golden_0002: "sha256:f896bf0dd2e864eb96a51905fd176da95d009c6cc6e6a5728506e011e417e6a3",
      rev_golden_0003: "sha256:ed1819b4fcd3526864d13cf0fc8a250475fa2f1938e0e9eccf7d0188cd276684",
      rev_golden_0004: "sha256:c73af57daafc784c64556eef6a4119b1e3d48172e21e961366ebc41ec741db72",
      rev_golden_0005: "sha256:323765c5d3f9773f1ce2585760720fb2bce63dfdd1a5be56ee8d9dffb9d2a754",
      rev_golden_0006: "sha256:a38e298d339735e86f0fc7490e1943301d12b9dfe45aba0d55a6282c7415492b",
      rev_golden_0007: "sha256:c34d113352dea44ae81c3c6d3a47aa343df311e13ed401caa8bdcb2d3aa12565",
      rev_golden_0008: "sha256:045d4ebe73465f087003c0cc5d2d5654c4c29f278260a3eed6c0e7e5ec6b335f",
      rev_golden_0009: "sha256:ae639a0a6a7cf2b00f1a4cb292cc780173de82531bdbcd5e1c31716f4561f35c",
      rev_golden_0010: "sha256:b23326b70e4b6ce85ad471269d13f412a002d2acb72b153c6495b1a0b92a4965",
      rev_golden_0011: "sha256:626e8cf3aa3f7d38d99af5768c48410b0e196ee5b5fd3f351c7b9ccf2b50710c",
      rev_golden_0012: "sha256:622bbebc64e90bc3fbfb9ed2ce919ab5193dd02f0c771b6544913abd83216e9d",
    };
    for (const [key, hash] of Object.entries(frozen)) {
      const path =
        key === "scene-spec.json"
          ? resolve(goldenRoot, key)
          : resolve(goldenRoot, "revisions", key, "scene-spec.json");
      const content = readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
      expect(`sha256:${createHash("sha256").update(content).digest("hex")}`).toBe(hash);
    }
    expect(readdirSync(resolve(goldenRoot, "revisions")).sort().at(-1)).toBe("rev_golden_0013");
    expect(existsSync(resolve(goldenRoot, "revisions/rev_golden_0014"))).toBe(false);
  });
});

describe("Technical Spike 9D: v0.4 target-state requirement gate", () => {
  it("keeps the dedicated enforcement fixture valid and satisfied", () => {
    expect(validateSceneSpec(enforcementScene())).toMatchObject({ ok: true });
    expect(circulationRequirementEvidence(enforcementScene()).status).toBe("PASS");
  });

  it("blocks a 9A-valid MoveObject that disconnects a required route (CIRCULATION_NO_ROUTE)", () => {
    expectGateFailure(
      enforcementScene(),
      moveCabinet([3000, 2000, 0]),
      "circulation_req_entry_through_gap",
      "CIRCULATION_NO_ROUTE",
    );
  });

  it("blocks a 9A-valid MoveObject that crowds a canonical point endpoint (CIRCULATION_ENDPOINT_BLOCKED)", () => {
    expectGateFailure(
      enforcementScene(),
      moveCabinet([5450, 2000, 0]),
      "circulation_req_entry_through_gap",
      "CIRCULATION_ENDPOINT_BLOCKED",
    );
  });

  it("blocks furniture flush against a required door clearance (CIRCULATION_PORTAL_BLOCKED)", () => {
    expectGateFailure(
      enforcementScene(),
      moveCabinet([1100, 2000, 0]),
      "circulation_req_entry_through_gap",
      "CIRCULATION_PORTAL_BLOCKED",
    );
  });

  it("does not fail a revision because an unrelated, unreferenced door portal is blocked", () => {
    const planned = planSceneRevision(enforcementScene(), moveCabinet([4950, 1100, 0], 90));
    const evidence = circulationAnalysisEvidence(planned.targetSceneSpec);
    expect(evidence.violations).toEqual([
      expect.objectContaining({
        code: "CIRCULATION_PORTAL_BLOCKED",
        openingId: "opening_door_south",
      }),
    ]);
    expect(circulationRequirementEvidence(planned.targetSceneSpec).status).toBe("PASS");
  });

  it("still plans a valid v0.4 MoveObject that preserves every requirement", () => {
    const planned = planSceneRevision(enforcementScene(), moveCabinet([1500, 1000, 0]));
    expect(planned.plan.operation.type).toBe("MoveObject");
    expect(planned.targetSceneSpec.sceneSpecVersion).toBe("0.4.0");
  });

  it("keeps 9A placement errors ahead of the circulation gate", () => {
    expect(planError(enforcementScene(), moveCabinet([3000, 1000, 0])).code).toBe(
      "SPATIAL_ASSET_COLLISION",
    );
  });

  it("enforces on target state for UpdateOpening, not just asset operations", () => {
    const narrowDoor = candidate(
      "update-window-sill-r3.json",
      "rev_golden_0013",
      "rev_golden_0014",
    );
    const operation = migrationOperation(narrowDoor);
    operation.targetId = "opening_d01";
    operation.parameters = { offset: 2400, width: 250, sill: 0, height: 2100 };
    expectGateFailure(rev13(), narrowDoor, goldenRequirementId, "CIRCULATION_PORTAL_BLOCKED");

    const window = candidate("update-window-sill-r3.json", "rev_golden_0013", "rev_golden_0014");
    (migrationOperation(window).parameters as Json).sill = 950;
    expect(planSceneRevision(rev13(), window).targetSceneSpec.sceneSpecVersion).toBe("0.4.0");
  });

  it("lets an unrelated v0.4 operation (SetCamera) plan normally", () => {
    const camera = candidate("set-camera-r12.json", "rev_golden_0013", "rev_golden_0014");
    const operation = migrationOperation(camera);
    const cameraB = (rev13().cameras as Json[]).find(
      (entry) => entry.id === "camera_living_b",
    ) as Json;
    operation.targetId = "camera_living_b";
    operation.parameters = {
      position: (cameraB.transform as Json).position,
      target: cameraB.target,
      orientationPolicy: "look_at_target",
      focalLengthMm: 28,
      sensorWidthMm: 36,
    };
    expect(planSceneRevision(rev13(), camera).plan.revisionPlanVersion).toBe("0.3.0");
  });

  it("gates the same Golden MoveObject on v0.4 but never on historical v0.3", () => {
    const onV03 = moveCoffeeTable(
      "rev_golden_0012",
      "rev_golden_0099_test_only",
      [5000, 2000, 0],
      "0.3.0",
    );
    expect(planSceneRevision(rev12(), onV03).targetSceneSpec.sceneSpecVersion).toBe("0.3.0");
    const onV04 = moveCoffeeTable("rev_golden_0013", "rev_golden_0014", [5000, 2000, 0]);
    expectGateFailure(rev13(), onV04, goldenRequirementId, "CIRCULATION_ENDPOINT_BLOCKED");
  });

  it("rejects a breaking candidate through applySceneChangeSet with zero DCC discovery or process", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-9d-zero-dcc-"));
    try {
      const fixtureCopy = join(root, "tests/fixtures/living-room-golden");
      cpSync(goldenRoot, fixtureCopy, { recursive: true });
      const changeSetPath = join(
        fixtureCopy,
        "changesets",
        "move-table-onto-required-endpoint-r14.json",
      );
      writeFileSync(
        changeSetPath,
        JSON.stringify(moveCoffeeTable("rev_golden_0013", "rev_golden_0014", [5000, 2000, 0])),
      );
      const result = await applySceneChangeSet(
        {
          repositoryRoot: root,
          workspaceRoot: join(root, ".workspace"),
          processTimeoutMs: 5_000,
          threeDsMaxInstallationPath: join(root, "no-3ds-max-here"),
          allowCompatibilityVersionForSpike: true,
          allowDccExecution: true,
          trustedAssetRoot: null,
        },
        join(fixtureCopy, "job-envelope.json"),
        changeSetPath,
        { authorizeDccExecution: true },
      );
      expect(result).toMatchObject({
        status: "BLOCKED",
        error: { code: "CIRCULATION_REQUIREMENT_UNSATISFIED" },
        dcc: null,
        workspace: null,
        mutationProcess: null,
        verificationProcess: null,
        renderStateVerificationProcess: null,
        materialStateVerificationProcess: null,
        cameraStateVerificationProcess: null,
        verifiedOutputPath: null,
      });
      expect(existsSync(join(root, ".workspace"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Technical Spike 9D: external ReplaceAsset cannot bypass the gate", () => {
  const artifactId = "artifact_controlled_wide_sofa_v1";
  const artifactSha256 = `sha256:${"b".repeat(64)}`;
  const catalog = (dimensions: number[]): TrustedExternalAssetCatalog => ({
    catalogVersion: "0.1.0",
    definitions: [
      {
        id: "assetdef_sofa_external_wide_v1",
        version: "1",
        category: "sofa",
        sourceType: "external_max",
        artifactId,
        dimensions: dimensions as [number, number, number],
        pivotPolicy: "floor_center",
        allowNonUniformScale: false,
      },
    ],
  });
  const registry = (dimensions: number[]): AssetArtifactRegistry => ({
    records: [
      {
        artifact: {
          artifactContractVersion: "0.1.0",
          artifactId,
          format: "3ds_max",
          sha256: artifactSha256,
          byteLength: 1024,
          trustState: "VERIFIED",
          source: { kind: "internal", referenceId: "source_controlled_wide_sofa_fixture_v1" },
        },
        storageKey: "objects/external/controlled-wide-sofa.max",
        inspection: {
          inspectionVersion: "0.1.0",
          artifactId,
          artifactSha256,
          inspector: { type: "trusted_3ds_max_asset_inspector", version: "0.1.0" },
          dcc: { product: "3ds_max", testedMajorVersion: 2025, compatibilityMode: true },
          result: "pass",
          findings: [],
          observations: {
            scene: { nodeCount: 1, geometryNodeCount: 1, cameraCount: 0, lightCount: 0 },
            geometry: {
              worldBoundingBoxMm: [0, 0, 0, ...dimensions],
              dimensionsMm: dimensions,
              pivotPositionMm: [(dimensions[0] as number) / 2, (dimensions[1] as number) / 2, 0],
              floorCenterAnchorCompatible: true,
            },
            units: {
              systemType: "#Millimeters",
              systemScale: 1,
              displayType: "#Millimeters",
              normalization: "millimeters",
              useFileUnits: true,
            },
            materials: { materialCount: 1, classNames: ["standardmaterial"] },
            dependencies: {
              missingExternalFiles: 0,
              missingDLLs: 0,
              xrefs: 0,
              externalReferenceCount: 0,
            },
            security: {
              safeSceneScriptExecutionEnabled: true,
              settingsLocked: true,
              lockCause: "cmdline",
              scriptAssetsProtected: true,
            },
          },
        },
      },
    ],
  });
  const changeSet = (): Json => ({
    schemaVersion: "0.1.0",
    changeSetId: "chg_external_wide_sofa_r14",
    projectId: "project_golden_living_001",
    sceneId: "scene_golden_living_001",
    baseRevisionId: "rev_golden_0013",
    targetRevisionId: "rev_external_0014",
    requestedBy: { type: "operator", id: "operator_golden_fixture" },
    source: { type: "manual_edit", referenceIds: ["source_golden_fixture"] },
    intent: "Candidate external sofa replacement on a v0.4 base.",
    riskLevel: "medium",
    operations: [
      {
        operationId: "op_external_wide_sofa_r14",
        type: "ReplaceAsset",
        targetId: "asset_living_sofa_main",
        reason: "Controlled external sofa ingestion.",
        riskLevel: "medium",
        parameters: {
          newAssetDefinitionId: "assetdef_sofa_external_wide_v1",
          placementPolicy: "preserve_anchor",
        },
        preconditions: [],
        provenance: [],
        expectedImpact: { affectedLogicalIds: ["asset_living_sofa_main"] },
      },
    ],
    preconditions: [],
    metadata: { createdAt: "2026-09-27T02:00:00Z" },
  });
  /** rev13 plus a candidate requirement to the clear bay east of the sofa (test input, not Golden intent). */
  function v04BaseWithSofaBayRequirement(): Json {
    const scene = rev13();
    scene.circulationRequirements = [
      {
        id: "circulation_req_east_sofa_bay",
        type: "same_space_route",
        spaceId: "space_living_main",
        evaluationPolicy: "circulation-policy-v0.1",
        start: { kind: "point", pointXY: [5000, 3350] },
        end: { kind: "point", pointXY: [5000, 1500] },
      },
      ...(scene.circulationRequirements as Json[]),
    ];
    return scene;
  }
  const manifest = () => golden("revisions/rev_golden_0013/expected-scene-manifest.json");
  const ingestionError = (action: () => unknown): string | null => {
    try {
      action();
      return null;
    } catch (error) {
      return error instanceof ExternalAssetIngestionError ? error.code : null;
    }
  };

  it("rejects a trusted, 9A-valid external replacement that breaks a canonical requirement", () => {
    const base = v04BaseWithSofaBayRequirement();
    expect(validateSceneSpec(base)).toMatchObject({ ok: true });
    expect(circulationRequirementEvidence(base).status).toBe("PASS");
    const wide = [3600, 900, 760];
    expect(
      ingestionError(() =>
        preflightExternalAssetIngestion({
          baseSceneSpec: base,
          baseManifest: manifest(),
          changeSet: changeSet(),
          catalog: catalog(wide),
          registry: registry(wide),
        }),
      ),
    ).toBe("CIRCULATION_REQUIREMENT_UNSATISFIED");
    const standard = [2200, 900, 760];
    const accepted = preflightExternalAssetIngestion({
      baseSceneSpec: base,
      baseManifest: manifest(),
      changeSet: changeSet(),
      catalog: catalog(standard),
      registry: registry(standard),
    });
    expect(accepted.targetSceneSpec.sceneSpecVersion).toBe("0.4.0");
  });

  it("returns BLOCKED with zero DCC discovery or process for that external candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-archviz-9d-external-"));
    try {
      const wide = [3600, 900, 760];
      const result = await ingestVerifiedExternalMaxAsset({
        config: {
          repositoryRoot: root,
          workspaceRoot: join(root, ".workspace"),
          processTimeoutMs: 5_000,
          threeDsMaxInstallationPath: join(root, "no-3ds-max-here"),
          allowCompatibilityVersionForSpike: true,
          allowDccExecution: true,
        },
        jobId: "job_external_9d_gate_0001",
        idempotencyKey: "external.9d.gate.0001",
        baseSceneSpec: v04BaseWithSofaBayRequirement(),
        baseManifest: manifest(),
        baseArtifactPath: join(root, "base.max"),
        changeSet: changeSet(),
        catalog: catalog(wide),
        registry: registry(wide),
        trustedAssetRoot: root,
        tolerances: {
          geometryToleranceMm: 0.01,
          transformToleranceMm: 0.01,
          rotationToleranceDeg: 0.001,
        },
        authorizeDccExecution: true,
      });
      expect(result).toMatchObject({
        status: "BLOCKED",
        error: { code: "CIRCULATION_REQUIREMENT_UNSATISFIED" },
        dcc: null,
        mutationProcess: null,
        verificationProcess: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Technical Spike 9D: versioned preservation evidence", () => {
  it("keeps material-state v0.1 for SceneSpec v0.3 and uses v0.2 (same physical fields) for v0.4", () => {
    const v01 = canonicalMaterialStateExpectation(rev12()) as Json;
    const v02 = canonicalMaterialStateExpectation(rev13()) as Json;
    expect(v01).toMatchObject({ materialStateVersion: "0.1.0", sceneSpecVersion: "0.3.0" });
    expect(v02).toMatchObject({ materialStateVersion: "0.2.0", sceneSpecVersion: "0.4.0" });
    expect(validateCanonicalMaterialStateEvidence(v01).ok).toBe(true);
    expect(validateCanonicalMaterialStateEvidence(v02).ok).toBe(false);
    expect(validateCanonicalMaterialStateEvidenceV02(v02).ok).toBe(true);
    expect(validateCanonicalMaterialStateEvidenceV02(v01).ok).toBe(false);
    const physical = ({ materialStateVersion, sceneSpecVersion, revisionId, ...rest }: Json) =>
      rest;
    expect(physical(v02)).toEqual(physical(v01));
    const schemaV01 = canonicalMaterialStateSchema as { properties: Json };
    const schemaV02 = canonicalMaterialStateV02Schema as { properties: Json };
    expect(schemaV01.properties.materialStateVersion).toEqual({ const: "0.1.0" });
    expect(schemaV01.properties.sceneSpecVersion).toEqual({ const: "0.3.0" });
    const { materialStateVersion: _a, sceneSpecVersion: _b, ...fieldsV01 } = schemaV01.properties;
    const { materialStateVersion: _c, sceneSpecVersion: _d, ...fieldsV02 } = schemaV02.properties;
    expect(fieldsV02).toEqual(fieldsV01);
  });

  it("keeps camera-state v0.1 through SceneSpec v0.3 and uses v0.2 for v0.4", () => {
    const v01 = canonicalCameraStateExpectation(rev12()) as Json;
    const v02 = canonicalCameraStateExpectation(rev13()) as Json;
    expect(v01).toMatchObject({ cameraStateVersion: "0.1.0", sceneSpecVersion: "0.3.0" });
    expect(v02).toMatchObject({ cameraStateVersion: "0.2.0", sceneSpecVersion: "0.4.0" });
    expect(validateCanonicalCameraStateEvidence(v01).ok).toBe(true);
    expect(validateCanonicalCameraStateEvidence(v02).ok).toBe(false);
    expect(validateCanonicalCameraStateEvidenceV02(v02).ok).toBe(true);
    expect(validateCanonicalCameraStateEvidenceV02(v01).ok).toBe(false);
    expect(v02.cameras).toEqual(v01.cameras);
    const schemaV01 = canonicalCameraStateSchema as { properties: Json };
    const schemaV02 = canonicalCameraStateV02Schema as { properties: Json };
    expect(schemaV01.properties.sceneSpecVersion).toEqual({ enum: ["0.1.0", "0.2.0", "0.3.0"] });
    const { cameraStateVersion: _a, sceneSpecVersion: _b, ...fieldsV01 } = schemaV01.properties;
    const { cameraStateVersion: _c, sceneSpecVersion: _d, ...fieldsV02 } = schemaV02.properties;
    expect(fieldsV02).toEqual(fieldsV01);
  });

  it("reuses render-state v0.1 unchanged for rev13", () => {
    const before = canonicalRenderStateExpectation(rev12()) as Json;
    const after = canonicalRenderStateExpectation(rev13()) as Json;
    expect(validateCanonicalRenderStateEvidence(after).ok).toBe(true);
    expect(after).toEqual({ ...before, revisionId: "rev_golden_0013" });
    expect(after.renderStateVersion).toBe("0.1.0");
  });

  it("blocks promotion on invalid, FAILED, or mismatched circulation evidence", () => {
    const expected = circulationRequirementEvidence(rev13());
    expect(circulationEvidencePromotionFailure(structuredClone(expected), expected)).toBeNull();
    expect(
      circulationEvidencePromotionFailure({ ...expected, requirementSetHash: "invalid" }, expected)
        ?.code,
    ).toBe("CIRCULATION_REQUIREMENT_EVIDENCE_INVALID");
    expect(
      circulationEvidencePromotionFailure({ ...expected, status: "FAILED" }, expected)?.code,
    ).toBe("CIRCULATION_REQUIREMENT_EVIDENCE_FAILED");
    expect(
      circulationEvidencePromotionFailure(
        { ...expected, graphSemanticHash: `sha256:${"0".repeat(64)}` },
        expected,
      )?.code,
    ).toBe("CIRCULATION_REQUIREMENT_EVIDENCE_MISMATCH");
  });
});
