"""Render the first canonical Corona preview whose renderer and light intent
are both canonical rev10 SceneSpec revision state (Technical Spike 8E).

This runner opens only a staged worker copy of the already-VERIFIED canonical
rev10 artifact. It never rebuilds geometry from a plan, never assigns or
switches the renderer, never creates or mutates a light, and never saves the
loaded scene.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIRECTORY = str(Path(__file__).resolve().parent)
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

import render_corona_baseline as corona  # noqa: E402
import verify_canonical_render_state  # noqa: E402
import verify_scene  # noqa: E402
from pymxs import runtime as rt  # noqa: E402


RUNNER_VERSION = "0.1.0"
PLAN_VERSION = "0.1.0"
EXPECTED_RESOLUTION = {"width": 320, "height": 240}
EXPECTED_TERMINATION = {"type": "pass_limit", "value": 4}
DIAGNOSTIC_LIGHT_LOGICAL_ID = "preview_key_area"
DIAGNOSTIC_LIGHT_NAME = "AVZ_PREVIEW_CORONA_KEY"
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
    return os.environ.get("AI_ARCHVIZ_TEST_FORCE_CANONICAL_GOLDEN_PREVIEW_FAILURE") == code


def _normalized_name(value: Any) -> str:
    return corona._normalized_name(value)


def _class_name(value: Any) -> str:
    return corona._class_name(value)


def _point(value: list[float]) -> Any:
    return rt.Point3(float(value[0]), float(value[1]), float(value[2]))


def _vector(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _logical_id(node: Any) -> str | None:
    value = rt.getUserProp(node, "AIArchViz.LogicalObjectId")
    return str(value) if value is not None else None


def _host_logical_id(node: Any) -> str | None:
    value = rt.getUserProp(node, "AIArchViz.HostLogicalId")
    return str(value) if value is not None else None


def _look_at_rotation(position: list[float], target: list[float]) -> tuple[float, float, float]:
    import math

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
    if value["revisionId"] != "rev_golden_0010":
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan is not the canonical rev10 revision")
    if value["render"] != {
        "mode": "preview",
        "resolution": EXPECTED_RESOLUTION,
        "termination": EXPECTED_TERMINATION,
    }:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan render policy is unsupported")
    if value["adapterDefaults"] != {
        "material": {"roughness": 0.45, "nonMetalMode": True},
        "areaLight": {"widthMm": 800, "intensityScale": 120},
    }:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan adapter defaults are unsupported")
    if not isinstance(value["camera"], dict) or value["camera"].get("logicalId") != "camera_living_a":
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan camera is unsupported")
    if not isinstance(value["lights"], list) or len(value["lights"]) == 0:
        raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Plan must contain canonical lights")
    if any(entry.get("type") != "area" for entry in value["lights"] if isinstance(entry, dict)):
        raise CanonicalPreviewError("RENDERER_LIGHT_TYPE_UNSUPPORTED", "Corona supports area lights only")
    if not isinstance(value["materials"], list) or not isinstance(value["materialAssignments"], list):
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


def _require_no_diagnostic_light() -> None:
    if _force("diagnostic_light"):
        raise CanonicalPreviewError(
            "UNEXPECTED_DIAGNOSTIC_LIGHT", "Trusted test forced diagnostic light presence"
        )
    for node in rt.objects:
        if _logical_id(node) == DIAGNOSTIC_LIGHT_LOGICAL_ID or str(node.name) == DIAGNOSTIC_LIGHT_NAME:
            raise CanonicalPreviewError("UNEXPECTED_DIAGNOSTIC_LIGHT", "Obsolete diagnostic light is present")


def _canonical_targets(target_id: str) -> list[Any]:
    physical_segments = [node for node in rt.objects if _host_logical_id(node) == target_id]
    # Wall semantic helpers are Dummies; physical segments are canonical for
    # renderer assignment, exactly as in the 8B/8C realization paths.
    targets = physical_segments or [node for node in rt.objects if _logical_id(node) == target_id]
    if not targets:
        raise CanonicalPreviewError(
            "MATERIAL_ASSIGNMENT_TARGET_MISSING", f"Canonical target is missing: {target_id}"
        )
    return targets


def _same_material_instance(left: Any, right: Any) -> bool:
    try:
        return int(rt.getHandleByAnim(left)) == int(rt.getHandleByAnim(right))
    except Exception:
        return str(left) == str(right) and str(left.name) == str(right.name)


def _realize_materials(plan: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if _force("material_missing"):
        raise CanonicalPreviewError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Trusted test forced material absence")
    if _force("property_missing"):
        raise CanonicalPreviewError(
            "CORONA_MATERIAL_PROPERTY_UNSUPPORTED", "Trusted test forced property absence"
        )
    materials: dict[str, Any] = {}
    material_evidence: list[dict[str, Any]] = []
    for entry in plan["materials"]:
        material_id = str(entry["materialId"])
        if material_id in materials:
            raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Duplicate canonical material")
        material, class_name = corona.create_corona_physical_material(
            entry["baseColorRgb"], f"AVZ_CORONA_{material_id}"
        )
        if "corona" not in _normalized_name(class_name) or "physical" not in _normalized_name(class_name):
            raise CanonicalPreviewError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Created material is not Corona Physical")
        materials[material_id] = material
        material_evidence.append(
            {
                "materialId": material_id,
                "className": class_name,
                "canonicalBaseColorRgb": entry["baseColorRgb"],
                "materialInstanceName": str(material.name),
            }
        )

    assignments: list[dict[str, Any]] = []
    assigned_targets: set[str] = set()
    for entry in plan["materialAssignments"]:
        target_id = str(entry["targetId"])
        material_id = str(entry["materialId"])
        if target_id in assigned_targets:
            raise CanonicalPreviewError("CORONA_EXECUTION_PLAN_INVALID", "Duplicate canonical material target")
        assigned_targets.add(target_id)
        material = materials.get(material_id)
        if material is None:
            raise CanonicalPreviewError(
                "CORONA_EXECUTION_PLAN_INVALID", "Canonical material assignment cannot resolve"
            )
        targets = _canonical_targets(target_id)
        for target in targets:
            target.material = material
        observed = [target.material for target in targets]
        if any(not _same_material_instance(item, material) for item in observed):
            raise CanonicalPreviewError("CORONA_MATERIAL_ASSIGNMENT_FAILED", f"Material mismatch on {target_id}")
        assignments.append(
            {
                "targetId": target_id,
                "materialId": material_id,
                "materialInstanceName": str(material.name),
                "className": _class_name(rt.classOf(material)),
                "sharedMaterialInstance": True,
            }
        )
    return (
        sorted(material_evidence, key=lambda entry: entry["materialId"]),
        sorted(assignments, key=lambda entry: entry["targetId"]),
    )


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
    # Temporary exact in-memory normalization only; the loaded scene is never
    # saved, so this cannot drift the canonical persisted camera.
    camera.rotation = rt.EulerAngles(*_look_at_rotation(entry["position"], entry["target"]))
    camera.pos = _point(entry["position"])
    camera.fov = float(entry["fovRadians"])
    if any(abs(actual - float(expected)) > 0.001 for actual, expected in zip(_vector(camera.pos), entry["position"])):
        raise CanonicalPreviewError("CAMERA_REALIZATION_FAILED", "Canonical camera position mismatch")
    if abs(float(camera.fov) - float(entry["fovRadians"])) > 0.000001:
        raise CanonicalPreviewError("CAMERA_REALIZATION_FAILED", "Canonical camera FOV mismatch")
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
    _require_no_diagnostic_light()
    observed_renderer_class, plugin_version = _finalize_renderer_for_render(plan)
    material_evidence, assignment_evidence = _realize_materials(plan)
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
        "materials": material_evidence,
        "materialAssignments": assignment_evidence,
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
