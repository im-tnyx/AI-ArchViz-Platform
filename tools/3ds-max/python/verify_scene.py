"""Fresh-process semantic verifier for the Spike 1B candidate scene."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from pymxs import runtime as rt


VERIFY_VERSION = "0.1.0"
TOLERANCE = 0.01


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


def _user_prop(node: Any, key: str) -> str | None:
    value = rt.getUserProp(node, key)
    if value is None:
        return None
    return str(value)


def _close(left: float, right: float, tolerance: float = TOLERANCE) -> bool:
    return abs(float(left) - float(right)) <= tolerance


def _vector(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _check_vector(errors: list[str], label: str, expected: list[float], actual: list[float]) -> None:
    if len(expected) != len(actual) or any(
        not _close(expected[index], actual[index]) for index in range(len(expected))
    ):
        errors.append(f"{label}: expected {expected}, actual {actual}")


def _angle_close(left: float, right: float, tolerance: float = 0.001) -> bool:
    difference = (float(left) - float(right) + 180.0) % 360.0 - 180.0
    return abs(difference) <= tolerance


def _euler(node: Any) -> list[float]:
    value = rt.quatToEuler(node.rotation)
    return [float(value.x), float(value.y), float(value.z)]


def _check_rotation(errors: list[str], label: str, expected: list[float], actual: list[float]) -> None:
    if len(expected) != len(actual) or any(
        not _angle_close(expected[index], actual[index]) for index in range(len(expected))
    ):
        errors.append(f"{label}: expected {expected}, actual {actual}")


def _normalized_material_color(material: Any) -> list[float] | None:
    try:
        color = material.diffuse
        return [float(color.r) / 255.0, float(color.g) / 255.0, float(color.b) / 255.0]
    except Exception:
        return None


def _validate_material(
    node: Any,
    entry: dict[str, Any],
    errors: list[str],
    recover_manifest_state: bool,
    require_native_material: bool = True,
) -> None:
    expected_id = entry.get("materialId")
    expected_color = entry.get("materialBaseColorRgb")
    node_id = _user_prop(node, "AIArchViz.MaterialId")
    if expected_id is None:
        if node_id is not None:
            errors.append(f"{entry['logicalId']}: MATERIAL_ASSIGNMENT_MISMATCH unexpected {node_id}")
        return
    if not node_id:
        errors.append(f"{entry['logicalId']}: MATERIAL_ID_MISSING")
        return
    if node_id != str(expected_id):
        errors.append(
            f"{entry['logicalId']}: MATERIAL_ASSIGNMENT_MISMATCH expected {expected_id}, actual {node_id}"
        )
        return
    if not require_native_material:
        return
    material = node.material
    if material is None:
        errors.append(f"{entry['logicalId']}: MATERIAL_ASSIGNMENT_MISMATCH no native material")
        return
    if str(material.name) != f"AVZ_MATERIAL_{expected_id}":
        errors.append(
            f"{entry['logicalId']}: MATERIAL_ASSIGNMENT_MISMATCH native {material.name}"
        )
        return
    actual_color = _normalized_material_color(material)
    if actual_color is None:
        errors.append(f"{entry['logicalId']}: MATERIAL_COLOR_MISMATCH unreadable native color")
        return
    if not isinstance(expected_color, list):
        errors.append(f"{entry['logicalId']}: MATERIAL_COLOR_MISMATCH expected color missing")
        return
    _check_vector(
        errors,
        f"{entry['logicalId']}: MATERIAL_COLOR_MISMATCH",
        expected_color,
        actual_color,
    )
    if recover_manifest_state:
        entry["materialId"] = node_id
        entry["materialBaseColorRgb"] = actual_color


def _validate_metadata(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    if str(node.name) != entry["nodeName"]:
        errors.append(f"{entry['logicalId']}: node name mismatch")
    for key, expected in entry["embeddedMetadata"].items():
        actual = _user_prop(node, key)
        if actual != str(expected):
            errors.append(f"{entry['logicalId']}: metadata {key} mismatch")


def _validate_proxy(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    if str(rt.classOf(node)).lower() != "box":
        errors.append(f"{entry['logicalId']}: proxy is not a Box")
        return
    _check_vector(
        errors,
        f"{entry['logicalId']}.dimensions",
        entry["dimensions"],
        [float(node.width), float(node.length), float(node.height)],
    )
    _check_vector(
        errors,
        f"{entry['logicalId']}.position",
        entry["transform"]["position"],
        _vector(node.pos),
    )
    _check_rotation(
        errors,
        f"{entry['logicalId']}.rotationEuler",
        entry["transform"]["rotationEuler"],
        _euler(node),
    )


def _validate_surface(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    if str(rt.classOf(node)).lower() != "plane":
        errors.append(f"{entry['logicalId']}: surface is not a Plane")
        return
    expected = entry["dimensions"]
    _check_vector(
        errors,
        f"{entry['logicalId']}.dimensions",
        expected[:2],
        [float(node.width), float(node.length)],
    )
    if not _close(node.pos.z, entry["transform"]["position"][2]):
        errors.append(f"{entry['logicalId']}: elevation mismatch")
    _check_vector(
        errors,
        f"{entry['logicalId']}.physicalPosition",
        [
            float(entry["transform"]["position"][0]) + float(expected[0]) / 2.0,
            float(entry["transform"]["position"][1]) + float(expected[1]) / 2.0,
            float(entry["transform"]["position"][2]),
        ],
        _vector(node.pos),
    )


def _validate_wall(node: Any, entry: dict[str, Any], all_nodes: list[Any], errors: list[str]) -> None:
    segments = [
        candidate
        for candidate in all_nodes
        if _user_prop(candidate, "AIArchViz.HostLogicalId") == entry["logicalId"]
    ]
    if not segments:
        errors.append(f"{entry['logicalId']}: no physical wall segments")
        return
    for index, segment in enumerate(segments):
        _validate_material(segment, entry, errors, index == 0)
        if str(rt.classOf(segment)).lower() != "box":
            errors.append(f"{entry['logicalId']}: physical segment is not a Box")
            continue
        expected_dimensions_value = _user_prop(segment, "AIArchViz.SegmentDimensions")
        if not expected_dimensions_value:
            errors.append(f"{entry['logicalId']}: segment dimensions metadata missing")
            continue
        expected_dimensions = json.loads(expected_dimensions_value)
        _check_vector(
            errors,
            f"{segment.name}.dimensions",
            expected_dimensions,
            [float(segment.width), float(segment.length), float(segment.height)],
        )
        expected_center_value = _user_prop(segment, "AIArchViz.SegmentCenter")
        expected_rotation_value = _user_prop(segment, "AIArchViz.SegmentRotationZ")
        if not expected_center_value or expected_rotation_value is None:
            errors.append(f"{entry['logicalId']}: segment transform metadata missing")
            continue
        _check_vector(
            errors,
            f"{segment.name}.position",
            json.loads(expected_center_value),
            _vector(segment.pos),
        )
        _check_rotation(
            errors,
            f"{segment.name}.rotationEuler",
            [0.0, 0.0, float(expected_rotation_value)],
            _euler(segment),
        )


def _validate_opening(
    node: Any,
    entry: dict[str, Any],
    managed_ids: set[str],
    errors: list[str],
) -> None:
    host = entry.get("hostGeometryId")
    if not host or host not in managed_ids:
        errors.append(f"{entry['logicalId']}: host wall is missing")
    if str(rt.classOf(node)).lower() != "dummy":
        errors.append(f"{entry['logicalId']}: opening semantic node is not a Dummy")
    expected_position_value = _user_prop(node, "AIArchViz.PhysicalPosition")
    if not expected_position_value:
        errors.append(f"{entry['logicalId']}: physical opening position is missing")
    else:
        _check_vector(
            errors,
            f"{entry['logicalId']}.physicalPosition",
            json.loads(expected_position_value),
            _vector(node.pos),
        )


def _validate_camera(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    if "camera" not in str(rt.superClassOf(node)).lower():
        errors.append(f"{entry['logicalId']}: node is not a Camera")
        return
    _check_vector(
        errors,
        f"{entry['logicalId']}.position",
        entry["transform"]["position"],
        _vector(node.pos),
    )
    _check_rotation(
        errors,
        f"{entry['logicalId']}.rotationEuler",
        entry["transform"]["rotationEuler"],
        _euler(node),
    )
    focal_length = float(entry["sensorWidthMm"]) / (2.0 * float(rt.tan(node.fov / 2.0)))
    if not _close(focal_length, entry["focalLengthMm"]):
        errors.append(
            f"{entry['logicalId']}: focal length expected {entry['focalLengthMm']}, actual {focal_length}"
        )


def verify() -> tuple[dict[str, Any], dict[str, Any]]:
    candidate_path = _required_path("AI_ARCHVIZ_CANDIDATE_PATH")
    manifest_path = _required_path("AI_ARCHVIZ_MANIFEST_PATH")
    result_path = _required_path("AI_ARCHVIZ_VERIFY_RESULT_PATH")
    if not candidate_path.exists() or candidate_path.stat().st_size <= 0:
        raise RuntimeError("Candidate scene is missing or empty")
    # Adopt the unit scale stored in the candidate for this process only. Autodesk
    # documents that useFileUnits=True does not persist the setting to 3dsmax.ini.
    if not rt.loadMaxFile(str(candidate_path), useFileUnits=True, quiet=True):
        raise RuntimeError("Fresh process could not load candidate scene")
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_VERIFICATION_FAILURE") == "1":
        raise RuntimeError("TRUSTED_TEST_FORCED_VERIFICATION_FAILURE")
    if "millimeter" not in str(rt.units.SystemType).lower() or not _close(rt.units.SystemScale, 1.0):
        raise RuntimeError(
            f"UNIT_MISMATCH: {rt.units.SystemType} at scale {rt.units.SystemScale}"
        )

    all_nodes = list(rt.objects)
    managed_nodes = [
        node for node in all_nodes if (_user_prop(node, "AIArchViz.Managed") or "").lower() == "true"
    ]
    entries: list[tuple[Any, dict[str, Any]]] = []
    errors: list[str] = []
    for node in managed_nodes:
        raw_entry = _user_prop(node, "AIArchViz.ManifestEntry")
        if not raw_entry:
            errors.append(f"{node.name}: LOGICAL_ID_MISSING")
            continue
        entry = json.loads(raw_entry)
        entries.append((node, entry))
    managed_ids = {entry["logicalId"] for _, entry in entries}

    nodes: list[dict[str, Any]] = []
    cameras: list[dict[str, Any]] = []
    for node, entry in entries:
        _validate_metadata(node, entry, errors)
        entity_type = entry.get("type") or _user_prop(node, "AIArchViz.EntityType")
        if entity_type == "camera":
            _validate_camera(node, entry, errors)
            cameras.append(entry)
        else:
            if entity_type == "proxy_asset":
                _validate_material(node, entry, errors, True)
                _validate_proxy(node, entry, errors)
            elif entity_type in {"floor", "ceiling"}:
                _validate_material(node, entry, errors, True)
                _validate_surface(node, entry, errors)
            elif entity_type == "wall":
                _validate_material(node, entry, errors, False, False)
                _validate_wall(node, entry, all_nodes, errors)
            elif entity_type in {"door_opening", "window_opening"}:
                _validate_material(node, entry, errors, True)
                _validate_opening(node, entry, managed_ids, errors)
            else:
                errors.append(f"{entry.get('logicalId')}: unsupported managed entity type")
            nodes.append(entry)

    nodes.sort(key=lambda entry: entry["logicalId"])
    cameras.sort(key=lambda entry: entry["logicalId"])
    if not entries:
        raise RuntimeError("No managed nodes found after fresh reopen")
    first_metadata = entries[0][1]["embeddedMetadata"]
    manifest = {
        "manifestVersion": "0.1.0",
        "projectId": first_metadata["AIArchViz.ProjectId"],
        "sceneId": first_metadata["AIArchViz.SceneId"],
        "revisionId": first_metadata["AIArchViz.RevisionId"],
        "coordinateSystem": {
            "linearUnit": "mm",
            "angularUnit": "degree",
            "upAxis": "Z",
            "handedness": "right",
        },
        "nodes": nodes,
        "cameras": cameras,
    }
    if errors:
        raise RuntimeError("; ".join(sorted(errors)))
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_MANIFEST_MISMATCH") == "1":
        manifest["revisionId"] = "rev_forced_manifest_mismatch"
    _write_json(manifest_path, manifest)
    result = {
        "verificationVersion": VERIFY_VERSION,
        "status": "SUCCESS",
        "candidatePath": str(candidate_path),
        "manifestPath": str(manifest_path),
        "managedNodeCount": len(nodes) + len(cameras),
        "semanticNodeCount": len(nodes),
        "cameraCount": len(cameras),
        "units": {
            "systemType": str(rt.units.SystemType),
            "systemScale": float(rt.units.SystemScale),
            "displayType": str(rt.units.DisplayType),
        },
    }
    _write_json(result_path, result)
    return manifest, result


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_VERIFY_RESULT_PATH")
    try:
        _, result = verify()
        print("AI_ARCHVIZ_VERIFY_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        result = {
            "verificationVersion": VERIFY_VERSION,
            "status": "FAILED",
            "errorCode": "VERIFICATION_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_VERIFY_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
