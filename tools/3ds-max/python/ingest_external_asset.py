"""Controlled, Safe-Scene external .max replacement for Technical Spike 7C.

All paths come from the local worker's private workspace.  The source-library
path is intentionally unknown to this process: it can only merge the staged
`inputs/replacement.max` copy after the worker has verified its exact bytes.
"""

from __future__ import annotations

import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any

import pymxs
from pymxs import runtime as rt


RUNNER_VERSION = "0.1.0"
LOCK_USER_PROPERTIES = {
    "geometry": "AIArchViz.LockGeometry",
    "transform": "AIArchViz.LockTransform",
    "material": "AIArchViz.LockMaterial",
}
TRUSTED_NAMESPACE_KEYS = {
    "AIArchViz.Managed",
    "AIArchViz.LogicalObjectId",
    "AIArchViz.AssetDefinitionId",
    "AIArchViz.ProjectId",
    "AIArchViz.SceneId",
    "AIArchViz.RevisionId",
    "AIArchViz.MaterialId",
    "AIArchViz.ManifestEntry",
    *LOCK_USER_PROPERTIES.values(),
}


class MutationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _required_path(name: str) -> Path:
    value = os.environ.get(name)
    if not value:
        raise MutationError("TRUSTED_INPUT_MISSING", f"Missing worker-owned input {name}")
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
    return None if value is None else str(value)


def _set_user_prop(node: Any, key: str, value: Any) -> None:
    rt.setUserProp(node, key, str(value))


def _dependency_count(value: Any) -> int:
    """pymxs returns None for an empty abort-policy byref list in Max 2025."""
    return 0 if value is None else len(value)


def _point(values: list[float]) -> Any:
    return rt.Point3(float(values[0]), float(values[1]), float(values[2]))


def _security_posture() -> dict[str, Any]:
    manager = rt.SceneScriptSecurityManager
    return {
        "safeSceneScriptExecutionEnabled": bool(
            manager.IsSafeSceneScriptExecutionEnabled(rt.Name("Current"))
        ),
        "settingsLocked": bool(manager.AreSettingsLocked()),
        "lockCause": str(manager.GetCauseOfLock()).replace("#", "").lower(),
        "scriptAssetsProtected": bool(manager.IsSafeScriptAssetExecutionEnabled()),
    }


def _require_safe_scene() -> dict[str, Any]:
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_EXTERNAL_SAFE_SCENE_FAILURE") == "1":
        raise MutationError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
    try:
        security = _security_posture()
    except Exception as error:
        raise MutationError("SAFE_SCENE_REQUIRED", "Safe Scene posture could not be observed") from error
    if not (
        security["safeSceneScriptExecutionEnabled"]
        and security["settingsLocked"]
        and security["lockCause"] == "cmdline"
        and security["scriptAssetsProtected"]
    ):
        raise MutationError("SAFE_SCENE_REQUIRED", "Safe Scene must be command-line locked")
    return security


def _load_base_scene(path: Path) -> None:
    missing_external_files = rt.Array()
    missing_dlls = rt.Array()
    missing_xrefs = rt.Array()
    loaded, missing_external_files, missing_dlls, missing_xrefs = rt.loadMaxFile(
        str(path),
        useFileUnits=True,
        quiet=True,
        allowPrompts=False,
        missingExtFilesAction=rt.Name("abort"),
        missingExtFilesList=pymxs.byref(missing_external_files),
        missingDLLsAction=rt.Name("abort"),
        missingDLLsList=pymxs.byref(missing_dlls),
        missingXRefsAction=rt.Name("abort"),
        missingXRefsList=pymxs.byref(missing_xrefs),
        skipXRefs=True,
    )
    if not loaded or any(
        (
            _dependency_count(missing_external_files),
            _dependency_count(missing_dlls),
            _dependency_count(missing_xrefs),
        )
    ):
        raise MutationError("BASE_SCENE_DEPENDENCY_INVALID", "Base scene has an unresolved dependency")


def _is_geometry(node: Any) -> bool:
    return "geometry" in str(rt.superClassOf(node)).replace("#", "").lower()


def _is_camera(node: Any) -> bool:
    return "camera" in str(rt.superClassOf(node)).replace("#", "").lower()


def _is_light(node: Any) -> bool:
    return "light" in str(rt.superClassOf(node)).replace("#", "").lower()


def _target_node(target_id: str, expected_definition_id: str) -> Any:
    matches = [
        node
        for node in rt.objects
        if _user_prop(node, "AIArchViz.LogicalObjectId") == target_id
    ]
    if len(matches) != 1:
        raise MutationError("TARGET_NOT_FOUND", "Canonical replacement target is not unique")
    node = matches[0]
    if _user_prop(node, "AIArchViz.AssetDefinitionId") != expected_definition_id:
        raise MutationError("ASSET_DEFINITION_STATE_MISMATCH", "Canonical target definition changed")
    if not _is_geometry(node):
        raise MutationError("TARGET_NOT_MANAGED", "Canonical replacement target is not geometry")
    return node


def _merge_staged_asset(path: Path) -> list[Any]:
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MUTATION_TIMEOUT") == "1":
        time.sleep(300)
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MERGE_FALSE") == "1":
        raise MutationError("ASSET_MERGE_FAILED", "Trusted test forced merge failure")
    missing_external_files = rt.Array()
    missing_dlls = rt.Array()
    missing_xrefs = rt.Array()
    merged_nodes = rt.Array()
    try:
        merged, missing_external_files, missing_dlls, missing_xrefs, merged_nodes = rt.mergeMAXFile(
            str(path),
            rt.Name("noRedraw"),
            rt.Name("autoRenameDups"),
            rt.Name("renameMtlDups"),
            rt.Name("neverReparent"),
            quiet=True,
            missingExtFilesAction=rt.Name("abort"),
            missingExtFilesList=pymxs.byref(missing_external_files),
            missingDLLsAction=rt.Name("abort"),
            missingDLLsList=pymxs.byref(missing_dlls),
            missingXRefsAction=rt.Name("abort"),
            missingXRefsList=pymxs.byref(missing_xrefs),
            mergedNodes=pymxs.byref(merged_nodes),
        )
    except Exception as error:
        raise MutationError("ASSET_MERGE_FAILED", "mergeMAXFile raised an error") from error
    if not merged:
        raise MutationError("ASSET_MERGE_FAILED", "mergeMAXFile returned false")
    if (
        _dependency_count(missing_external_files)
        or _dependency_count(missing_dlls)
        or _dependency_count(missing_xrefs)
        or os.environ.get("AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MERGE_DEPENDENCY") == "1"
    ):
        raise MutationError("ASSET_MERGE_EXTERNAL_DEPENDENCY", "Merge admitted an external dependency")
    return list(merged_nodes)


def _validate_merged_shape(nodes: list[Any]) -> Any:
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_EXTERNAL_MERGED_NODE_COUNT") == "1":
        raise MutationError("ASSET_MERGE_SHAPE_UNSUPPORTED", "Trusted test forced merged-node count")
    if len(nodes) != 1:
        raise MutationError("ASSET_MERGE_SHAPE_UNSUPPORTED", "External merge must produce exactly one node")
    node = nodes[0]
    if (
        os.environ.get("AI_ARCHVIZ_TEST_FORCE_EXTERNAL_NON_GEOMETRY") == "1"
        or not _is_geometry(node)
        or _is_camera(node)
        or _is_light(node)
    ):
        raise MutationError("ASSET_MERGE_SHAPE_UNSUPPORTED", "External merge must produce one geometry node")
    return node


def _find_canonical_material(target: Any, expected_id: str) -> Any:
    if _user_prop(target, "AIArchViz.MaterialId") != expected_id or target.material is None:
        raise MutationError("MATERIAL_ASSIGNMENT_MISMATCH", "Canonical target material is unavailable")
    return target.material


def _dimensions_mm(node: Any) -> list[float]:
    bounds = rt.nodeGetBoundingBox(node, rt.Matrix3(1))
    minimum, maximum = bounds[0], bounds[1]
    return [
        float(maximum.x) - float(minimum.x),
        float(maximum.y) - float(minimum.y),
        float(maximum.z) - float(minimum.z),
    ]


def _require_dimensions(node: Any, expected: list[float]) -> list[float]:
    actual = _dimensions_mm(node)
    if len(actual) != 3 or any(abs(actual[index] - float(expected[index])) > 0.01 for index in range(3)):
        raise MutationError("ASSET_DIMENSION_MISMATCH", "Merged geometry dimensions do not match inspected definition")
    return actual


def _clear_and_set_trusted_namespace(
    node: Any,
    metadata: dict[str, Any],
    locks: dict[str, Any],
    material_id: str,
    manifest_entry: dict[str, Any],
) -> None:
    for key in TRUSTED_NAMESPACE_KEYS:
        try:
            rt.deleteUserProp(node, key)
        except Exception:
            pass
    _set_user_prop(node, "AIArchViz.Managed", "true")
    for key, value in metadata.items():
        _set_user_prop(node, key, value)
    _set_user_prop(node, "AIArchViz.MaterialId", material_id)
    _set_user_prop(node, "AIArchViz.ManifestEntry", json.dumps(manifest_entry, separators=(",", ":")))
    for property_path, key in LOCK_USER_PROPERTIES.items():
        if locks.get(property_path) is True:
            _set_user_prop(node, key, "true")


def _refresh_revision_metadata(expected_manifest: dict[str, Any], target_id: str, replacement: Any) -> None:
    entries = [*expected_manifest.get("nodes", []), *expected_manifest.get("cameras", [])]
    expected_by_id = {entry["logicalId"]: entry for entry in entries}
    for node in rt.objects:
        if (_user_prop(node, "AIArchViz.Managed") or "").lower() != "true":
            continue
        logical_id = _user_prop(node, "AIArchViz.LogicalObjectId")
        if logical_id == target_id:
            continue
        expected = expected_by_id.get(logical_id)
        if expected is None:
            raise MutationError("MANIFEST_METADATA_MISMATCH", "Unexpected managed node in base scene")
        metadata = expected["embeddedMetadata"]
        _set_user_prop(node, "AIArchViz.RevisionId", metadata["AIArchViz.RevisionId"])
        _set_user_prop(node, "AIArchViz.ManifestEntry", json.dumps(expected, separators=(",", ":")))
    target_entry = expected_by_id.get(target_id)
    if target_entry is None:
        raise MutationError("MANIFEST_METADATA_MISMATCH", "Replacement manifest entry is missing")
    _clear_and_set_trusted_namespace(
        replacement,
        target_entry["embeddedMetadata"],
        target_entry.get("locks", {}),
        target_entry["materialId"],
        target_entry,
    )


def _validate_anchor(node: Any, transform: dict[str, Any]) -> None:
    expected_position = transform["position"]
    expected_rotation = transform["rotationEuler"]
    expected_scale = transform["scale"]
    actual_position = [float(node.pos.x), float(node.pos.y), float(node.pos.z)]
    actual_rotation = rt.quatToEuler(node.rotation)
    actual_rotation_values = [
        float(actual_rotation.x),
        float(actual_rotation.y),
        float(actual_rotation.z),
    ]
    actual_scale = [float(node.scale.x), float(node.scale.y), float(node.scale.z)]
    if (
        any(abs(actual_position[index] - float(expected_position[index])) > 0.01 for index in range(3))
        or any(abs(actual_scale[index] - float(expected_scale[index])) > 0.0001 for index in range(3))
        or any(
            abs((actual_rotation_values[index] - float(expected_rotation[index]) + 180.0) % 360.0 - 180.0)
            > 0.001
            for index in range(3)
        )
    ):
        raise MutationError(
            "ANCHOR_PRESERVATION_FAILED",
            "Replacement transform differs from canonical anchor: "
            f"position={actual_position}, rotation={actual_rotation_values}, scale={actual_scale}",
        )


def _mutate() -> dict[str, Any]:
    base_scene = _required_path("AI_ARCHVIZ_EXTERNAL_BASE_SCENE_PATH")
    staged_asset = _required_path("AI_ARCHVIZ_EXTERNAL_STAGED_ASSET_PATH")
    candidate = _required_path("AI_ARCHVIZ_EXTERNAL_CANDIDATE_PATH")
    plan_path = _required_path("AI_ARCHVIZ_EXTERNAL_PLAN_PATH")
    if not base_scene.is_file() or not staged_asset.is_file():
        raise MutationError("TRUSTED_INPUT_MISSING", "Worker-controlled .max input is unavailable")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("ingestionPlanVersion") != "0.1.0":
        raise MutationError("TRUSTED_PLAN_INVALID", "External ingestion plan is invalid")
    security = _require_safe_scene()
    _load_base_scene(base_scene)
    target = _target_node(plan["targetId"], plan["currentAssetDefinitionId"])
    material = _find_canonical_material(target, plan["materialId"])
    transform = plan["transform"]
    locks = plan["locks"]
    merged = _validate_merged_shape(_merge_staged_asset(staged_asset))
    merged.rotation = rt.EulerAngles(
        float(transform["rotationEuler"][0]),
        float(transform["rotationEuler"][1]),
        float(transform["rotationEuler"][2]),
    )
    merged.scale = _point(transform["scale"])
    # In Max, assigning rotation to a merged node after position can rotate
    # the translation component. Apply position last to preserve world anchor.
    merged.pos = _point(transform["position"])
    merged.material = material
    _refresh_revision_metadata(plan["expectedManifest"], plan["targetId"], merged)
    actual_dimensions = _require_dimensions(merged, plan["externalAssetDefinition"]["dimensions"])
    _validate_anchor(merged, transform)
    # The original scene object remains intact until merge, shape, anchor,
    # material, metadata, locks, and physical dimensions have all passed.
    rt.delete(target)
    merged.name = f"AVZ_{plan['targetId']}"
    _refresh_revision_metadata(plan["expectedManifest"], plan["targetId"], merged)
    candidate.parent.mkdir(parents=True, exist_ok=True)
    if not rt.saveMaxFile(str(candidate), quiet=True):
        raise MutationError("CANDIDATE_SAVE_FAILED", "Candidate scene could not be saved")
    return {
        "runnerVersion": RUNNER_VERSION,
        "status": "SUCCESS",
        "mergedNodeCount": 1,
        "mergedNodeKind": "geometry",
        "dimensionsMm": actual_dimensions,
        "security": security,
        "dependencies": {
            "missingExternalFiles": 0,
            "missingDLLs": 0,
            "xrefs": 0,
        },
    }


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_EXTERNAL_MUTATION_RESULT_PATH")
    try:
        result = _mutate()
        _write_json(result_path, result)
        print("AI_ARCHVIZ_EXTERNAL_INGESTION_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except MutationError as error:
        result = {
            "runnerVersion": RUNNER_VERSION,
            "status": "FAILED",
            "errorCode": error.code,
            "message": str(error),
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_EXTERNAL_INGESTION_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2
    except Exception:
        result = {
            "runnerVersion": RUNNER_VERSION,
            "status": "FAILED",
            "errorCode": "EXTERNAL_ASSET_MUTATION_FAILED",
            "message": "Unexpected controlled external mutation failure",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_EXTERNAL_INGESTION_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
