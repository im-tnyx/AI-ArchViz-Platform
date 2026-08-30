/**
 * Single source for canonical camera math shared by the revision engine, the
 * Corona adapter, and the DCC-side camera runners. Pure and DCC-independent:
 * no pymxs/MAXScript concept crosses this boundary.
 *
 * 3ds Max's MAXScript `Camera.fov` (and its trig functions `atan`/`tan`) are
 * degrees-based; `fovRadians` here is a genuine radian value. A DCC-side
 * caller assigning to `camera.fov` must convert with `radiansToDegrees`, and
 * a caller reading `camera.fov` back must convert with `degreesToRadians`
 * before comparing against a canonical radian value (Spike 8H's degrees vs
 * radians defect: `camera.fov = fovRadians` directly silently pointed a
 * temporary camera at ~1.3 degrees instead of the intended ~74).
 */

export type CameraVector3 = readonly [number, number, number];

export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function deriveCameraFovRadians(focalLengthMm: number, sensorWidthMm: number): number {
  return 2 * Math.atan(sensorWidthMm / (2 * focalLengthMm));
}

export function deriveCameraFovDegrees(focalLengthMm: number, sensorWidthMm: number): number {
  return radiansToDegrees(deriveCameraFovRadians(focalLengthMm, sensorWidthMm));
}

/**
 * Canonical look-at Euler derivation (degrees), matching the exact
 * atan2-based convention already proven by the Golden fixture chain and the
 * 8E/8H DCC runners' `_look_at_rotation`. `position` and `target` must
 * differ; a coincident position/target has no defined orientation.
 */
/**
 * Rounded to a fixed precision because JS `Math.hypot` and Python's
 * `math.hypot` compute the same distance with different internal scaling
 * algorithms and disagree in the ~13th significant digit — far below any
 * meaningful precision at millimeter scale, but enough to fail an exact
 * cross-process evidence comparison if left at full float precision.
 */
export function targetDistanceMm(position: CameraVector3, target: CameraVector3): number {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  return Math.round(Math.hypot(dx, dy, dz) * 1_000_000) / 1_000_000;
}

export function deriveLookAtRotationEuler(
  position: CameraVector3,
  target: CameraVector3,
): [number, number, number] {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  const horizontal = Math.hypot(dx, dy);
  if (horizontal === 0 && dz === 0) {
    throw new Error("Camera position and target must differ");
  }
  const pitch = radiansToDegrees(Math.atan2(dz, horizontal));
  const yaw = (radiansToDegrees(Math.atan2(dy, dx)) + 270) % 360;
  return [pitch, 0, yaw];
}
