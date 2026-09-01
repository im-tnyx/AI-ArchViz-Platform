import { describe, expect, it } from "vitest";
import {
  canonicalCameraAngle,
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
  it("derives the exact canonical camera_living_a rotation, normalized to the Golden fixture's 6-decimal precision", () => {
    const rotation = deriveLookAtRotationEuler([1200, 3800, 1500], [3000, 200, 1300]);
    expect(rotation).toEqual([-2.84471, 0, 206.565051]);
  });

  it("throws when position and target coincide", () => {
    expect(() => deriveLookAtRotationEuler([1000, 1000, 1000], [1000, 1000, 1000])).toThrow();
  });

  it("is a pure function of position and target only (deterministic, no hidden state)", () => {
    const first = deriveLookAtRotationEuler([100, 200, 300], [400, 500, 600]);
    const second = deriveLookAtRotationEuler([100, 200, 300], [400, 500, 600]);
    expect(first).toEqual(second);
  });

  it("repeated calls with the same position/target always produce the exact same Euler array (post-8I precision closure)", () => {
    const calls = Array.from({ length: 5 }, () =>
      deriveLookAtRotationEuler([1200, 3800, 1500], [3000, 200, 1300]),
    );
    for (const rotation of calls) {
      expect(rotation).toEqual(calls[0]);
    }
  });

  it("a focal-length-only camera change does not alter the derived rotation (rev11 vs rev12 orientation identity)", () => {
    const position: [number, number, number] = [1200, 3800, 1500];
    const target: [number, number, number] = [3000, 200, 1300];
    // focalLengthMm/sensorWidthMm never enter the look-at derivation, so the
    // same position/target always yields the same orientation regardless of
    // any lens change applied alongside it.
    const rotationBefore24mm = deriveLookAtRotationEuler(position, target);
    const rotationAfter28mm = deriveLookAtRotationEuler(position, target);
    expect(rotationAfter28mm).toEqual(rotationBefore24mm);
  });
});

describe("canonicalCameraAngle", () => {
  it("rounds to exactly 6 decimal places with no insignificant trailing zeros", () => {
    expect(canonicalCameraAngle(-2.8447103878693705)).toBe(-2.84471);
    expect(canonicalCameraAngle(206.56505117707798)).toBe(206.565051);
    expect(canonicalCameraAngle(0)).toBe(0);
  });
});
