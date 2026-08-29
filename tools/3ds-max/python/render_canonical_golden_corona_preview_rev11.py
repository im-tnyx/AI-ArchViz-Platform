"""Render the first canonical Corona preview whose renderer, light, MATERIAL,
and camera intent are all already-canonical, already-PERSISTED rev11
SceneSpec v0.3 revision state (Technical Spike 8H).

This runner opens only a staged worker copy of the already-VERIFIED canonical
rev11 artifact. Unlike Spike 8E (which realized temporary Corona Physical
Materials because rev10 predates the material-appearance contract), rev11
already contains real, persisted, canonically-named Corona Physical Materials
(Spike 8G): this runner only RESOLVES, OBSERVES, and VERIFIES them, reusing
`verify_canonical_material_state`'s trusted resolution/property-discovery
logic rather than a fourth Corona material-property mapper. It never creates
a light, never switches the renderer, never creates or assigns a material,
never mutates the camera, and never saves the loaded scene.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIRECTORY = str(Path(__file__).resolve().parent)
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

import render_corona_baseline as corona  # noqa: E402
import verify_canonical_material_state  # noqa: E402
import verify_canonical_render_state  # noqa: E402
import verify_scene  # noqa: E402
from pymxs import runtime as rt  # noqa: E402


RUNNER_VERSION = "0.1.0"
PLAN_VERSION = "0.2.0"
CANONICAL_REVISION_ID = "rev_golden_0011"
EXPECTED_RESOLUTION = {"width": 320, "height": 240}
EXPECTED_TERMINATION = {"type": "pass_limit", "value": 4}
DIAGNOSTIC_LIGHT_LOGICAL_ID = "preview_key_area"
DIAGNOSTIC_LIGHT_NAME = "AVZ_PREVIEW_CORONA_KEY"
CAMERA_TOLERANCE = 0.01
ANGLE_TOLERANCE = 0.001
RENDER_STATE_ERROR_CODES = (
    "SAFE_SCENE_REQUIRED",
    "CORONA_NOT_FOUND",
    "RENDER_STATE_MISMATCH",
    "DUPLICATE_LOGICAL_LIGHT",
    "LIGHT_STATE_MISMATCH",
    "LIGHT_PHYSICAL_PROPERTY_MISMATCH",
    "CORONA_LIGHT_CLASS_NOT_FOUND",
    "CORONA_LIGHT_PROPERTY_UNSUPPORTED",
)
MATERIAL_STATE_ERROR_CODES = (
    "SAFE_SCENE_REQUIRED",
    "CANDIDATE_MISSING",
    "CANDIDATE_OPEN_FAILED",
    "MATERIAL_STATE_INVALID",
    "MATERIAL_NOT_FOUND",
    "MATERIAL_TYPE_MISMATCH",
    "MATERIAL_COLOR_MISMATCH",
    "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED",
    "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED",
    "MATERIAL_ASSIGNMENT_MISMATCH",
    "CORONA_MATERIAL_ASSIGNMENT_FAILED",
)


class CanonicalPreviewError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise CanonicalPreviewError("TRUSTED_INPUT_MISSING", f"Missing worker-owned input {key}")
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


def _force(code: str) -> bool:
    return os.environ.get("AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_REV11_FAILURE") == code


def _class_name(value: Any) -> str:
    return corona._class_name(value)


def _vector(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _close(left: float, right: float, tolerance: float = CAMERA_TOLERANCE) -> bool:
    return abs(float(left) - float(right)) <= tolerance


def _angle_close(left: float, right: float) -> bool:
    difference = (float(left) - float(right) + 180.0) % 360.0 - 180.0
    return abs(difference) <= ANGLE_TOLERANCE


def _logical_id(node: Any) -> str | None:
    value = rt.getUserProp(node, "AIArchViz.LogicalObjectId")
    return str(value) if value is not None else None


def _look_at_rotation(position: list[float], target: list[float]) -> tuple[float, float, float]:
    dx = float(target[0]) - float(position[0])
    dy = float(target[1]) - float(position[1])
    dz = float(target[2]) - float(position[2])
    horizontal = math.hypot(dx, dy)
    if horizontal == 0 and dz == 0:
        raise CanonicalPreviewError("CAMERA_NOT_FOUND", "Camera position and target must differ")
    return math.degrees(math.atan2(dz, horizontal)), 0.0, (math.degrees(math.atan2(dy, dx)) + 270.0) % 360.0


def _validate_plan(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan must be an object")
    expected_keys = {
        "planVersion",
        "engine",
        "projectId",
        "sceneId",
        "revisionId",
        "coordinateSystem",
        "geometry",
        "materials",
        "materialAssignments",
        "lights",
        "camera",
        "render",
        "adapterDefaults",
    }
    if set(value) != expected_keys:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan keys are not trusted")
    if value["planVersion"] != PLAN_VERSION or value["engine"] != "corona":
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Unsupported plan version or engine")
    if value["revisionId"] != CANONICAL_REVISION_ID:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan is not the canonical rev11 revision")
    if value["render"] != {
        "mode": "preview",
        "resolution": EXPECTED_RESOLUTION,
        "termination": EXPECTED_TERMINATION,
    }:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan render policy is unsupported")
    if value["adapterDefaults"] != {"areaLight": {"widthMm": 800, "intensityScale": 120}}:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan adapter defaults are unsupported")
    if not isinstance(value["camera"], dict) or value["camera"].get("logicalId") != "camera_living_a":
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan camera is unsupported")
    if not isinstance(value["lights"], list) or len(value["lights"]) == 0:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan must contain canonical lights")
    if any(entry.get("type") != "area" for entry in value["lights"] if isinstance(entry, dict)):
        raise CanonicalPreviewError("RENDERER_LIGHT_TYPE_UNSUPPORTED", "Corona supports area lights only")
    if not isinstance(value["materials"], list) or not value["materials"]:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan must contain canonical materials")
    for entry in value["materials"]:
        if not isinstance(entry, dict) or "roughness" not in entry or "metalness" not in entry:
            raise CanonicalPreviewError(
                "CORONA_EXECUTION_PLAN_INVALID", "Plan v0.2 material is missing canonical appearance"
            )
    if not isinstance(value["materialAssignments"], list) or not value["materialAssignments"]:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan material data is invalid")
    return value


def _verify_source_manifest() -> dict[str, Any]:
    if _force("safe_scene"):
        raise CanonicalPreviewError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
    try:
        actual_manifest, _verification = verify_scene.verify()
    except Exception as error:
        message = str(error)
        if "SAFE_SCENE_REQUIRED" in message:
            raise CanonicalPreviewError("SAFE_SCENE_REQUIRED", "Safe Scene verification failed") from error
        raise CanonicalPreviewError(
            "RENDER_SOURCE_MANIFEST_MISMATCH", "Source scene verification failed"
        ) from error
    expected_path = _required_path("AI_ARCHVIZ_EXPECTED_MANIFEST_PATH")
    expected_manifest = json.loads(expected_path.read_text(encoding="utf-8"))
    if actual_manifest != expected_manifest:
        raise CanonicalPreviewError("RENDER_SOURCE_MANIFEST_MISMATCH", "Verified source manifest differs")
    return actual_manifest


def _verify_render_state() -> dict[str, Any]:
    try:
        evidence, _result = verify_canonical_render_state.verify()
    except Exception as error:
        code = getattr(error, "code", None)
        if not isinstance(code, str) or code not in RENDER_STATE_ERROR_CODES:
            code = "RENDER_STATE_MISMATCH"
        raise CanonicalPreviewError(code, "Canonical render-state verification failed") from error
    return evidence


def _verify_material_state() -> dict[str, Any]:
    try:
        evidence, _result = verify_canonical_material_state.verify()
    except Exception as error:
        code = getattr(error, "code", None)
        if not isinstance(code, str) or code not in MATERIAL_STATE_ERROR_CODES:
            code = "CORONA_MATERIAL_ASSIGNMENT_FAILED"
        raise CanonicalPreviewError(code, "Canonical material-state verification failed") from error
    if not evidence.get("deduplication", {}).get("sameIdSharedInstance") or not evidence.get(
        "deduplication", {}
    ).get("differentIdDistinctInstances"):
        raise CanonicalPreviewError(
            "CORONA_MATERIAL_ASSIGNMENT_FAILED", "Persisted material deduplication proof failed"
        )
    return evidence


def _require_no_diagnostic_light() -> None:
    if _force("diagnostic_light"):
        raise CanonicalPreviewError(
            "UNEXPECTED_DIAGNOSTIC_LIGHT", "Trusted test forced diagnostic light presence"
        )
    for node in rt.objects:
        if _logical_id(node) == DIAGNOSTIC_LIGHT_LOGICAL_ID or str(node.name) == DIAGNOSTIC_LIGHT_NAME:
            raise CanonicalPreviewError("UNEXPECTED_DIAGNOSTIC_LIGHT", "Obsolete diagnostic light is present")


def _resolve_camera(plan: dict[str, Any]) -> dict[str, Any]:
    if _force("camera_missing"):
        raise CanonicalPreviewError("CAMERA_NOT_FOUND", "Trusted test forced camera absence")
    matches = [node for node in rt.objects if _logical_id(node) == "camera_living_a"]
    if _force("camera_duplicate") and matches:
        matches.append(matches[0])
    if not matches:
        raise CanonicalPreviewError("CAMERA_NOT_FOUND", "Canonical camera_living_a is missing")
    if len(matches) != 1:
        raise CanonicalPreviewError("CAMERA_ID_AMBIGUOUS", "Canonical camera_living_a is ambiguous")
    camera = matches[0]
    if "camera" not in str(rt.superClassOf(camera)).lower():
        raise CanonicalPreviewError("CAMERA_NOT_FOUND", "Canonical camera_living_a is not a camera")
    if _force("camera_semantic_mismatch"):
        raise CanonicalPreviewError("CAMERA_REALIZATION_FAILED", "Trusted test forced camera semantic mismatch")
    entry = plan["camera"]
    # Observation-only: the persisted camera is never written to. A canonical
    # semantic mismatch fails closed rather than being silently repaired.
    observed_position = _vector(camera.pos)
    if any(not _close(actual, expected) for actual, expected in zip(observed_position, entry["position"])):
        raise CanonicalPreviewError("CAMERA_REALIZATION_FAILED", "Persisted camera position mismatch")
    # MAXScript's Camera.fov is degrees; the canonical plan's fovRadians is a
    # genuine radian value (`2 * atan(sensorWidth / (2 * focalLength))`
    # computed in JS radians by the adapter). Converting before comparing is
    # observation, not repair: the persisted camera's real field of view is
    # unaffected by which unit this runner reads it in.
    observed_fov_radians = math.radians(float(camera.fov))
    if not _close(observed_fov_radians, float(entry["fovRadians"]), tolerance=0.000001):
        raise CanonicalPreviewError("CAMERA_REALIZATION_FAILED", "Persisted camera FOV mismatch")
    expected_rotation = _look_at_rotation(entry["position"], entry["target"])
    observed_rotation = _vector(rt.quatToEuler(camera.rotation))
    if any(not _angle_close(actual, expected) for actual, expected in zip(observed_rotation, expected_rotation)):
        raise CanonicalPreviewError("CAMERA_REALIZATION_FAILED", "Persisted camera orientation mismatch")
    return {
        "node": camera,
        "evidence": {
            "logicalId": "camera_living_a",
            "className": _class_name(rt.classOf(camera)),
            "position": entry["position"],
            "target": entry["target"],
            "focalLengthMm": entry["focalLengthMm"],
            "sensorWidthMm": entry["sensorWidthMm"],
            "fovRadians": entry["fovRadians"],
            "lookAtTarget": True,
        },
    }


def _finalize_renderer_for_render(plan: dict[str, Any]) -> tuple[str, str | None]:
    if _force("renderer_missing"):
        raise CanonicalPreviewError("CORONA_NOT_FOUND", "Trusted test forced renderer absence")
    renderer = rt.renderers.production
    if renderer is None or "corona" not in corona._normalized_name(rt.classOf(renderer)):
        raise CanonicalPreviewError("CORONA_NOT_FOUND", "Persisted production renderer is not Corona")
    observed_class = _class_name(rt.classOf(renderer))
    plugin_version = corona._observable_plugin_version(renderer)
    corona._set_discovered_property(
        renderer,
        ("passlimit", "progressivepasslimit"),
        ("pass", "limit"),
        int(plan["render"]["termination"]["value"]),
        "CORONA_PASS_LIMIT_PROPERTY_NOT_FOUND",
    )
    return observed_class, plugin_version


def _render(camera: Any, output_path: Path, render: dict[str, Any]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()
    rt.rendShowVFB = False
    try:
        bitmap = rt.render(
            camera=camera,
            outputwidth=int(render["resolution"]["width"]),
            outputheight=int(render["resolution"]["height"]),
            outputFile=str(output_path),
            vfb=False,
        )
        try:
            bitmap.close()
        except Exception:
            pass
    except Exception as error:
        message = str(error)
        if any(token in message.lower() for token in ("license", "licence", "activation", "sign in")):
            raise CanonicalPreviewError("CORONA_LICENSE_UNAVAILABLE", "Corona license is unavailable") from error
        raise CanonicalPreviewError("CORONA_RENDER_FAILED", "Corona canonical render failed") from error
    if _force("png_invalid") and output_path.exists():
        output_path.unlink()
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise CanonicalPreviewError("RENDER_OUTPUT_INVALID", "Canonical render did not create a non-empty PNG")


def realize(plan: dict[str, Any], output_path: Path) -> dict[str, Any]:
    if _force("timeout"):
        time.sleep(300)
    _verify_source_manifest()
    render_state_evidence = _verify_render_state()
    material_state_evidence = _verify_material_state()
    _require_no_diagnostic_light()
    observed_renderer_class, plugin_version = _finalize_renderer_for_render(plan)
    camera = _resolve_camera(plan)
    _render(camera["node"], output_path, plan["render"])
    return {
        "status": "PASS",
        "runnerVersion": RUNNER_VERSION,
        "renderer": {"className": observed_renderer_class, "version": plugin_version},
        "dcc": {
            "version": corona._runtime_version(),
            "compatibilityMode": corona._runtime_major_version() != 2026,
        },
        "canonicalRenderState": render_state_evidence,
        "canonicalMaterialState": material_state_evidence,
        "materials": material_state_evidence["materials"],
        "materialAssignments": material_state_evidence["materialAssignments"],
        "deduplication": material_state_evidence["deduplication"],
        "camera": camera["evidence"],
        "render": plan["render"],
    }


def main() -> int:
    plan_path = _required_path("AI_ARCHVIZ_CANONICAL_PREVIEW_PLAN_PATH")
    output_path = _required_path("AI_ARCHVIZ_CANONICAL_PREVIEW_OUTPUT_PATH")
    result_path = _required_path("AI_ARCHVIZ_CANONICAL_PREVIEW_RESULT_PATH")
    try:
        plan = _validate_plan(json.loads(plan_path.read_text(encoding="utf-8")))
        result = realize(plan, output_path)
        _write_json(result_path, result)
        print("AI_ARCHVIZ_CANONICAL_PREVIEW_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except (CanonicalPreviewError, corona.CoronaBaselineError) as error:
        result = {"status": "FAILED", "failureCode": error.code, "message": str(error)}
    except Exception as error:
        result = {"status": "FAILED", "failureCode": "CORONA_RENDER_FAILED", "message": f"{type(error).__name__}: {error}"}
    _write_json(result_path, result)
    print("AI_ARCHVIZ_CANONICAL_PREVIEW_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
