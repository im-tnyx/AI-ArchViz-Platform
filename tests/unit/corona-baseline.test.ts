import { validateRenderEvidence, validateRenderJob } from "@ai-archviz/worker-contracts";
import { describe, expect, it } from "vitest";
import {
  coronaBaselineCameraId,
  coronaBaselineResolution,
  isFiniteCoronaBaselinePolicy,
  isWorkerControlledRenderOutput,
  normalizeCoronaRendererClassMetadata,
  selectCoronaRendererClass,
} from "../../apps/worker/src/corona-baseline.js";

const job = {
  renderJobVersion: "0.1.0",
  engine: "corona",
  cameraId: coronaBaselineCameraId,
  mode: "preview",
  resolution: coronaBaselineResolution,
};

describe("Corona baseline render contracts", () => {
  it("normalizes runtime renderer metadata without using a class index", () => {
    expect(normalizeCoronaRendererClassMetadata("#Corona Renderer 12")).toEqual({
      className: "Corona Renderer 12",
      normalizedName: "coronarenderer12",
    });
    expect(normalizeCoronaRendererClassMetadata(42)).toBeNull();
    expect(selectCoronaRendererClass(["Scanline", "Corona_Renderer"])).toEqual({
      status: "AVAILABLE",
      className: "Corona_Renderer",
    });
  });

  it("fails closed for missing or ambiguous Corona renderer discovery", () => {
    expect(selectCoronaRendererClass(["Scanline", "Arnold"])).toEqual({
      status: "CORONA_NOT_FOUND",
      candidates: [],
    });
    expect(selectCoronaRendererClass(["Corona Renderer", "Corona Legacy Renderer"])).toEqual({
      status: "CORONA_RENDERER_AMBIGUOUS",
      candidates: ["Corona Legacy Renderer", "Corona Renderer"],
    });
  });

  it("accepts only the frozen narrow render job and finite baseline policy", () => {
    expect(validateRenderJob(job).ok).toBe(true);
    expect(isFiniteCoronaBaselinePolicy(job)).toBe(true);
    expect(validateRenderJob({ ...job, outputPath: "C:/unsafe.png" }).ok).toBe(false);
    expect(isFiniteCoronaBaselinePolicy({ ...job, resolution: { width: 640, height: 480 } })).toBe(
      false,
    );
  });

  it("allows only the worker-owned output location", () => {
    expect(
      isWorkerControlledRenderOutput("C:/worker/job", "C:/worker/job/render/baseline.png"),
    ).toBe(true);
    expect(isWorkerControlledRenderOutput("C:/worker/job", "C:/worker/job/render/user.png")).toBe(
      false,
    );
    expect(isWorkerControlledRenderOutput("C:/worker/job", "C:/escape/baseline.png")).toBe(false);
  });

  it("validates portable normalized evidence without a filesystem path", () => {
    const evidence = {
      renderEvidenceVersion: "0.1.0",
      renderer: { engine: "corona", className: "CoronaRenderer", version: null },
      dcc: { product: "3ds_max", version: "27000.0", compatibilityMode: true },
      camera: { logicalId: coronaBaselineCameraId, className: "TargetCamera" },
      material: {
        className: "CoronaPhysicalMtl",
        baseColorRgb: [0.72, 0.62, 0.5],
        targetLogicalId: "asset_corona_baseline_subject",
      },
      light: {
        logicalId: "light_corona_baseline",
        className: "CoronaLight",
        strategy: "corona_light",
      },
      resolution: coronaBaselineResolution,
      termination: { type: "pass_limit", value: 4 },
      output: { format: "png", byteLength: 1024, sha256: `sha256:${"a".repeat(64)}` },
      status: "PASS",
    };
    expect(validateRenderEvidence(evidence).ok).toBe(true);
    expect(
      validateRenderEvidence({
        ...evidence,
        renderer: { ...evidence.renderer, version: "15.0" },
      }).ok,
    ).toBe(true);
    expect(
      validateRenderEvidence({
        ...evidence,
        renderer: { ...evidence.renderer, version: 15 },
      }).ok,
    ).toBe(false);
    expect(
      validateRenderEvidence({ ...evidence, output: { ...evidence.output, path: "C:/unsafe.png" } })
        .ok,
    ).toBe(false);
  });
});
