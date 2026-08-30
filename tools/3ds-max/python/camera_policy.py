"""Single source for canonical camera math shared by the DCC-side mutation
and verification scripts. Pure and DCC-independent (no pymxs import here),
mirroring `apps/worker/src/camera-policy.ts` exactly so the TS and Python
sides can never independently drift.

3ds Max's MAXScript `Camera.fov` (and its trig functions `atan`/`tan`) are
degrees-based; `fov_radians()` here returns a genuine radian value. A caller
assigning to `camera.fov` must convert with `math.degrees(...)`, and a
caller reading `camera.fov` back must convert with `math.radians(...)`
before comparing against a canonical radian value (the Spike 8H degrees vs
radians defect: assigning a radian number directly to `camera.fov` silently
pointed a camera at ~1.3 degrees instead of the intended ~74).
"""

from __future__ import annotations

import math

ROTATION_ANGLE_TOLERANCE = 0.001


def fov_radians(focal_length_mm: float, sensor_width_mm: float) -> float:
    return 2.0 * math.atan(float(sensor_width_mm) / (2.0 * float(focal_length_mm)))


def fov_degrees(focal_length_mm: float, sensor_width_mm: float) -> float:
    return math.degrees(fov_radians(focal_length_mm, sensor_width_mm))


def look_at_rotation_euler(position: list[float], target: list[float]) -> tuple[float, float, float]:
    dx = float(target[0]) - float(position[0])
    dy = float(target[1]) - float(position[1])
    dz = float(target[2]) - float(position[2])
    horizontal = math.hypot(dx, dy)
    if horizontal == 0 and dz == 0:
        raise ValueError("Camera position and target must differ")
    pitch = math.degrees(math.atan2(dz, horizontal))
    yaw = (math.degrees(math.atan2(dy, dx)) + 270.0) % 360.0
    return pitch, 0.0, yaw


def target_distance_mm(position: list[float], target: list[float]) -> float:
    """Rounded to a fixed precision because JS `Math.hypot` and Python's
    `math.hypot` compute the same distance with different internal scaling
    algorithms and disagree in the ~13th significant digit — far below any
    meaningful precision at millimeter scale, but enough to fail an exact
    cross-process evidence comparison if left at full float precision.
    """
    dx = float(target[0]) - float(position[0])
    dy = float(target[1]) - float(position[1])
    dz = float(target[2]) - float(position[2])
    return round(math.hypot(dx, dy, dz), 6)


def implied_target(
    position: list[float], rotation_euler: list[float], target_distance: float
) -> list[float]:
    """Inverse of `look_at_rotation_euler`: reconstructs the physical point a
    camera at `position` with `rotation_euler` is looking at, `target_distance`
    away. Used to derive the OBSERVED target from physical camera state
    (position + orientation + targetDistance) rather than trusting only
    stored target metadata (Spike 8I observed-target requirement).
    """
    pitch_rad = math.radians(float(rotation_euler[0]))
    yaw_rad = math.radians(float(rotation_euler[2]))
    horizontal = float(target_distance) * math.cos(pitch_rad)
    dz = float(target_distance) * math.sin(pitch_rad)
    angle = yaw_rad - math.radians(270.0)
    dx = horizontal * math.cos(angle)
    dy = horizontal * math.sin(angle)
    return [float(position[0]) + dx, float(position[1]) + dy, float(position[2]) + dz]


def close(left: float, right: float, tolerance: float = 0.01) -> bool:
    return abs(float(left) - float(right)) <= tolerance


def angle_close(left: float, right: float, tolerance: float = ROTATION_ANGLE_TOLERANCE) -> bool:
    difference = (float(left) - float(right) + 180.0) % 360.0 - 180.0
    return abs(difference) <= tolerance
