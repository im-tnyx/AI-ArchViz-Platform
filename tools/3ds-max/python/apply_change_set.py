"""Apply one trusted deterministic revision to an isolated verified scene copy."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from pymxs import runtime as rt


REVISION_RUNNER_VERSION = "0.1.0"


class MutationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise MutationError("TRUSTED_INPUT_MISSING", f"Missing trusted environment value: {key}")
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
    return str(value) if value is not None else None


def _point(value: list[float]) -> Any:
    return rt.Point3(float(value[0]), float(value[1]), float(value[2]))


def _create_wall_segment(
    segment: dict[str, Any], host: Any, material: Any, material_id: str
) -> Any:
    width, length, height = segment["dimensions"]
    node = rt.Box(width=float(width), length=float(length), height=float(height))
    node.name = str(segment["name"])
    node.rotation = rt.EulerAngles(0.0, 0.0, float(segment["rotationZ"]))
    node.pos = _point(segment["center"])
    node.parent = host
    node.material = material
    rt.setUserProp(node, "AIArchViz.MaterialId", material_id)
    rt.setUserProp(node, "AIArchViz.HostLogicalId", str(segment["hostLogicalId"]))
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
    return node


def _segment_signature(node: Any) -> tuple[Any, ...]:
    return (
        int(node.handle),
        str(node.name),
        _user_prop(node, "AIArchViz.HostLogicalId"),
        _user_prop(node, "AIArchViz.SegmentDimensions"),
        _user_prop(node, "AIArchViz.SegmentCenter"),
        _user_prop(node, "AIArchViz.SegmentRotationZ"),
    )


def _segment_geometry_signature(node: Any) -> tuple[Any, ...]:
    rotation = rt.quatToEuler(node.rotation)
    return (
        str(node.name),
        _user_prop(node, "AIArchViz.HostLogicalId"),
        float(node.width),
        float(node.length),
        float(node.height),
        float(node.pos.x),
        float(node.pos.y),
        float(node.pos.z),
        float(rotation.x),
        float(rotation.y),
        float(rotation.z),
        _user_prop(node, "AIArchViz.SegmentDimensions"),
        _user_prop(node, "AIArchViz.SegmentCenter"),
        _user_prop(node, "AIArchViz.SegmentRotationZ"),
    )


def _normalized_material_color(material: Any) -> list[float] | None:
    try:
        color = material.diffuse
        return [float(color.r) / 255.0, float(color.g) / 255.0, float(color.b) / 255.0]
    except Exception:
        return None


def _same_color(left: list[float] | None, right: list[float]) -> bool:
    return left is not None and len(left) == 3 and all(
        abs(float(left[index]) - float(right[index])) <= 0.01 for index in range(3)
    )


def _find_existing_material(material: dict[str, Any], all_nodes: list[Any]) -> Any:
    material_id = str(material["id"])
    expected_name = f"AVZ_MATERIAL_{material_id}"
    expected_color = [float(channel) for channel in material["baseColorRgb"]]
    candidates = [
        node.material
        for node in all_nodes
        if _user_prop(node, "AIArchViz.MaterialId") == material_id
        and node.material is not None
        and str(node.material.name) == expected_name
    ]
    if not candidates:
        raise MutationError(
            "MATERIAL_NOT_FOUND",
            f"Native material {material_id} was not found in the verified base scene",
        )
    native = candidates[0]
    if "standard" not in str(rt.classOf(native)).lower():
        raise MutationError(
            "MATERIAL_TYPE_MISMATCH",
            f"Native material {material_id} is not a StandardMaterial",
        )
    if not _same_color(_normalized_material_color(native), expected_color):
        raise MutationError(
            "MATERIAL_COLOR_MISMATCH",
            f"Native material {material_id} does not match the trusted canonical color",
        )
    return native


def _wall_material_signature(node: Any) -> tuple[Any, ...]:
    material = node.material
    return (
        _user_prop(node, "AIArchViz.HostLogicalId"),
        _user_prop(node, "AIArchViz.MaterialId"),
        str(material.name) if material is not None else None,
        tuple(_normalized_material_color(material) or []) if material is not None else None,
    )


def apply_revision() -> dict[str, Any]:
    base_path = _required_path("AI_ARCHVIZ_BASE_SCENE_PATH")
    candidate_path = _required_path("AI_ARCHVIZ_CANDIDATE_PATH")
    plan_path = _required_path("AI_ARCHVIZ_REVISION_PLAN_PATH")
    result_path = _required_path("AI_ARCHVIZ_MUTATION_RESULT_PATH")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("revisionPlanVersion") != REVISION_RUNNER_VERSION:
        raise MutationError("REVISION_PLAN_UNSUPPORTED", "Unsupported revision plan version")
    operation = plan.get("operation")
    if not isinstance(operation, dict) or operation.get("type") not in {
        "MoveObject",
        "UpdateOpening",
        "AssignMaterial",
    }:
        raise MutationError(
            "OPERATION_UNSUPPORTED",
            "Runner supports MoveObject, UpdateOpening, and AssignMaterial only",
        )
    if not base_path.exists() or base_path.stat().st_size <= 0:
        raise MutationError("BASE_ARTIFACT_MISSING", "Verified base checkpoint is missing")
    if not rt.loadMaxFile(str(base_path), useFileUnits=True, quiet=True):
        raise MutationError("BASE_ARTIFACT_OPEN_FAILED", "Could not open verified base checkpoint")
    if "millimeter" not in str(rt.units.SystemType).lower() or float(rt.units.SystemScale) != 1.0:
        raise MutationError("UNIT_MISMATCH", "Base checkpoint is not in canonical millimeters")

    managed_nodes = [
        node
        for node in list(rt.objects)
        if (_user_prop(node, "AIArchViz.Managed") or "").lower() == "true"
    ]
    logical_nodes: dict[str, list[Any]] = {}
    for node in managed_nodes:
        logical_id = _user_prop(node, "AIArchViz.LogicalObjectId")
        if not logical_id:
            raise MutationError("LOGICAL_ID_MISSING", f"Managed node {node.name} has no logical ID")
        logical_nodes.setdefault(logical_id, []).append(node)

    expected_ids = sorted(str(value) for value in plan["expectedManagedLogicalIds"])
    actual_ids = sorted(logical_nodes.keys())
    if expected_ids != actual_ids:
        raise MutationError(
            "MANAGED_ID_SET_MISMATCH",
            f"Expected managed IDs {expected_ids}, actual {actual_ids}",
        )
    duplicates = sorted(key for key, values in logical_nodes.items() if len(values) > 1)
    if duplicates:
        raise MutationError("DUPLICATE_LOGICAL_ID", f"Duplicate managed logical IDs: {duplicates}")

    target_id = str(operation["targetId"])
    targets = logical_nodes.get(target_id, [])
    if not targets:
        raise MutationError("TARGET_NOT_FOUND", f"Target {target_id} was not found")
    if len(targets) > 1:
        raise MutationError("DUPLICATE_LOGICAL_ID", f"Target {target_id} is not unique")
    target = targets[0]
    rebuilt_host_id: str | None = None
    deleted_segment_count = 0
    created_segment_count = 0
    preserved_segment_count = 0
    assigned_material_id: str | None = None
    assigned_wall_segment_count = 0
    if operation["type"] == "MoveObject":
        transform = operation["transform"]
        target.pos = _point(transform["position"])
        rotation = transform["rotationEuler"]
        target.rotation = rt.EulerAngles(
            float(rotation[0]),
            float(rotation[1]),
            float(rotation[2]),
        )
        target.scale = _point(transform["scale"])
    elif operation["type"] == "UpdateOpening":
        rebuilt_host_id = str(operation["hostLogicalId"])
        hosts = logical_nodes.get(rebuilt_host_id, [])
        if not hosts:
            raise MutationError("HOST_NOT_FOUND", f"Host {rebuilt_host_id} was not found")
        if len(hosts) > 1:
            raise MutationError(
                "DUPLICATE_LOGICAL_ID", f"Host {rebuilt_host_id} is not unique"
            )
        host = hosts[0]
        host_material_id = _user_prop(host, "AIArchViz.MaterialId")
        if not host_material_id:
            raise MutationError(
                "MATERIAL_ID_MISSING", f"Host {rebuilt_host_id} has no canonical material ID"
            )
        segments = [
            node
            for node in list(rt.objects)
            if _user_prop(node, "AIArchViz.HostLogicalId") == rebuilt_host_id
        ]
        if not segments:
            raise MutationError(
                "MATERIAL_ASSIGNMENT_MISMATCH",
                f"Host {rebuilt_host_id} has no physical segments to preserve",
            )
        host_material = segments[0].material
        if host_material is None or str(host_material.name) != f"AVZ_MATERIAL_{host_material_id}":
            raise MutationError(
                "MATERIAL_ASSIGNMENT_MISMATCH",
                f"Host {rebuilt_host_id} native material disagrees with canonical material ID",
            )
        for segment in segments:
            if (
                _user_prop(segment, "AIArchViz.MaterialId") != host_material_id
                or segment.material is None
                or str(segment.material.name) != f"AVZ_MATERIAL_{host_material_id}"
            ):
                raise MutationError(
                    "MATERIAL_ASSIGNMENT_MISMATCH",
                    f"Host {rebuilt_host_id} physical segment material disagrees with canonical material ID",
                )
        unrelated_before = sorted(
            _segment_signature(node)
            for node in list(rt.objects)
            if _user_prop(node, "AIArchViz.HostLogicalId")
            and _user_prop(node, "AIArchViz.HostLogicalId") != rebuilt_host_id
        )
        deleted_segment_count = len(segments)
        for segment in segments:
            rt.delete(segment)
        for segment in operation["wallSegments"]:
            if str(segment["hostLogicalId"]) != rebuilt_host_id:
                raise MutationError(
                    "REVISION_PLAN_INVALID", "Plan contains an unrelated wall segment"
                )
            _create_wall_segment(segment, host, host_material, host_material_id)
            created_segment_count += 1
        unrelated_after = sorted(
            _segment_signature(node)
            for node in list(rt.objects)
            if _user_prop(node, "AIArchViz.HostLogicalId")
            and _user_prop(node, "AIArchViz.HostLogicalId") != rebuilt_host_id
        )
        if unrelated_before != unrelated_after:
            raise MutationError(
                "UNRELATED_GEOMETRY_CHANGED",
                "A physical segment outside the requested host changed",
            )
        preserved_segment_count = len(unrelated_after)
        target.pos = _point(operation["physicalPosition"])
        rt.setUserProp(
            target,
            "AIArchViz.PhysicalPosition",
            json.dumps(operation["physicalPosition"], separators=(",", ":")),
        )
    else:
        material_spec = operation.get("material")
        if not isinstance(material_spec, dict):
            raise MutationError("REVISION_PLAN_INVALID", "AssignMaterial plan has no material")
        if not isinstance(material_spec.get("id"), str) or not isinstance(
            material_spec.get("baseColorRgb"), list
        ):
            raise MutationError("REVISION_PLAN_INVALID", "AssignMaterial material is invalid")
        native_material = _find_existing_material(material_spec, list(rt.objects))
        assigned_material_id = str(material_spec["id"])
        target.material = native_material
        rt.setUserProp(target, "AIArchViz.MaterialId", assigned_material_id)
        if _user_prop(target, "AIArchViz.EntityType") == "wall":
            segments = [
                node
                for node in list(rt.objects)
                if _user_prop(node, "AIArchViz.HostLogicalId") == target_id
            ]
            if not segments:
                raise MutationError(
                    "MATERIAL_ASSIGNMENT_MISMATCH",
                    f"Wall {target_id} has no physical segments to assign",
                )
            geometry_before = sorted(_segment_geometry_signature(node) for node in segments)
            unrelated_before = sorted(
                _wall_material_signature(node)
                for node in list(rt.objects)
                if _user_prop(node, "AIArchViz.HostLogicalId")
                and _user_prop(node, "AIArchViz.HostLogicalId") != target_id
            )
            for segment in segments:
                segment.material = native_material
                rt.setUserProp(segment, "AIArchViz.MaterialId", assigned_material_id)
            geometry_after = sorted(_segment_geometry_signature(node) for node in segments)
            unrelated_after = sorted(
                _wall_material_signature(node)
                for node in list(rt.objects)
                if _user_prop(node, "AIArchViz.HostLogicalId")
                and _user_prop(node, "AIArchViz.HostLogicalId") != target_id
            )
            if geometry_before != geometry_after:
                raise MutationError(
                    "WALL_GEOMETRY_CHANGED",
                    f"AssignMaterial changed physical geometry for {target_id}",
                )
            if unrelated_before != unrelated_after:
                raise MutationError(
                    "UNRELATED_MATERIAL_CHANGED",
                    "AssignMaterial changed an unrelated wall material",
                )
            assigned_wall_segment_count = len(segments)

    for logical_id, nodes in logical_nodes.items():
        node = nodes[0]
        raw_entry = _user_prop(node, "AIArchViz.ManifestEntry")
        if not raw_entry:
            raise MutationError("MANIFEST_ENTRY_MISSING", f"{logical_id} has no semantic entry")
        entry = json.loads(raw_entry)
        metadata = entry.get("embeddedMetadata")
        if not isinstance(metadata, dict):
            raise MutationError("MANIFEST_ENTRY_INVALID", f"{logical_id} metadata is invalid")
        metadata["AIArchViz.RevisionId"] = plan["targetRevisionId"]
        if logical_id == target_id:
            if operation["type"] == "MoveObject":
                entry["transform"] = operation["transform"]
            elif operation["type"] == "UpdateOpening":
                entry["transform"] = operation["transform"]
                entry["offset"] = operation["offset"]
                entry["sill"] = operation["sill"]
                entry["dimensions"] = [
                    operation["width"],
                    entry["dimensions"][1],
                    operation["height"],
                ]
            elif operation["type"] == "AssignMaterial":
                entry["materialId"] = operation["material"]["id"]
                entry["materialBaseColorRgb"] = operation["material"]["baseColorRgb"]
        rt.setUserProp(node, "AIArchViz.RevisionId", str(plan["targetRevisionId"]))
        rt.setUserProp(
            node,
            "AIArchViz.ManifestEntry",
            json.dumps(entry, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
        )

    candidate_path.parent.mkdir(parents=True, exist_ok=True)
    if not rt.saveMaxFile(str(candidate_path), useNewFile=True, quiet=True):
        raise MutationError("CANDIDATE_SAVE_FAILED", "3ds Max did not save revised candidate")
    if not candidate_path.exists() or candidate_path.stat().st_size <= 0:
        raise MutationError("CANDIDATE_MISSING", "Revised candidate is missing after save")
    result = {
        "revisionRunnerVersion": REVISION_RUNNER_VERSION,
        "status": "SUCCESS",
        "changeSetId": plan["changeSetId"],
        "baseRevisionId": plan["baseRevisionId"],
        "targetRevisionId": plan["targetRevisionId"],
        "targetLogicalId": target_id,
        "rebuiltHostLogicalId": rebuilt_host_id,
        "deletedWallSegmentCount": deleted_segment_count,
        "createdWallSegmentCount": created_segment_count,
        "preservedUnrelatedWallSegmentCount": preserved_segment_count,
        "assignedMaterialId": assigned_material_id,
        "assignedWallSegmentCount": assigned_wall_segment_count,
        "managedNodeCount": len(managed_nodes),
        "candidatePath": str(candidate_path),
        "candidateSizeBytes": candidate_path.stat().st_size,
    }
    _write_json(result_path, result)
    return result


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_MUTATION_RESULT_PATH")
    try:
        result = apply_revision()
        print("AI_ARCHVIZ_MUTATION_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        result = {
            "revisionRunnerVersion": REVISION_RUNNER_VERSION,
            "status": "FAILED",
            "errorCode": error.code if isinstance(error, MutationError) else "MUTATION_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_MUTATION_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
