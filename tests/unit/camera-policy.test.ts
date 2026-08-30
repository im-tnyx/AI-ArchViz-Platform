import { describe, expect, it } from "vitest";
import {
  degreesToRadians,
  deriveCameraFovDegrees,
  deriveCameraFovRadians,
  deriveLookAtRotationEuler,
  radiansToDegrees,
} from "../../apps/worker/src/camera-policy.js";

describe("camera-policy FOV math", () => {
  it("computes the canonical 24mm baseline FOV (Golden pre-8I camera_living_a)", () => {
    expect(deriveCameraFovRadians(24, 36)).toBeCloseTo(1.2870022175865687, 14);
    expect(deriveCameraFovDegrees(24, 36)).toBeCloseTo(73.73979529168804, 10);
  });

  it("computes the canonical 28mm baseline FOV (Golden post-8I camera_living_a)", () => {
    expect(deriveCameraFovRadians(28, 36)).toBeCloseTo(1.1426749596672536, 14);
    expect(deriveCameraFovDegrees(28, 36)).toBeCloseTo(65.4704525442152, 10);
  });

  it("round-trips degrees and radians", () => {
    expect(radiansToDegrees(degreesToRadians(65.4704525442152))).toBeCloseTo(65.4704525442152, 12);
    expect(degreesToRadians(radiansToDegrees(1.1426749596672536))).toBeCloseTo(
      1.1426749596672536,
      14,
    );
  });

  it("never conflates degrees and radians (the exact Spike 8H defect shape)", () => {
    // The historical bug assigned deriveCameraFovRadians(...) directly to a
    // degrees-based MAXScript property. Confirms the two are never
    // numerically close enough to mask that mistake.
    const radians = deriveCameraFovRadians(28, 36);
    const degrees = deriveCameraFovDegrees(28, 36);
    expect(Math.abs(radians - degrees)).toBeGreaterThan(1);
  });
});

describe("camera-policy look-at rotation derivation", () => {
  it("derives the exact canonical camera_living_a rotation", () => {
    const rotation = deriveLookAtRotationEuler([1200, 3800, 1500], [3000, 200, 1300]);
    expect(rotation[0]).toBeCloseTo(-2.8447103878693705, 10);
    expect(rotation[1]).toBe(0);
    expect(rotation[2]).toBeCloseTo(206.56505117707798, 10);
  });

  it("throws when position and target coincide", () => {
    expect(() => deriveLookAtRotationEuler([1000, 1000, 1000], [1000, 1000, 1000])).toThrow();
  });

  it("is a pure function of position and target only (deterministic, no hidden state)", () => {
    const first = deriveLookAtRotationEuler([100, 200, 300], [400, 500, 600]);
    const second = deriveLookAtRotationEuler([100, 200, 300], [400, 500, 600]);
    expect(first).toEqual(second);
  });
});
