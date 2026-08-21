"""Realize a trusted Corona execution plan for Technical Spike 8B.

The plan is structured data produced by the pure TypeScript adapter. This
runner owns Corona class/property discovery; it never evaluates generated code
or accepts renderer implementation details from the plan.
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

import build_scene as geometry_builder
import render_corona_baseline as corona
from pymxs import runtime as rt


RUNNER_VERSION = "0.1.0"
PLAN_VERSION = "0.1.0"
TARGET_DCC_MAJOR_VERSION = 2026
EXPECTED_RESOLUTION = {"width": 320, "height": 240}
EXPECTED_PASS_LIMIT = 4


class CoronaAdapterError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise CoronaAdapterError("TRUSTED_INPUT_MISSING", f"Missing worker-owned input {key}")
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


def _point(value: list[float]) -> Any:
    return rt.Point3(float(value[0]), float(value[1]), float(value[2]))


def _vector(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _normalized_name(value: Any) -> str:
    return corona._normalized_name(value)


def _class_name(value: Any) -> str:
    return corona._class_name(value)


def _force(code: str) -> bool:
    return os.environ.get("AI_ARCHVIZ_TEST_FORCE_CORONA_ADAPTER_FAILURE") == code


def _validate_plan(plan: Any) -> dict[str, Any]:
    if not isinstance(plan, dict):
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Execution plan must be an object")
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
    if set(plan) != expected_keys:
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Execution plan keys are not trusted")
    if plan["planVersion"] != PLAN_VERSION or plan["engine"] != "corona":
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Unsupported Corona execution plan")
    render = plan["render"]
    if not isinstance(render, dict) or render.get("mode") != "preview":
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Only preview plans are supported")
    if render.get("resolution") != EXPECTED_RESOLUTION:
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Plan resolution violates fixed policy")
    if render.get("termination") != {"type": "pass_limit", "value": EXPECTED_PASS_LIMIT}:
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Plan pass limit violates fixed policy")
    defaults = plan["adapterDefaults"]
    if defaults != {
        "material": {"roughness": 0.45, "nonMetalMode": True},
        "areaLight": {"widthMm": 800, "intensityScale": 120},
    }:
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Plan adapter defaults are unsupported")
    if not isinstance(plan["materials"], list) or not isinstance(plan["materialAssignments"], list):
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Plan material data is invalid")
    if not isinstance(plan["lights"], list) or len(plan["lights"]) == 0:
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Plan must contain area lights")
    if any(entry.get("type") != "area" for entry in plan["lights"] if isinstance(entry, dict)):
        raise CoronaAdapterError("RENDERER_LIGHT_TYPE_UNSUPPORTED", "Corona supports area lights only")
    if not isinstance(plan["camera"], dict) or not isinstance(plan["geometry"], dict):
        raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Plan camera or geometry is invalid")
    return plan


def _create_materials(plan: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if _force("material_missing"):
        raise CoronaAdapterError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Trusted test forced material absence")
    if _force("property_missing"):
        raise CoronaAdapterError(
            "CORONA_MATERIAL_PROPERTY_UNSUPPORTED", "Trusted test forced material property absence"
        )
    materials: dict[str, Any] = {}
    evidence: list[dict[str, Any]] = []
    for entry in plan["materials"]:
        material_id = str(entry["materialId"])
        if material_id in materials:
            raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", f"Duplicate plan material {material_id}")
        material, class_name = corona.create_corona_physical_material(
            entry["baseColorRgb"], f"AVZ_CORONA_{material_id}"
        )
        if "corona" not in _normalized_name(class_name) or "physical" not in _normalized_name(class_name):
            raise CoronaAdapterError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Created material is not Corona Physical")
        materials[material_id] = material
        evidence.append(
            {
                "materialId": material_id,
                "className": class_name,
                "canonicalBaseColorRgb": entry["baseColorRgb"],
                "materialInstanceName": str(material.name),
            }
        )
    return materials, sorted(evidence, key=lambda entry: entry["materialId"])


def _create_geometry(plan: dict[str, Any], materials: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    geometry = plan["geometry"]
    helpers: dict[str, Any] = {}
    logical_nodes: dict[str, Any] = {}
    opening_positions = {
        str(marker["logicalId"]): marker["position"] for marker in geometry["openingMarkers"]
    }
    for entry in geometry["nodes"]:
        entity_type = entry["type"]
        if entity_type in {"wall", "door_opening", "window_opening"}:
            node = geometry_builder._create_semantic_helper(
                entry, opening_positions.get(str(entry["logicalId"]))
            )
            helpers[str(entry["logicalId"])] = node
        elif entity_type in {"floor", "ceiling"}:
            node = geometry_builder._create_surface(entry)
        elif entity_type == "proxy_asset":
            node = geometry_builder._create_proxy(entry)
        else:
            raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Unsupported trusted geometry type")
        logical_nodes[str(entry["logicalId"])] = node

    materials_by_target: dict[str, Any] = {}
    assignments: list[dict[str, Any]] = []
    for assignment in plan["materialAssignments"]:
        target_id = str(assignment["targetId"])
        material_id = str(assignment["materialId"])
        if target_id in materials_by_target:
            raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Duplicate plan material target")
        node = logical_nodes.get(target_id)
        material = materials.get(material_id)
        if node is None or material is None:
            raise CoronaAdapterError("CORONA_EXECUTION_PLAN_INVALID", "Plan assignment cannot resolve")
        node.material = material
        rt.setUserProp(node, "AIArchViz.MaterialId", material_id)
        materials_by_target[target_id] = material

    geometry_builder._create_wall_segments(geometry, helpers, materials_by_target)
    for assignment in plan["materialAssignments"]:
        target_id = str(assignment["targetId"])
        material_id = str(assignment["materialId"])
        node = logical_nodes[target_id]
        material = materials[material_id]
        segments = [
            rt.getNodeByName(segment["name"])
            for segment in geometry["wallSegments"]
            if str(segment["hostLogicalId"]) == target_id
        ]
        observed_nodes = segments if segments else [node]
        observed_materials = [observed_node.material for observed_node in observed_nodes]
        if not observed_materials or any(
            not _same_material_instance(observed, material) for observed in observed_materials
        ):
            raise CoronaAdapterError(
                "CORONA_MATERIAL_ASSIGNMENT_FAILED", f"Material mismatch on {target_id}"
            )
        observed = observed_materials[0]
        class_name = _class_name(rt.classOf(observed))
        if "corona" not in _normalized_name(class_name) or "physical" not in _normalized_name(class_name):
            raise CoronaAdapterError("CORONA_MATERIAL_ASSIGNMENT_FAILED", f"Non-Corona material on {target_id}")
        assignments.append(
            {
                "targetId": target_id,
                "materialId": material_id,
                "materialInstanceName": str(observed.name),
                "className": class_name,
                "sharedMaterialInstance": True,
            }
        )
    return logical_nodes, sorted(assignments, key=lambda entry: entry["targetId"])


def _same_material_instance(left: Any, right: Any) -> bool:
    try:
        return int(rt.getHandleByAnim(left)) == int(rt.getHandleByAnim(right))
    except Exception:
        return str(left) == str(right) and str(left.name) == str(right.name)


def _create_lights(plan: dict[str, Any]) -> list[dict[str, Any]]:
    if _force("light_missing"):
        raise CoronaAdapterError("CORONA_LIGHT_CLASS_NOT_FOUND", "Trusted test forced CoronaLight absence")
    evidence: list[dict[str, Any]] = []
    for entry in plan["lights"]:
        light, class_name = corona.create_corona_area_light(
            entry["position"],
            entry["rotationEuler"],
            float(entry["mappedIntensity"]),
            float(entry["widthMm"]),
            f"AVZ_CORONA_{entry['logicalId']}",
        )
        if _normalized_name(class_name) != "coronalight":
            raise CoronaAdapterError("CORONA_LIGHT_CLASS_NOT_FOUND", "Actual light is not CoronaLight")
        actual_position = _vector(light.pos)
        expected_position = [float(value) for value in entry["position"]]
        if any(abs(actual - expected) > 0.001 for actual, expected in zip(actual_position, expected_position)):
            raise CoronaAdapterError("CORONA_LIGHT_ASSIGNMENT_FAILED", "CoronaLight position mismatch")
        evidence.append(
            {
                "logicalId": entry["logicalId"],
                "sceneSpecType": "area",
                "className": class_name,
                "position": entry["position"],
                "rotationEuler": entry["rotationEuler"],
                "canonicalIntensity": entry["canonicalIntensity"],
                "mappedIntensity": entry["mappedIntensity"],
                "widthMm": entry["widthMm"],
            }
        )
    return sorted(evidence, key=lambda entry: entry["logicalId"])


def _look_at_rotation(position: list[float], target: list[float]) -> tuple[float, float, float]:
    dx = float(target[0]) - float(position[0])
    dy = float(target[1]) - float(position[1])
    dz = float(target[2]) - float(position[2])
    horizontal = math.hypot(dx, dy)
    if horizontal == 0 and dz == 0:
        raise CoronaAdapterError("CAMERA_TARGET_INVALID", "Camera position and target must differ")
    pitch = math.degrees(math.atan2(dz, horizontal))
    yaw = (math.degrees(math.atan2(dy, dx)) + 270.0) % 360.0
    return pitch, 0.0, yaw


def _create_camera(plan: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    entry = plan["camera"]
    position = entry["position"]
    target = entry["target"]
    camera = rt.Freecamera()
    camera.name = f"AVZ_CORONA_{entry['logicalId']}"
    rotation = _look_at_rotation(position, target)
    camera.rotation = rt.EulerAngles(*rotation)
    camera.pos = _point(position)
    camera.fov = float(entry["fovRadians"])
    actual_class = _class_name(rt.classOf(camera))
    actual_position = _vector(camera.pos)
    if any(abs(left - float(right)) > 0.001 for left, right in zip(actual_position, position)):
        raise CoronaAdapterError("CAMERA_REALIZATION_FAILED", "Camera position mismatch")
    if abs(float(camera.fov) - float(entry["fovRadians"])) > 0.000001:
        raise CoronaAdapterError("CAMERA_REALIZATION_FAILED", "Camera FOV mismatch")
    return camera, {
        "logicalId": entry["logicalId"],
        "className": actual_class,
        "position": entry["position"],
        "target": target,
        "focalLengthMm": entry["focalLengthMm"],
        "sensorWidthMm": entry["sensorWidthMm"],
        "fovRadians": entry["fovRadians"],
        "lookAtTarget": True,
    }


def _render(camera: Any, output_path: Path, plan: dict[str, Any]) -> None:
    render = plan["render"]
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
            raise CoronaAdapterError("CORONA_LICENSE_UNAVAILABLE", "Corona rendering requires an unavailable license") from error
        raise CoronaAdapterError("CORONA_RENDER_FAILED", "Corona production render failed") from error
    if _force("png_invalid") and output_path.exists():
        output_path.unlink()
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise CoronaAdapterError("RENDER_OUTPUT_INVALID", "Corona did not create a non-empty PNG")


def realize(plan: dict[str, Any], output_path: Path) -> dict[str, Any]:
    if _force("timeout"):
        time.sleep(300)
    if _force("renderer_missing"):
        raise CoronaAdapterError("CORONA_NOT_FOUND", "Trusted test forced renderer absence")
    if _force("safe_scene"):
        raise CoronaAdapterError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")

    rt.resetMaxFile(rt.Name("noPrompt"))
    corona._require_safe_scene()
    corona._normalize_units()
    renderer_class, discovered_class = corona._discover_corona_renderer()
    _renderer, observed_renderer_class, plugin_version = corona._configure_renderer(renderer_class)
    if _normalized_name(discovered_class) != _normalized_name(observed_renderer_class):
        raise CoronaAdapterError("CORONA_RENDERER_ASSIGNMENT_FAILED", "Production renderer identity changed")
    materials, material_evidence = _create_materials(plan)
    _logical_nodes, assignment_evidence = _create_geometry(plan, materials)
    light_evidence = _create_lights(plan)
    camera, camera_evidence = _create_camera(plan)
    _render(camera, output_path, plan)

    result = {
        "status": "PASS",
        "runnerVersion": RUNNER_VERSION,
        "renderer": {"className": observed_renderer_class, "version": plugin_version},
        "dcc": {
            "version": corona._runtime_version(),
            "compatibilityMode": corona._runtime_major_version() != TARGET_DCC_MAJOR_VERSION,
        },
        "materials": material_evidence,
        "materialAssignments": assignment_evidence,
        "lights": light_evidence,
        "camera": camera_evidence,
        "render": plan["render"],
        "adapterDefaults": plan["adapterDefaults"],
    }
    if _force("invalid_evidence"):
        result["materials"] = []
    return result


def main() -> int:
    plan_path = _required_path("AI_ARCHVIZ_CORONA_ADAPTER_PLAN_PATH")
    output_path = _required_path("AI_ARCHVIZ_CORONA_ADAPTER_OUTPUT_PATH")
    result_path = _required_path("AI_ARCHVIZ_CORONA_ADAPTER_RESULT_PATH")
    try:
        plan = _validate_plan(json.loads(plan_path.read_text(encoding="utf-8")))
        result = realize(plan, output_path)
        _write_json(result_path, result)
        print("AI_ARCHVIZ_CORONA_ADAPTER_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except (CoronaAdapterError, corona.CoronaBaselineError) as error:
        result = {"status": "FAILED", "failureCode": error.code, "message": str(error)}
    except Exception as error:
        result = {
            "status": "FAILED",
            "failureCode": "CORONA_RENDER_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
    _write_json(result_path, result)
    print("AI_ARCHVIZ_CORONA_ADAPTER_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
