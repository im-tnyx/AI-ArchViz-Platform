"""Render a worker-owned, non-canonical Corona preview of verified Golden rev8.

This runner opens only the staged worker copy. It verifies the canonical scene
before temporary material/light/renderer realization and intentionally never
saves the loaded scene.
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

import render_corona_baseline as corona
import verify_scene
from pymxs import runtime as rt


RUNNER_VERSION = "0.1.0"
PLAN_VERSION = "0.1.0"
EXPECTED_RESOLUTION = {"width": 320, "height": 240}
EXPECTED_TERMINATION = {"type": "pass_limit", "value": 4}


class GoldenPreviewError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise GoldenPreviewError("TRUSTED_INPUT_MISSING", f"Missing worker-owned input {key}")
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
    return (
        os.environ.get("AI_ARCHVIZ_TEST_FORCE_GOLDEN_CORONA_PREVIEW_FAILURE") == code
        or os.environ.get("AI_ARCHVIZ_TEST_FORCE_CORONA_ADAPTER_FAILURE") == code
    )


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


def _validate_plan(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview plan must be an object")
    expected_keys = {
        "planVersion",
        "engine",
        "intentSource",
        "profileId",
        "source",
        "materials",
        "materialAssignments",
        "camera",
        "temporaryLight",
        "render",
        "adapterDefaults",
    }
    if set(value) != expected_keys:
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview plan keys are not trusted")
    if value["planVersion"] != PLAN_VERSION or value["engine"] != "corona":
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Unsupported preview plan version or engine")
    if value["intentSource"] != "trusted_diagnostic_profile" or value["profileId"] != "golden_living_corona_preview_v1":
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview intent is not repository-owned")
    source = value["source"]
    if not isinstance(source, dict) or source.get("revisionId") != "rev_golden_0008":
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview source is not Golden rev8")
    if value["render"] != {
        "mode": "preview",
        "resolution": EXPECTED_RESOLUTION,
        "termination": EXPECTED_TERMINATION,
    }:
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview render policy is unsupported")
    if value["adapterDefaults"] != {
        "material": {"roughness": 0.45, "nonMetalMode": True},
        "areaLight": {"widthMm": 800, "intensityScale": 120},
    }:
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview adapter defaults are unsupported")
    light = value["temporaryLight"]
    if not isinstance(light, dict) or light != {
        "logicalId": "preview_key_area",
        "type": "area",
        "position": [3000, 1600, 2800],
        "rotationEuler": [-35, 0, 0],
        "canonicalIntensity": 1.25,
        "mappedIntensity": 150,
        "widthMm": 800,
        "executionOnlyName": "AVZ_PREVIEW_CORONA_KEY",
    }:
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview light is unsupported")
    if not isinstance(value["materials"], list) or not isinstance(value["materialAssignments"], list):
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview material data is invalid")
    if not isinstance(value["camera"], dict) or value["camera"].get("logicalId") != "camera_living_a":
        raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview camera is unsupported")
    return value


def _verify_source_manifest(expected_path: Path) -> dict[str, Any]:
    if _force("safe_scene"):
        raise GoldenPreviewError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
    try:
        actual_manifest, verification = verify_scene.verify()
    except Exception as error:
        message = str(error)
        if "SAFE_SCENE_REQUIRED" in message:
            raise GoldenPreviewError("SAFE_SCENE_REQUIRED", "Safe Scene verification failed") from error
        raise GoldenPreviewError("RENDER_SOURCE_MANIFEST_MISMATCH", "Source scene verification failed") from error
    expected_manifest = json.loads(expected_path.read_text(encoding="utf-8"))
    if _force("manifest_mismatch"):
        actual_manifest["revisionId"] = "rev_forced_manifest_mismatch"
    if actual_manifest != expected_manifest:
        raise GoldenPreviewError("RENDER_SOURCE_MANIFEST_MISMATCH", "Verified source manifest differs")
    if verification.get("managedNodeCount") != 14:
        raise GoldenPreviewError("RENDER_SOURCE_MANIFEST_MISMATCH", "Managed node count is not 14")
    return actual_manifest


def _canonical_targets(target_id: str) -> list[Any]:
    physical_segments = [
        node
        for node in rt.objects
        if _host_logical_id(node) == target_id
    ]
    # Wall semantic helpers are Dummies. Their material handle is not a
    # reliable realization observation; physical segments are canonical for
    # renderer assignment, exactly as in the 8B adapter path.
    targets = physical_segments or [node for node in rt.objects if _logical_id(node) == target_id]
    if not targets:
        raise GoldenPreviewError("MATERIAL_ASSIGNMENT_TARGET_MISSING", f"Canonical target is missing: {target_id}")
    return targets


def _same_material_instance(left: Any, right: Any) -> bool:
    try:
        return int(rt.getHandleByAnim(left)) == int(rt.getHandleByAnim(right))
    except Exception:
        return str(left) == str(right) and str(left.name) == str(right.name)


def _realize_materials(plan: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    if _force("material_missing"):
        raise GoldenPreviewError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Trusted test forced material absence")
    if _force("property_missing"):
        raise GoldenPreviewError("CORONA_MATERIAL_PROPERTY_UNSUPPORTED", "Trusted test forced property absence")
    materials: dict[str, Any] = {}
    material_evidence: list[dict[str, Any]] = []
    for entry in plan["materials"]:
        material_id = str(entry["materialId"])
        if material_id in materials:
            raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Duplicate preview material")
        material, class_name = corona.create_corona_physical_material(
            entry["baseColorRgb"], f"AVZ_PREVIEW_CORONA_{material_id}"
        )
        if "corona" not in _normalized_name(class_name) or "physical" not in _normalized_name(class_name):
            raise GoldenPreviewError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Created material is not Corona Physical")
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
            raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Duplicate preview material target")
        assigned_targets.add(target_id)
        material = materials.get(material_id)
        if material is None:
            raise GoldenPreviewError("GOLDEN_PREVIEW_PLAN_INVALID", "Preview material assignment cannot resolve")
        targets = _canonical_targets(target_id)
        for target in targets:
            target.material = material
        observed = [target.material for target in targets]
        if any(not _same_material_instance(item, material) for item in observed):
            raise GoldenPreviewError("CORONA_MATERIAL_ASSIGNMENT_FAILED", f"Material mismatch on {target_id}")
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
        materials,
        sorted(material_evidence, key=lambda entry: entry["materialId"]),
        sorted(assignments, key=lambda entry: entry["targetId"]),
    )


def _look_at_rotation(position: list[float], target: list[float]) -> tuple[float, float, float]:
    dx = float(target[0]) - float(position[0])
    dy = float(target[1]) - float(position[1])
    dz = float(target[2]) - float(position[2])
    horizontal = math.hypot(dx, dy)
    if horizontal == 0 and dz == 0:
        raise GoldenPreviewError("CAMERA_NOT_FOUND", "Camera position and target must differ")
    return math.degrees(math.atan2(dz, horizontal)), 0.0, (math.degrees(math.atan2(dy, dx)) + 270.0) % 360.0


def _resolve_camera(plan: dict[str, Any]) -> dict[str, Any]:
    if _force("camera_missing"):
        raise GoldenPreviewError("CAMERA_NOT_FOUND", "Trusted test forced camera absence")
    matches = [node for node in rt.objects if _logical_id(node) == "camera_living_a"]
    if _force("camera_duplicate") and matches:
        matches.append(matches[0])
    if not matches:
        raise GoldenPreviewError("CAMERA_NOT_FOUND", "Canonical camera_living_a is missing")
    if len(matches) != 1:
        raise GoldenPreviewError("CAMERA_ID_AMBIGUOUS", "Canonical camera_living_a is ambiguous")
    camera = matches[0]
    if "camera" not in str(rt.superClassOf(camera)).lower():
        raise GoldenPreviewError("CAMERA_NOT_FOUND", "Canonical camera_living_a is not a camera")
    entry = plan["camera"]
    camera.rotation = rt.EulerAngles(*_look_at_rotation(entry["position"], entry["target"]))
    camera.pos = _point(entry["position"])
    camera.fov = float(entry["fovRadians"])
    if any(abs(actual - float(expected)) > 0.001 for actual, expected in zip(_vector(camera.pos), entry["position"])):
        raise GoldenPreviewError("CAMERA_REALIZATION_FAILED", "Canonical camera position mismatch")
    if abs(float(camera.fov) - float(entry["fovRadians"])) > 0.000001:
        raise GoldenPreviewError("CAMERA_REALIZATION_FAILED", "Canonical camera FOV mismatch")
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


def _create_temporary_light(plan: dict[str, Any]) -> dict[str, Any]:
    if _force("light_missing"):
        raise GoldenPreviewError("CORONA_LIGHT_CLASS_NOT_FOUND", "Trusted test forced light absence")
    entry = plan["temporaryLight"]
    light, class_name = corona.create_corona_area_light(
        entry["position"], entry["rotationEuler"], entry["mappedIntensity"], entry["widthMm"], entry["executionOnlyName"]
    )
    if _normalized_name(class_name) != "coronalight":
        raise GoldenPreviewError("CORONA_LIGHT_CLASS_NOT_FOUND", "Actual temporary light is not CoronaLight")
    if _logical_id(light) is not None:
        raise GoldenPreviewError("GOLDEN_PREVIEW_LIGHT_INVALID", "Temporary preview light has canonical identity")
    return {
        "id": entry["logicalId"],
        "name": entry["executionOnlyName"],
        "className": class_name,
        "nonCanonical": True,
        "position": entry["position"],
        "rotationEuler": entry["rotationEuler"],
        "canonicalIntensity": entry["canonicalIntensity"],
        "mappedIntensity": entry["mappedIntensity"],
        "widthMm": entry["widthMm"],
    }


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
            raise GoldenPreviewError("CORONA_LICENSE_UNAVAILABLE", "Corona license is unavailable") from error
        raise GoldenPreviewError("CORONA_RENDER_FAILED", "Corona preview render failed") from error
    if _force("png_invalid") and output_path.exists():
        output_path.unlink()
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise GoldenPreviewError("RENDER_OUTPUT_INVALID", "Preview render did not create a non-empty PNG")


def realize(plan: dict[str, Any], expected_manifest_path: Path, output_path: Path) -> dict[str, Any]:
    if _force("timeout"):
        time.sleep(300)
    if _force("renderer_missing"):
        raise GoldenPreviewError("CORONA_NOT_FOUND", "Trusted test forced renderer absence")
    manifest = _verify_source_manifest(expected_manifest_path)
    renderer_class, discovered_class = corona._discover_corona_renderer()
    _renderer, observed_class, renderer_version = corona._configure_renderer(renderer_class)
    if _normalized_name(discovered_class) != _normalized_name(observed_class):
        raise GoldenPreviewError("CORONA_RENDERER_ASSIGNMENT_FAILED", "Renderer identity changed")
    _materials, materials, assignments = _realize_materials(plan)
    camera = _resolve_camera(plan)
    temporary_light = _create_temporary_light(plan)
    _render(camera["node"], output_path, plan["render"])
    return {
        "status": "PASS",
        "runnerVersion": RUNNER_VERSION,
        "renderer": {"className": observed_class, "version": renderer_version},
        "dcc": {"version": corona._runtime_version(), "compatibilityMode": corona._runtime_major_version() != 2026},
        "canonical": {"managedNodeCount": 14, "camera": camera["evidence"], "materials": materials, "materialAssignments": assignments},
        "temporaryExecution": {
            "light": temporary_light,
            "adapterDefaults": {"roughness": 0.45, "nonMetalMode": True, "areaLightWidthMm": 800, "areaLightIntensityScale": 120},
            "stagedArtifactUnchanged": True,
        },
        "render": plan["render"],
    }


def main() -> int:
    plan_path = _required_path("AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_PLAN_PATH")
    expected_manifest_path = _required_path("AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_EXPECTED_MANIFEST_PATH")
    output_path = _required_path("AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_OUTPUT_PATH")
    result_path = _required_path("AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_RESULT_PATH")
    try:
        plan = _validate_plan(json.loads(plan_path.read_text(encoding="utf-8")))
        result = realize(plan, expected_manifest_path, output_path)
        _write_json(result_path, result)
        print("AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except (GoldenPreviewError, corona.CoronaBaselineError) as error:
        result = {"status": "FAILED", "failureCode": error.code, "message": str(error)}
    except Exception as error:
        result = {"status": "FAILED", "failureCode": "CORONA_RENDER_FAILED", "message": f"{type(error).__name__}: {error}"}
    _write_json(result_path, result)
    print("AI_ARCHVIZ_GOLDEN_CORONA_PREVIEW_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
