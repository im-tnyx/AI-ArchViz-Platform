"""Build the deterministic Spike 1B scene from a trusted intermediate plan."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from pymxs import runtime as rt


BUILD_VERSION = "0.1.0"


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Missing trusted environment value: {key}")
    return Path(value)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def _point(value: list[float]) -> Any:
    return rt.Point3(float(value[0]), float(value[1]), float(value[2]))


def _user_prop(value: Any, key: str) -> str | None:
    result = rt.getUserProp(value, key)
    return str(result) if result is not None else None


def _set_metadata(node: Any, entry: dict[str, Any], entity_type: str) -> None:
    rt.setUserProp(node, "AIArchViz.Managed", "true")
    rt.setUserProp(node, "AIArchViz.EntityType", entity_type)
    for key, value in entry["embeddedMetadata"].items():
        rt.setUserProp(node, key, str(value))
    rt.setUserProp(
        node,
        "AIArchViz.ManifestEntry",
        json.dumps(entry, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
    )


def _native_color(value: list[float]) -> Any:
    return rt.Color(
        int(round(float(value[0]) * 255.0)),
        int(round(float(value[1]) * 255.0)),
        int(round(float(value[2]) * 255.0)),
    )


def _create_native_materials(plan: dict[str, Any]) -> dict[str, Any]:
    materials: dict[str, Any] = {}
    for entry in plan["materials"]:
        material_id = str(entry["id"])
        if material_id in materials:
            raise RuntimeError(f"Duplicate trusted material ID: {material_id}")
        material = rt.StandardMaterial()
        material.name = f"AVZ_MATERIAL_{material_id}"
        material.diffuse = _native_color(entry["baseColorRgb"])
        materials[material_id] = material
    return materials


def _assign_native_material(node: Any, material: Any, material_id: str) -> None:
    node.material = material
    rt.setUserProp(node, "AIArchViz.MaterialId", material_id)


def _normalize_units() -> None:
    rt.units.SystemType = rt.Name("millimeters")
    rt.units.SystemScale = 1.0
    rt.units.DisplayType = rt.Name("metric")
    try:
        rt.units.MetricType = rt.Name("millimeters")
    except Exception:
        # System units are authoritative. Metric display subtype is UI-only and
        # differs slightly between 3ds Max releases.
        pass
    if "millimeter" not in str(rt.units.SystemType).lower():
        raise RuntimeError(f"Failed to normalize system units: {rt.units.SystemType}")


def _create_semantic_helper(
    entry: dict[str, Any], physical_position: list[float] | None = None
) -> Any:
    helper = rt.Dummy()
    helper.name = entry["nodeName"]
    helper.boxsize = rt.Point3(50.0, 50.0, 50.0)
    helper.pos = _point(physical_position) if physical_position else rt.Point3(0.0, 0.0, 0.0)
    if physical_position:
        rt.setUserProp(
            helper,
            "AIArchViz.PhysicalPosition",
            json.dumps(physical_position, separators=(",", ":")),
        )
    _set_metadata(helper, entry, entry["type"])
    return helper


def _create_surface(entry: dict[str, Any]) -> Any:
    width, length, _ = entry["dimensions"]
    semantic_position = entry["transform"]["position"]
    node = rt.Plane(
        width=float(width),
        length=float(length),
        widthsegs=1,
        lengthsegs=1,
    )
    node.name = entry["nodeName"]
    node.pos = rt.Point3(
        float(semantic_position[0]) + float(width) / 2.0,
        float(semantic_position[1]) + float(length) / 2.0,
        float(semantic_position[2]),
    )
    _set_metadata(node, entry, entry["type"])
    return node


def _create_proxy(entry: dict[str, Any]) -> Any:
    width, length, height = entry["dimensions"]
    transform = entry["transform"]
    node = rt.Box(width=float(width), length=float(length), height=float(height))
    node.name = entry["nodeName"]
    rotation = transform["rotationEuler"]
    node.rotation = rt.EulerAngles(float(rotation[0]), float(rotation[1]), float(rotation[2]))
    node.scale = _point(transform["scale"])
    node.pos = _point(transform["position"])
    _set_metadata(node, entry, entry["type"])
    return node


def _create_wall_segments(
    plan: dict[str, Any], helpers: dict[str, Any], materials_by_target: dict[str, Any]
) -> int:
    created = 0
    for segment in plan["wallSegments"]:
        width, length, height = segment["dimensions"]
        node = rt.Box(width=float(width), length=float(length), height=float(height))
        node.name = segment["name"]
        node.rotation = rt.EulerAngles(0.0, 0.0, float(segment["rotationZ"]))
        node.pos = _point(segment["center"])
        node.parent = helpers[segment["hostLogicalId"]]
        material = materials_by_target.get(str(segment["hostLogicalId"]))
        if material is not None:
            material_id = _user_prop(helpers[segment["hostLogicalId"]], "AIArchViz.MaterialId")
            if not material_id:
                raise RuntimeError(
                    f"Wall helper material identity is missing: {segment['hostLogicalId']}"
                )
            _assign_native_material(
                node,
                material,
                material_id,
            )
        rt.setUserProp(node, "AIArchViz.HostLogicalId", segment["hostLogicalId"])
        rt.setUserProp(
            node,
            "AIArchViz.SegmentDimensions",
            json.dumps(segment["dimensions"], separators=(",", ":")),
        )
        rt.setUserProp(
            node,
            "AIArchViz.SegmentCenter",
            json.dumps(segment["center"], separators=(",", ":")),
        )
        rt.setUserProp(node, "AIArchViz.SegmentRotationZ", str(segment["rotationZ"]))
        created += 1
    return created


def _create_camera(entry: dict[str, Any]) -> Any:
    camera = rt.Freecamera()
    camera.name = entry["nodeName"]
    target = _point(entry["target"])
    rotation = entry["transform"]["rotationEuler"]
    camera.rotation = rt.EulerAngles(
        float(rotation[0]), float(rotation[1]), float(rotation[2])
    )
    camera.pos = _point(entry["transform"]["position"])
    camera.targetDistance = rt.distance(camera.pos, target)
    camera.fov = 2.0 * rt.atan(float(entry["sensorWidthMm"]) / (2.0 * float(entry["focalLengthMm"])))
    _set_metadata(camera, entry, "camera")
    return camera


def build() -> dict[str, Any]:
    plan_path = _required_path("AI_ARCHVIZ_BUILD_PLAN_PATH")
    candidate_path = _required_path("AI_ARCHVIZ_CANDIDATE_PATH")
    result_path = _required_path("AI_ARCHVIZ_BUILD_RESULT_PATH")
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_DCC_TIMEOUT") == "1":
        time.sleep(300)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("buildPlanVersion") != BUILD_VERSION:
        raise RuntimeError("Unsupported build plan version")

    rt.resetMaxFile(rt.Name("noPrompt"))
    _normalize_units()
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_BUILD_FAILURE") == "1":
        raise RuntimeError("TRUSTED_TEST_FORCED_BUILD_FAILURE")

    materials = _create_native_materials(plan)
    materials_by_target: dict[str, Any] = {}
    for assignment in plan["materialAssignments"]:
        target_id = str(assignment["targetId"])
        material_id = str(assignment["materialId"])
        if target_id in materials_by_target:
            raise RuntimeError(f"Duplicate trusted material assignment target: {target_id}")
        material = materials.get(material_id)
        if material is None:
            raise RuntimeError(f"Missing trusted material: {material_id}")
        materials_by_target[target_id] = material

    helpers: dict[str, Any] = {}
    logical_nodes: dict[str, Any] = {}
    opening_positions = {
        marker["logicalId"]: marker["position"] for marker in plan["openingMarkers"]
    }
    for entry in plan["nodes"]:
        entity_type = entry["type"]
        if entity_type in {"wall", "door_opening", "window_opening"}:
            node = _create_semantic_helper(entry, opening_positions.get(entry["logicalId"]))
            helpers[entry["logicalId"]] = node
        elif entity_type in {"floor", "ceiling"}:
            node = _create_surface(entry)
        elif entity_type == "proxy_asset":
            node = _create_proxy(entry)
        else:
            raise RuntimeError(f"Unsupported build-plan node type: {entity_type}")
        logical_nodes[str(entry["logicalId"])] = node

    for target_id, material in materials_by_target.items():
        node = logical_nodes.get(target_id)
        if node is None:
            raise RuntimeError(f"Material assignment target is missing: {target_id}")
        material_id = str(
            next(
                assignment["materialId"]
                for assignment in plan["materialAssignments"]
                if str(assignment["targetId"]) == target_id
            )
        )
        _assign_native_material(node, material, material_id)

    wall_segment_count = _create_wall_segments(plan, helpers, materials_by_target)
    for entry in plan["cameras"]:
        _create_camera(entry)

    candidate_path.parent.mkdir(parents=True, exist_ok=True)
    if not rt.saveMaxFile(str(candidate_path), useNewFile=True, quiet=True):
        raise RuntimeError("3ds Max did not save the candidate scene")
    if not candidate_path.exists() or candidate_path.stat().st_size <= 0:
        raise RuntimeError("Candidate scene is missing or empty after save")

    result = {
        "buildVersion": BUILD_VERSION,
        "status": "SUCCESS",
        "candidatePath": str(candidate_path),
        "candidateSizeBytes": candidate_path.stat().st_size,
        "managedNodeCount": len(plan["nodes"]) + len(plan["cameras"]),
        "wallSegmentCount": wall_segment_count,
        "nativeMaterialCount": len(materials),
        "materialAssignmentCount": len(materials_by_target),
        "units": {
            "systemType": str(rt.units.SystemType),
            "systemScale": float(rt.units.SystemScale),
            "displayType": str(rt.units.DisplayType),
        },
    }
    _write_json(result_path, result)
    return result


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_BUILD_RESULT_PATH")
    try:
        result = build()
        print("AI_ARCHVIZ_BUILD_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        result = {
            "buildVersion": BUILD_VERSION,
            "status": "FAILED",
            "errorCode": "BUILD_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_BUILD_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
