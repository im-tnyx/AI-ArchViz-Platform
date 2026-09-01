import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCanonicalCoronaPreviewEvidenceV03 } from "@ai-archviz/worker-contracts";
import {
  type CanonicalGoldenCoronaPreviewRev12ExecutionConfig,
  executeCanonicalGoldenCoronaPreviewRev12,
} from "./canonical-golden-corona-preview-rev12-execution.js";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { resolveWithinRoot } from "./paths.js";

interface Invocation {
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

interface EvidenceView {
  sceneSpecHash: string;
  sceneSpecVersion: string;
  revisionId: string;
  canonicalArtifactHash: string;
  stagedArtifactHash: string;
  requestHash: string;
  renderer: { engine: string; className: string };
  dcc: { version: string; compatibilityMode: boolean };
  canonicalLights: Array<Record<string, unknown>>;
  materials: Array<Record<string, unknown>>;
  materialAssignments: Array<Record<string, unknown>>;
  deduplication: { sameIdSharedInstance: boolean; differentIdDistinctInstances: boolean };
  camera: {
    logicalId: string;
    className: string;
    canonicalPosition: number[];
    observedPosition: number[];
    canonicalTarget: number[];
    observedTarget: number[];
    canonicalRotationEuler: number[];
    observedRotationEuler: number[];
    focalLengthMm: number;
    sensorWidthMm: number;
    expectedFovRadians: number;
    expectedFovDegrees: number;
    observedFovRadians: number;
    observedFovDegrees: number;
    lookAtTarget: boolean;
  };
  render: { resolution: { width: number; height: number } };
  output: { format: string; byteLength: number; sha256: string };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(
  repositoryRoot,
  ".workspace/canonical-golden-corona-preview-rev12-8j",
);
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "worker.config.json");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const fixtureRoot = resolve(repositoryRoot, "tests/fixtures/living-room-golden");
const baseJobPath = resolve(fixtureRoot, "job-envelope.json");
const rev12ScenePath = resolve(fixtureRoot, "revisions/rev_golden_0012/scene-spec.json");
const rev12ManifestPath = resolve(
  fixtureRoot,
  "revisions/rev_golden_0012/expected-scene-manifest.json",
);
const renderJobPath = resolve(fixtureRoot, "render-job-v0.2-camera-living-a.json");
const existingChangeSets = [
  "move-coffee-table-r2.json",
  "update-window-sill-r3.json",
  "assign-wall-south-material-r4.json",
  "lock-coffee-table-transform-r5.json",
  "unlock-coffee-table-transform-r6.json",
  "move-coffee-table-after-unlock-r7.json",
  "replace-sofa-r8.json",
  "set-render-intent-r9.json",
  "add-key-area-light-r10.json",
  "migrate-material-appearance-r11.json",
  "set-camera-r12.json",
].map((name) => resolve(fixtureRoot, "changesets", name));
const r12ChangeSetPath = existingChangeSets[existingChangeSets.length - 1] as string;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function rawHash(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function invoke(command: string[], revisionJobId?: string): Promise<Invocation> {
  return new Promise((resolveInvocation, reject) => {
    const child = spawn(process.execPath, [cliPath, ...command], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        AI_ARCHVIZ_WORKER_CONFIG: configPath,
        ...(revisionJobId ? { AI_ARCHVIZ_REVISION_JOB_ID: revisionJobId } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      try {
        resolveInvocation({
          exitCode,
          result: JSON.parse(stdout) as Record<string, unknown>,
          stderr,
        });
      } catch (error) {
        reject(
          new Error(
            `Canonical preview child returned invalid JSON: ${String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function previewConfig(timeoutMs = 180_000): CanonicalGoldenCoronaPreviewRev12ExecutionConfig {
  return {
    repositoryRoot,
    workspaceRoot: resolve(runRoot, "render-workspaces"),
    processTimeoutMs: timeoutMs,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: true,
  };
}

async function expectPreviewFailure(
  code: string,
  input: {
    sceneSpec: Record<string, unknown>;
    renderJob: Record<string, unknown>;
    expectedManifest: Record<string, unknown>;
    verifiedArtifactPath: string;
  },
  environment: NodeJS.ProcessEnv,
  timeoutMs = 180_000,
): Promise<void> {
  const result = await executeCanonicalGoldenCoronaPreviewRev12({
    config: previewConfig(timeoutMs),
    ...input,
    authorizeDccExecution: true,
    executionEnvironment: { ...process.env, ...environment },
  });
  assert.equal(result.status, "FAILED", JSON.stringify(result));
  assert.equal(result.error?.code, code, JSON.stringify(result));
  assert.equal(result.evidence, null);
}

async function main(): Promise<void> {
  requireDccTestApproval();
  if (existsSync(runRoot)) rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(runRoot, { recursive: true });
  writeJson(configPath, {
    workspaceRoot: relative(repositoryRoot, workspaceRoot).replaceAll("\\", "/"),
    processTimeoutMs: 180_000,
    allowCompatibilityVersionForSpike: true,
    allowDccExecution: true,
  });
  try {
    // Build canonical rev12 through the real revision pipeline (base + r2..r12),
    // not a fabricated .max: base -> ... -> r11 MigrateMaterialAppearanceContract
    // -> r12 SetCamera (Spike 8I).
    let latest = await invoke(["build-scene", baseJobPath]);
    assert.equal(latest.exitCode, 0, latest.stderr);
    assert.equal(latest.result.status, "SUCCESS");
    for (const [index, changeSetPath] of existingChangeSets.entries()) {
      latest = await invoke(
        ["apply-change-set", baseJobPath, changeSetPath],
        `job_canonical_golden_preview_rev12_r${index + 2}`,
      );
      assert.equal(latest.exitCode, 0, `${latest.stderr}\n${JSON.stringify(latest.result)}`);
      assert.equal(latest.result.status, "SUCCESS", JSON.stringify(latest.result));
    }
    assert.equal(
      (latest.result.report as Record<string, unknown> | null)?.revisionId,
      "rev_golden_0012",
    );
    assert.equal(typeof latest.result.verifiedOutputPath, "string");
    const verifiedArtifactPath = latest.result.verifiedOutputPath as string;
    const canonicalHashBefore = rawHash(verifiedArtifactPath);

    const sceneSpec = readJson(rev12ScenePath);
    const expectedManifest = readJson(rev12ManifestPath);
    const renderJob = readJson(renderJobPath);
    const input = { sceneSpec, renderJob, expectedManifest, verifiedArtifactPath };

    const blocked = await executeCanonicalGoldenCoronaPreviewRev12({
      config: previewConfig(),
      ...input,
      authorizeDccExecution: false,
    });
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.error?.code, "DCC_EXECUTION_DISABLED");
    assert.equal(blocked.process, null);

    const preview = await executeCanonicalGoldenCoronaPreviewRev12({
      config: previewConfig(),
      ...input,
      authorizeDccExecution: true,
    });
    assert.equal(preview.status, "PASS", JSON.stringify(preview));

    // The v0.2 material-aware compiler only: no legacy plan-v0.1 fields, and
    // the 28mm lens (never the historical 24mm value).
    assert.ok(preview.plan, "plan is required");
    assert.equal(preview.plan?.planVersion, "0.2.0");
    assert.equal(
      Object.hasOwn((preview.plan as { adapterDefaults: object }).adapterDefaults, "material"),
      false,
    );
    assert.equal(preview.plan?.revisionId, "rev_golden_0012");
    assert.equal(preview.plan?.camera.logicalId, "camera_living_a");
    assert.equal(preview.plan?.camera.focalLengthMm, 28);
    assert.equal(preview.plan?.camera.sensorWidthMm, 36);
    assert.ok(Math.abs((preview.plan?.camera.fovRadians as number) - 1.1426749596672536) < 1e-9);
    assert.equal(JSON.stringify(preview.plan?.camera).includes('"focalLengthMm":24'), false);
    assert.deepEqual(preview.plan?.lights, [
      {
        logicalId: "light_living_key_area",
        type: "area",
        position: [3000, 1600, 2800],
        rotationEuler: [-35, 0, 0],
        canonicalIntensity: 1.25,
        mappedIntensity: 150,
        widthMm: 800,
      },
    ]);
    const materialsById = new Map(
      (preview.plan?.materials ?? []).map((material) => [material.materialId, material]),
    );
    assert.deepEqual(materialsById.get("material_wall_neutral"), {
      materialId: "material_wall_neutral",
      baseColorRgb: [0.78, 0.74, 0.68],
      roughness: 0.62,
      metalness: 0,
    });
    assert.deepEqual(materialsById.get("material_floor_neutral"), {
      materialId: "material_floor_neutral",
      baseColorRgb: [0.66, 0.64, 0.6],
      roughness: 0.34,
      metalness: 0,
    });
    assert.deepEqual(materialsById.get("material_sofa_proxy"), {
      materialId: "material_sofa_proxy",
      baseColorRgb: [0.72, 0.62, 0.5],
      roughness: 0.78,
      metalness: 0,
    });

    assert.equal(preview.materialDeduplicationVerified, true);
    assert.equal(validateCanonicalCoronaPreviewEvidenceV03(preview.evidence).ok, true);
    const evidence = preview.evidence as unknown as EvidenceView;
    assert.equal(evidence.revisionId, "rev_golden_0012");
    assert.equal(evidence.sceneSpecVersion, "0.3.0");
    assert.equal(evidence.canonicalArtifactHash, canonicalHashBefore);
    assert.equal(evidence.stagedArtifactHash, canonicalHashBefore);
    assert.equal(evidence.requestHash, preview.requestHash);
    assert.equal(evidence.renderer.engine, "corona");
    assert.equal(evidence.canonicalLights.length, 1);
    assert.deepEqual(evidence.canonicalLights[0], {
      logicalId: "light_living_key_area",
      type: "area",
      actualClass: "CoronaLight",
      position: [3000, 1600, 2800],
      rotationEuler: [-35, 0, 0],
      canonicalIntensity: 1.25,
      mappedIntensity: 150,
      widthMm: 800,
    });
    assert.equal(evidence.materials.length, 3);
    for (const material of evidence.materials) {
      assert.equal(material.actualClass, "_CoronaPhysicalMtl");
      assert.match(material.materialInstanceName as string, /^AVZ_MATERIAL_material_/u);
      assert.equal(JSON.stringify(material).includes("AVZ_CORONA_"), false);
    }
    assert.equal(evidence.materialAssignments.length, 6);
    assert.equal(evidence.deduplication.sameIdSharedInstance, true);
    assert.equal(evidence.deduplication.differentIdDistinctInstances, true);

    // Camera evidence: 28mm, canonical rotation matches the post-8I
    // normalized value, no camera write occurred (observation-only reuse).
    assert.equal(evidence.camera.logicalId, "camera_living_a");
    assert.equal(evidence.camera.className, "Freecamera");
    assert.equal(evidence.camera.focalLengthMm, 28);
    assert.equal(evidence.camera.sensorWidthMm, 36);
    assert.deepEqual(evidence.camera.canonicalPosition, [1200, 3800, 1500]);
    assert.deepEqual(evidence.camera.observedPosition, [1200, 3800, 1500]);
    assert.deepEqual(evidence.camera.canonicalTarget, [3000, 200, 1300]);
    assert.deepEqual(evidence.camera.observedTarget, [3000, 200, 1300]);
    assert.deepEqual(evidence.camera.canonicalRotationEuler, [-2.84471, 0, 206.565051]);
    assert.deepEqual(evidence.camera.observedRotationEuler, [-2.84471, 0, 206.565051]);
    assert.ok(Math.abs(evidence.camera.expectedFovRadians - 1.1426749596672536) < 1e-9);
    assert.ok(Math.abs(evidence.camera.expectedFovDegrees - 65.4704525442152) < 1e-6);
    assert.ok(Math.abs(evidence.camera.observedFovRadians - 1.1426749596672536) < 1e-9);
    assert.ok(Math.abs(evidence.camera.observedFovDegrees - 65.4704525442152) < 1e-6);
    assert.equal(evidence.camera.lookAtTarget, true);

    assert.equal(evidence.render.resolution.width, 320);
    assert.equal(evidence.render.resolution.height, 240);
    assert.equal(evidence.output.format, "png");
    assert.ok(evidence.output.byteLength > 0);
    assert.match(evidence.output.sha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(JSON.stringify(evidence).includes(repositoryRoot), false);
    assert.equal(JSON.stringify(evidence).includes(runRoot), false);

    // Artifact and revision immutability: no save, no rev13.
    assert.equal(rawHash(verifiedArtifactPath), canonicalHashBefore);
    assert.deepEqual(readJson(rev12ScenePath), sceneSpec);
    const replay = await invoke(
      ["apply-change-set", baseJobPath, r12ChangeSetPath],
      "job_canonical_golden_preview_rev12_r12_replay",
    );
    assert.equal(replay.exitCode, 0, replay.stderr);
    assert.equal(replay.result.replayed, true);
    assert.equal(
      (replay.result.report as Record<string, unknown> | null)?.revisionId,
      "rev_golden_0012",
    );
    assert.equal(rawHash(verifiedArtifactPath), canonicalHashBefore);

    // Failure safety: every case must fail closed with no PASS evidence and
    // no owned render process left over the canonical/staged inputs.
    await expectPreviewFailure("RENDER_SOURCE_ARTIFACT_HASH_MISMATCH", input, {
      AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV12_FAILURE: "staged_hash_tamper",
    });
    await expectPreviewFailure("RENDER_SOURCE_MANIFEST_MISMATCH", input, {
      AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH: "1",
    });
    await expectPreviewFailure("SAFE_SCENE_REQUIRED", input, {
      AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV12_FAILURE: "safe_scene",
    });
    await expectPreviewFailure("CORONA_NOT_FOUND", input, {
      AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE: "corona_missing",
    });
    await expectPreviewFailure("CORONA_LIGHT_CLASS_NOT_FOUND", input, {
      AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE: "light_missing",
    });
    await expectPreviewFailure("DUPLICATE_LOGICAL_LIGHT", input, {
      AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE: "duplicate_logical_light",
    });
    await expectPreviewFailure("LIGHT_PHYSICAL_PROPERTY_MISMATCH", input, {
      AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE: "light_physical_mismatch",
    });
    await expectPreviewFailure("MATERIAL_NOT_FOUND", input, {
      AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "material_missing",
    });
    await expectPreviewFailure("CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED", input, {
      AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "roughness_property_missing",
    });
    await expectPreviewFailure("CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED", input, {
      AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "metalness_property_missing",
    });
    await expectPreviewFailure("CORONA_MATERIAL_ASSIGNMENT_FAILED", input, {
      AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE: "dedup_failure",
    });
    // Camera-state layer: reuses Spike 8I's own verify_canonical_camera_state
    // forced-failure hooks, including the mandatory degrees-as-radians
    // regression proof.
    await expectPreviewFailure("CAMERA_NOT_FOUND", input, {
      AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: "camera_missing",
    });
    await expectPreviewFailure("CAMERA_NOT_FOUND", input, {
      AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: "camera_wrong_class",
    });
    await expectPreviewFailure("CAMERA_FOV_MISMATCH", input, {
      AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: "fov_regression",
    });
    await expectPreviewFailure("CAMERA_ORIENTATION_MISMATCH", input, {
      AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: "orientation_mismatch",
    });
    await expectPreviewFailure("CAMERA_TARGET_MISMATCH", input, {
      AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: "target_mismatch",
    });
    await expectPreviewFailure("CAMERA_REALIZATION_FAILED", input, {
      AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE: "invalid_evidence",
    });
    await expectPreviewFailure("UNEXPECTED_DIAGNOSTIC_LIGHT", input, {
      AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV12_FAILURE: "diagnostic_light",
    });
    await expectPreviewFailure("CAMERA_ID_AMBIGUOUS", input, {
      AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV12_FAILURE: "camera_duplicate",
    });
    await expectPreviewFailure("CORONA_NOT_FOUND", input, {
      AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV12_FAILURE: "renderer_missing",
    });
    await expectPreviewFailure("RENDER_OUTPUT_INVALID", input, {
      AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV12_FAILURE: "png_invalid",
    });
    await expectPreviewFailure(
      "PROCESS_TIMEOUT",
      input,
      { AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV12_FAILURE: "timeout" },
      1,
    );

    assert.equal(rawHash(verifiedArtifactPath), canonicalHashBefore);
    assert.deepEqual(readJson(rev12ScenePath), sceneSpec);

    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 8J Canonical Golden Corona Preview from rev12 Camera State",
          status: "PASS",
          targetDccVersion: "2026",
          testedDccVersion: evidence.dcc.version,
          compatibilityMode: preview.compatibilityMode,
          canonicalArtifactHash: canonicalHashBefore,
          requestHash: preview.requestHash,
          results: {
            source: "verified Golden rev12 artifact (real r2..r12 pipeline) + full manifest PASS",
            preview:
              "canonical Corona render-state + material-state + camera-state consumed by the v0.2 adapter PASS",
            light: "persisted light_living_key_area CoronaLight reused, not recreated",
            materials: "persisted AVZ_MATERIAL_* Corona Physical Materials reused, none created",
            materialDeduplication: preview.materialDeduplicationVerified,
            camera: "persisted 28mm camera_living_a observed, not mutated",
            preservation:
              "canonical/staged rev12 hashes unchanged; no rev13 created; r12 replay unaffected",
            failures:
              "hash, manifest, render-state, material-state, camera-state (incl. FOV regression), diagnostic-light, camera, renderer, Safe Scene, PNG, timeout failures closed",
          },
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
