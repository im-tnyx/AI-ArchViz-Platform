import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGoldenCoronaPreviewEvidence } from "@ai-archviz/worker-contracts";
import { requireDccTestApproval } from "./dcc-test-guard.js";
import { executeGoldenCoronaPreview } from "./golden-corona-preview-execution.js";
import { resolveWithinRoot } from "./paths.js";

interface Invocation {
  exitCode: number | null;
  result: Record<string, unknown>;
  stderr: string;
}

interface PreviewEvidenceView {
  source: { artifactHash: string; stagedArtifactHash: string };
  dcc: { version: string };
  canonical: { managedNodeCount: number };
  temporaryExecution: { light: { nonCanonical: boolean; className: string } };
  render: { resolution: { width: number; height: number } };
  output: { format: string };
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runRoot = resolveWithinRoot(repositoryRoot, ".workspace/golden-corona-preview-8c");
const workspaceRoot = resolve(runRoot, "workspaces");
const configPath = resolve(runRoot, "worker.config.json");
const cliPath = resolve(repositoryRoot, "apps/worker/dist/cli.js");
const baseJobPath = resolve(repositoryRoot, "tests/fixtures/living-room-golden/job-envelope.json");
const rev8ScenePath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/revisions/rev_golden_0008/scene-spec.json",
);
const rev8ManifestPath = resolve(
  repositoryRoot,
  "tests/fixtures/living-room-golden/revisions/rev_golden_0008/expected-scene-manifest.json",
);
const changeSets = [
  "move-coffee-table-r2.json",
  "update-window-sill-r3.json",
  "assign-wall-south-material-r4.json",
  "lock-coffee-table-transform-r5.json",
  "unlock-coffee-table-transform-r6.json",
  "move-coffee-table-after-unlock-r7.json",
  "replace-sofa-r8.json",
].map((name) => resolve(repositoryRoot, "tests/fixtures/living-room-golden/changesets", name));

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
            `Golden revision child returned invalid JSON: ${String(error)}\n${stdout}\n${stderr}`,
          ),
        );
      }
    });
  });
}

function previewConfig(timeoutMs = 180_000) {
  return {
    repositoryRoot,
    workspaceRoot: resolve(runRoot, "render-workspaces"),
    processTimeoutMs: timeoutMs,
    threeDsMaxInstallationPath: null,
    allowCompatibilityVersionForSpike: true,
  };
}

async function expectPreviewFailure(
  code: string,
  input: {
    sceneSpec: Record<string, unknown>;
    expectedManifest: Record<string, unknown>;
    verifiedArtifactPath: string;
  },
  failure: string,
  timeoutMs = 180_000,
): Promise<void> {
  const result = await executeGoldenCoronaPreview({
    config: previewConfig(timeoutMs),
    ...input,
    authorizeDccExecution: true,
    executionEnvironment: {
      ...process.env,
      AI_ARCHVIZ_TEST_FORCE_GOLDEN_CORONA_PREVIEW_FAILURE: failure,
    },
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
    const rev1 = await invoke(["build-scene", baseJobPath]);
    assert.equal(rev1.exitCode, 0);
    assert.equal(rev1.result.status, "SUCCESS");
    let latest = rev1;
    for (const [index, changeSet] of changeSets.entries()) {
      latest = await invoke(
        ["apply-change-set", baseJobPath, changeSet],
        `job_golden_corona_preview_r${index + 2}`,
      );
      assert.equal(latest.exitCode, 0, latest.stderr);
      assert.equal(latest.result.status, "SUCCESS", JSON.stringify(latest.result));
    }
    assert.equal(latest.result.replayed, false);
    assert.equal(typeof latest.result.workspace, "string");
    assert.equal(typeof latest.result.verifiedOutputPath, "string");
    const verifiedArtifactPath = latest.result.verifiedOutputPath as string;
    const manifestPath = resolve(
      latest.result.workspace as string,
      "verification/scene-manifest.json",
    );
    const sceneSpec = readJson(rev8ScenePath);
    const expectedManifest = readJson(rev8ManifestPath);
    assert.deepEqual(readJson(manifestPath), expectedManifest);
    const canonicalHashBefore = rawHash(verifiedArtifactPath);
    const input = { sceneSpec, expectedManifest, verifiedArtifactPath };

    const blocked = await executeGoldenCoronaPreview({
      config: previewConfig(),
      ...input,
      authorizeDccExecution: false,
    });
    assert.equal(blocked.status, "BLOCKED");
    assert.equal(blocked.error?.code, "DCC_EXECUTION_DISABLED");

    const preview = await executeGoldenCoronaPreview({
      config: previewConfig(),
      ...input,
      authorizeDccExecution: true,
    });
    assert.equal(preview.status, "PASS", JSON.stringify(preview));
    assert.equal(preview.plan?.source.artifactHash, canonicalHashBefore);
    assert.equal(preview.plan?.source.revisionId, "rev_golden_0008");
    assert.equal(preview.plan?.camera.logicalId, "camera_living_a");
    assert.equal(preview.plan?.temporaryLight.mappedIntensity, 150);
    const evidence = preview.evidence as unknown as PreviewEvidenceView;
    assert.equal(evidence.source.artifactHash, canonicalHashBefore);
    assert.equal(evidence.source.stagedArtifactHash, canonicalHashBefore);
    assert.equal(evidence.canonical.managedNodeCount, 14);
    assert.equal(evidence.temporaryExecution.light.nonCanonical, true);
    assert.equal(evidence.temporaryExecution.light.className, "CoronaLight");
    assert.equal(evidence.render.resolution.width, 320);
    assert.equal(evidence.render.resolution.height, 240);
    assert.equal(evidence.output.format, "png");
    assert.equal(validateGoldenCoronaPreviewEvidence(preview.evidence).ok, true);
    assert.equal(rawHash(verifiedArtifactPath), canonicalHashBefore);
    assert.deepEqual(readJson(rev8ScenePath), sceneSpec);
    assert.equal(latest.result.verifiedOutputPath, verifiedArtifactPath);

    await expectPreviewFailure("RENDER_SOURCE_ARTIFACT_HASH_MISMATCH", input, "base_hash_tamper");
    await expectPreviewFailure("RENDER_SOURCE_MANIFEST_MISMATCH", input, "manifest_mismatch");
    await expectPreviewFailure("CAMERA_NOT_FOUND", input, "camera_missing");
    await expectPreviewFailure("CAMERA_ID_AMBIGUOUS", input, "camera_duplicate");
    await expectPreviewFailure("CORONA_NOT_FOUND", input, "renderer_missing");
    await expectPreviewFailure("CORONA_MATERIAL_CLASS_NOT_FOUND", input, "material_missing");
    await expectPreviewFailure("CORONA_LIGHT_CLASS_NOT_FOUND", input, "light_missing");
    await expectPreviewFailure("CORONA_MATERIAL_PROPERTY_UNSUPPORTED", input, "property_missing");
    await expectPreviewFailure("SAFE_SCENE_REQUIRED", input, "safe_scene");
    await expectPreviewFailure("RENDER_OUTPUT_INVALID", input, "png_invalid");
    await expectPreviewFailure("PROCESS_TIMEOUT", input, "timeout", 1);
    assert.equal(rawHash(verifiedArtifactPath), canonicalHashBefore);
    assert.equal(existsSync(resolve(runRoot, "render-workspaces")), true);
    process.stdout.write(
      `${JSON.stringify(
        {
          suite: "Technical Spike 8C Golden Living Room Corona Preview",
          status: "PASS",
          targetDccVersion: "2026",
          testedDccVersion: evidence.dcc.version,
          compatibilityMode: preview.compatibilityMode,
          canonicalArtifactHash: canonicalHashBefore,
          requestHash: preview.requestHash,
          managedNodeCount: evidence.canonical.managedNodeCount,
          results: {
            source: "verified Golden rev8 artifact + full manifest PASS",
            preview: "non-canonical trusted Corona preview PASS",
            preservation: "canonical/staged .max hashes unchanged; no revision created",
            failures: "tamper, manifest, camera, Corona, Safe Scene, timeout, PNG failures closed",
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
