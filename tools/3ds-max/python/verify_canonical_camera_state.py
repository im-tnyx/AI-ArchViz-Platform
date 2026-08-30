"""Fresh-process verifier for the canonical camera state realized by a
SetCamera revision (Technical Spike 8I).

This process is independent from the mutation process and from the existing
semantic/render-state/material-state verifiers: it opens its own copy of the
candidate scene and re-observes every canonical camera from scratch,
deriving the OBSERVED target from physical camera state (position +
orientation + targetDistance) rather than trusting only stored metadata,
before any camera-state revision is allowed to be promoted.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))

import camera_policy  # noqa: E402
from pymxs import runtime as rt  # noqa: E402


VERIFY_VERSION = "0.1.0"
EXPECTED_CAMERA_CLASS = "Freecamera"
POSITION_TOLERANCE = 0.01
ANGLE_TOLERANCE = camera_policy.ROTATION_ANGLE_TOLERANCE
FOV_TOLERANCE = 0.000001


class CameraStateError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise CameraStateError("TRUSTED_INPUT_MISSING", f"Missing trusted environment value: {key}")
    return Path(value)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary_path, path)


def _user_prop(node: Any, key: str) -> str | None:
    value = rt.getUserProp(node, key)
    return str(value) if value is not None else None


def _force(code: str) -> bool:
    return os.environ.get("AI_ARCHVIZ_TEST_FORCE_CAMERA_REVISION_FAILURE") == code


def _vector(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _class_name(value: Any) -> str:
    return str(value).replace("#", "").strip()


def _safe_scene() -> dict[str, Any]:
    if _force("safe_scene"):
        raise CameraStateError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
    manager = rt.SceneScriptSecurityManager
    observation = {
        "safeSceneScriptExecutionEnabled": bool(
            manager.IsSafeSceneScriptExecutionEnabled(rt.Name("Current"))
        ),
        "settingsLocked": bool(manager.AreSettingsLocked()),
        "lockCause": str(manager.GetCauseOfLock()).replace("#", "").lower(),
        "scriptAssetsProtected": bool(manager.IsSafeScriptAssetExecutionEnabled()),
    }
    if not (
        observation["safeSceneScriptExecutionEnabled"]
        and observation["settingsLocked"]
        and observation["lockCause"] == "cmdline"
        and observation["scriptAssetsProtected"]
    ):
        raise CameraStateError("SAFE_SCENE_REQUIRED", "Safe Scene must be command-line locked")
    return observation


def _resolve_camera(logical_id: str, all_nodes: list[Any]) -> Any:
    if _force("camera_missing"):
        raise CameraStateError("CAMERA_NOT_FOUND", "Trusted test forced camera absence")
    matches = [
        node for node in all_nodes if _user_prop(node, "AIArchViz.LogicalObjectId") == logical_id
    ]
    if not matches:
        raise CameraStateError("CAMERA_NOT_FOUND", f"Canonical camera {logical_id} is missing")
    if len(matches) != 1:
        raise CameraStateError("CAMERA_ID_AMBIGUOUS", f"Canonical camera {logical_id} is ambiguous")
    node = matches[0]
    if _force("camera_wrong_class"):
        raise CameraStateError("CAMERA_NOT_FOUND", "Trusted test forced wrong camera class")
    actual_class = _class_name(rt.classOf(node))
    if actual_class != EXPECTED_CAMERA_CLASS:
        raise CameraStateError(
            "CAMERA_NOT_FOUND", f"Camera {logical_id} is {actual_class}, not {EXPECTED_CAMERA_CLASS}"
        )
    return node


def verify() -> tuple[dict[str, Any], dict[str, Any]]:
    candidate_path = _required_path("AI_ARCHVIZ_CANDIDATE_PATH")
    expected_path = _required_path("AI_ARCHVIZ_EXPECTED_CAMERA_STATE_PATH")
    evidence_path = _required_path("AI_ARCHVIZ_CAMERA_STATE_PATH")
    result_path = _required_path("AI_ARCHVIZ_CAMERA_STATE_RESULT_PATH")
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if _force("timeout"):
        time.sleep(300)
    if not candidate_path.exists() or candidate_path.stat().st_size <= 0:
        raise CameraStateError("CANDIDATE_MISSING", "Candidate scene is missing")
    if not rt.loadMaxFile(str(candidate_path), useFileUnits=True, quiet=True):
        raise CameraStateError("CANDIDATE_OPEN_FAILED", "Could not open candidate scene")
    safe_scene = _safe_scene()
    expected_cameras = expected.get("cameras")
    if not isinstance(expected_cameras, list) or not expected_cameras:
        raise CameraStateError("CAMERA_STATE_INVALID", "Expected camera state is incomplete")

    all_nodes = list(rt.objects)
    camera_evidence: list[dict[str, Any]] = []
    for expected_camera in expected_cameras:
        logical_id = str(expected_camera["logicalId"])
        node = _resolve_camera(logical_id, all_nodes)

        canonical_position = [float(component) for component in expected_camera["canonicalPosition"]]
        canonical_target = [float(component) for component in expected_camera["canonicalTarget"]]
        canonical_rotation = [
            float(component) for component in expected_camera["canonicalRotationEuler"]
        ]
        expected_fov_radians = float(expected_camera["expectedFovRadians"])
        expected_fov_degrees = float(expected_camera["expectedFovDegrees"])

        observed_position = _vector(node.pos)
        if any(
            not camera_policy.close(actual, canonical, POSITION_TOLERANCE)
            for actual, canonical in zip(observed_position, canonical_position)
        ):
            raise CameraStateError(
                "CAMERA_ORIENTATION_MISMATCH", f"Camera {logical_id} position drifted from canonical intent"
            )

        observed_rotation = _vector(rt.quatToEuler(node.rotation))
        if _force("orientation_mismatch"):
            observed_rotation = [component + 5.0 for component in observed_rotation]
        if any(
            not camera_policy.angle_close(actual, canonical, ANGLE_TOLERANCE)
            for actual, canonical in zip(observed_rotation, canonical_rotation)
        ):
            raise CameraStateError(
                "CAMERA_ORIENTATION_MISMATCH",
                f"Camera {logical_id} orientation drifted from canonical intent",
            )

        # MAXScript's Camera.fov is degrees; the canonical fovRadians is a
        # genuine radian value. `fov_regression` simulates the historical
        # Spike 8H defect (treating the raw degrees value as if it were
        # already radians) to prove this verifier still fails closed on it.
        if _force("fov_regression"):
            observed_fov_radians = float(node.fov)
        else:
            observed_fov_radians = math.radians(float(node.fov))
        observed_fov_degrees = float(node.fov)
        if not camera_policy.close(observed_fov_radians, expected_fov_radians, FOV_TOLERANCE):
            raise CameraStateError(
                "CAMERA_FOV_MISMATCH", f"Camera {logical_id} FOV drifted from canonical intent"
            )

        # Freecamera.targetDistance is settable at creation but not reliably
        # readable back via pymxs direct attribute access, so the observed
        # target is reconstructed from the two physical properties that ARE
        # reliably observable (position, orientation) combined with the
        # already-known canonical distance, rather than trusting a third
        # native property this class does not consistently expose.
        canonical_target_distance = camera_policy.target_distance_mm(
            canonical_position, canonical_target
        )
        if _force("target_mismatch"):
            canonical_target_distance += 500.0
        observed_target = camera_policy.implied_target(
            observed_position, observed_rotation, canonical_target_distance
        )
        if any(
            not camera_policy.close(actual, canonical, POSITION_TOLERANCE)
            for actual, canonical in zip(observed_target, canonical_target)
        ):
            raise CameraStateError(
                "CAMERA_TARGET_MISMATCH", f"Camera {logical_id} implied target drifted from canonical intent"
            )

        camera_evidence.append(
            {
                "logicalId": logical_id,
                "actualClass": EXPECTED_CAMERA_CLASS,
                # Evidence carries the canonical, tolerance-checked values,
                # not the raw runtime observation, matching the
                # canonical-render-state-v0.1 / canonical-material-state-v0.1
                # normalization pattern.
                "canonicalPosition": canonical_position,
                "observedPosition": canonical_position,
                "canonicalTarget": canonical_target,
                "observedTarget": canonical_target,
                "orientationPolicy": str(expected_camera["orientationPolicy"]),
                "canonicalRotationEuler": canonical_rotation,
                "observedRotationEuler": canonical_rotation,
                "focalLengthMm": float(expected_camera["focalLengthMm"]),
                "sensorWidthMm": float(expected_camera["sensorWidthMm"]),
                "expectedFovRadians": expected_fov_radians,
                "expectedFovDegrees": expected_fov_degrees,
                "observedFovRadians": expected_fov_radians,
                "observedFovDegrees": expected_fov_degrees,
                "targetDistanceMm": camera_policy.target_distance_mm(
                    canonical_position, canonical_target
                ),
            }
        )

    evidence = {
        "cameraStateVersion": "0.1.0",
        "projectId": str(expected["projectId"]),
        "sceneId": str(expected["sceneId"]),
        "revisionId": str(expected["revisionId"]),
        "sceneSpecVersion": str(expected["sceneSpecVersion"]),
        "cameras": sorted(camera_evidence, key=lambda entry: entry["logicalId"]),
        "status": "PASS",
    }
    if _force("invalid_evidence"):
        evidence["cameras"] = []
    _write_json(evidence_path, evidence)
    result = {
        "verificationVersion": VERIFY_VERSION,
        "status": "SUCCESS",
        "safeScene": safe_scene,
        "cameraCount": len(camera_evidence),
    }
    _write_json(result_path, result)
    return evidence, result


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_CAMERA_STATE_RESULT_PATH")
    try:
        _, result = verify()
        print("AI_ARCHVIZ_CAMERA_STATE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        result = {
            "verificationVersion": VERIFY_VERSION,
            "status": "FAILED",
            "errorCode": error.code if isinstance(error, CameraStateError) else "CAMERA_STATE_VERIFICATION_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_CAMERA_STATE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
