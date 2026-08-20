"""Read-only isolated inspector for a single trusted-quarantine external .max file."""

from __future__ import annotations

import json
import math
import os
import sys
import time
from ctypes import windll
from pathlib import Path
from typing import Any, Iterable

import pymxs
from pymxs import runtime as rt


INSPECTOR_VERSION = "0.1.0"
INSPECTION_VERSION = "0.1.0"
MM_PER_SYSTEM_UNIT = {
    "inches": 25.4,
    "feet": 304.8,
    "miles": 1609344.0,
    "millimeters": 1.0,
    "centimeters": 10.0,
    "meters": 1000.0,
    "kilometers": 1000000.0,
}
STOCK_GEOMETRY_CLASSES = {"box"}
STOCK_MATERIAL_CLASSES = {"standardmaterial"}


def _required_value(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Missing trusted environment value: {key}")
    return value


def _required_path(key: str) -> Path:
    return Path(_required_value(key))


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary_path, path)


def _empty_observations() -> dict[str, Any]:
    return {
        "scene": {"nodeCount": 0, "geometryNodeCount": 0, "cameraCount": 0, "lightCount": 0},
        "geometry": {
            "worldBoundingBoxMm": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "dimensionsMm": [0.0, 0.0, 0.0],
            "pivotPositionMm": [0.0, 0.0, 0.0],
            "floorCenterAnchorCompatible": False,
        },
        "units": {
            "systemType": "unknown",
            "systemScale": 1.0,
            "displayType": "unknown",
            "normalization": "millimeters",
            "useFileUnits": True,
        },
        "materials": {"materialCount": 0, "classNames": []},
        "dependencies": {"missingExternalFiles": 0, "missingDLLs": 0, "xrefs": 0, "externalReferenceCount": 0},
        "security": {
            "safeSceneScriptExecutionEnabled": False,
            "settingsLocked": False,
            "lockCause": "unobserved",
            "scriptAssetsProtected": False,
        },
    }


def _runtime_major_version() -> int:
    version = rt.maxVersion()
    raw_major = int(version[0])
    # maxVersion() returns the internal SDK version (for example 27000 for
    # 3ds Max 2025), whose major component maps to calendar year + 1998.
    sdk_major = raw_major // 1000 if raw_major >= 1000 else raw_major
    return sdk_major + 1998


def _security_observation() -> dict[str, Any]:
    manager = rt.SceneScriptSecurityManager
    enabled = bool(manager.IsSafeSceneScriptExecutionEnabled(rt.Name("Current")))
    locked = bool(manager.AreSettingsLocked())
    cause = str(manager.GetCauseOfLock()).replace("#", "").lower()
    script_assets_protected = bool(manager.IsSafeScriptAssetExecutionEnabled())
    return {
        "safeSceneScriptExecutionEnabled": enabled,
        "settingsLocked": locked,
        "lockCause": cause,
        "scriptAssetsProtected": script_assets_protected,
    }


def _is_administrator() -> bool:
    try:
        return bool(windll.shell32.IsUserAnAdmin())
    except Exception:
        # The required non-admin posture cannot be established, so fail closed.
        return True


def _system_unit_to_mm() -> tuple[float, dict[str, Any]]:
    system_type = str(rt.units.SystemType).replace("#", "").lower()
    system_scale = float(rt.units.SystemScale)
    unit_scale = MM_PER_SYSTEM_UNIT.get(system_type)
    if unit_scale is None or not math.isfinite(system_scale) or system_scale <= 0:
        raise RuntimeError(f"Unsupported system unit state: {system_type} / {system_scale}")
    return system_scale * unit_scale, {
        "systemType": str(rt.units.SystemType),
        "systemScale": system_scale,
        "displayType": str(rt.units.DisplayType),
        "normalization": "millimeters",
        "useFileUnits": True,
    }


def _point_mm(point: Any, multiplier: float) -> list[float]:
    return [float(point.x) * multiplier, float(point.y) * multiplier, float(point.z) * multiplier]


def _scene_nodes() -> Iterable[Any]:
    def walk(parent: Any) -> Iterable[Any]:
        for child in parent.children:
            yield child
            yield from walk(child)

    yield from walk(rt.rootNode)


def _node_kind(node: Any) -> str:
    return str(rt.superClassOf(node)).replace("#", "").lower()


def _is_geometry(node: Any) -> bool:
    return "geometry" in _node_kind(node)


def _is_camera(node: Any) -> bool:
    return "camera" in _node_kind(node)


def _is_light(node: Any) -> bool:
    return "light" in _node_kind(node)


def _geometry_observations(nodes: list[Any], multiplier: float) -> tuple[dict[str, Any], list[str]]:
    geometry_nodes = [node for node in nodes if _is_geometry(node)]
    findings: list[str] = []
    if not geometry_nodes:
        return _empty_observations()["geometry"], ["ASSET_NO_GEOMETRY"]

    minimum = [math.inf, math.inf, math.inf]
    maximum = [-math.inf, -math.inf, -math.inf]
    for node in geometry_nodes:
        bounds = rt.nodeGetBoundingBox(node, rt.Matrix3(1))
        for index, point in enumerate((bounds[0], bounds[1])):
            coordinates = _point_mm(point, multiplier)
            target = minimum if index == 0 else maximum
            for axis in range(3):
                if index == 0:
                    target[axis] = min(target[axis], coordinates[axis])
                else:
                    target[axis] = max(target[axis], coordinates[axis])

        class_name = str(rt.classOf(node)).replace("#", "").lower()
        if class_name not in STOCK_GEOMETRY_CLASSES:
            findings.append("ASSET_UNSUPPORTED_SCENE_CLASS")

    dimensions = [maximum[axis] - minimum[axis] for axis in range(3)]
    pivot = _point_mm(geometry_nodes[0].pos, multiplier)
    center = [(minimum[axis] + maximum[axis]) / 2.0 for axis in range(3)]
    tolerance = 0.01
    floor_center_anchor = (
        abs(pivot[0] - center[0]) <= tolerance
        and abs(pivot[1] - center[1]) <= tolerance
        and abs(pivot[2] - minimum[2]) <= tolerance
    )
    return {
        "worldBoundingBoxMm": [*minimum, *maximum],
        "dimensionsMm": dimensions,
        "pivotPositionMm": pivot,
        "floorCenterAnchorCompatible": floor_center_anchor,
    }, findings


def _material_observations(nodes: list[Any]) -> tuple[dict[str, Any], list[str]]:
    class_names: set[str] = set()
    material_count = 0
    findings: list[str] = []
    for node in nodes:
        if not _is_geometry(node):
            continue
        material = node.material
        if material is None:
            continue
        material_count += 1
        class_name = str(rt.classOf(material)).replace("#", "").lower()
        class_names.add(class_name)
        if class_name not in STOCK_MATERIAL_CLASSES:
            findings.append("ASSET_UNSUPPORTED_SCENE_CLASS")
    return {"materialCount": material_count, "classNames": sorted(class_names)}, findings


def _load_asset(asset_path: Path) -> tuple[bool, list[Any], list[Any], list[Any]]:
    missing_external_files = rt.Array()
    missing_dlls = rt.Array()
    missing_xrefs = rt.Array()
    loaded, missing_external_files, missing_dlls, missing_xrefs = rt.loadMaxFile(
        str(asset_path),
        useFileUnits=True,
        quiet=True,
        allowPrompts=False,
        missingExtFilesAction=rt.Name("logmsg"),
        missingExtFilesList=pymxs.byref(missing_external_files),
        missingDLLsAction=rt.Name("logmsg"),
        missingDLLsList=pymxs.byref(missing_dlls),
        missingXRefsAction=rt.Name("logmsg"),
        missingXRefsList=pymxs.byref(missing_xrefs),
        skipXRefs=True,
    )
    return bool(loaded), list(missing_external_files), list(missing_dlls), list(missing_xrefs)


def inspect() -> dict[str, Any]:
    artifact_id = _required_value("AI_ARCHVIZ_INSPECTION_ARTIFACT_ID")
    artifact_sha256 = _required_value("AI_ARCHVIZ_INSPECTION_ARTIFACT_SHA256")
    asset_path = _required_path("AI_ARCHVIZ_INSPECTION_ASSET_PATH")
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_INSPECTION_TIMEOUT") == "1":
        time.sleep(300)

    evidence: dict[str, Any] = {
        "inspectionVersion": INSPECTION_VERSION,
        "artifactId": artifact_id,
        "artifactSha256": artifact_sha256,
        "inspector": {"type": "trusted_3ds_max_asset_inspector", "version": INSPECTOR_VERSION},
        "dcc": {
            "product": "3ds_max",
            "testedMajorVersion": _runtime_major_version(),
            "compatibilityMode": _runtime_major_version() != 2026,
        },
        "result": "fail",
        "findings": [],
        "observations": _empty_observations(),
    }

    rt.resetMaxFile(rt.Name("noPrompt"))
    if _is_administrator():
        evidence["failureCode"] = "ASSET_INSPECTION_ADMIN_CONTEXT_FORBIDDEN"
        evidence["findings"] = ["ASSET_INSPECTION_ADMIN_CONTEXT_FORBIDDEN"]
        return evidence
    try:
        evidence["observations"]["security"] = _security_observation()
    except Exception:
        evidence["failureCode"] = "ASSET_INSPECTION_SECURITY_POSTURE_UNKNOWN"
        evidence["findings"] = ["ASSET_INSPECTION_SECURITY_POSTURE_UNKNOWN"]
        return evidence

    security = evidence["observations"]["security"]
    if not (
        security["safeSceneScriptExecutionEnabled"]
        and security["settingsLocked"]
        and security["lockCause"] == "cmdline"
        and security["scriptAssetsProtected"]
    ):
        evidence["failureCode"] = "ASSET_INSPECTION_SECURITY_POSTURE_UNKNOWN"
        evidence["findings"] = ["ASSET_INSPECTION_SECURITY_POSTURE_UNKNOWN"]
        return evidence

    try:
        loaded, missing_external_files, missing_dlls, missing_xrefs = _load_asset(asset_path)
    except Exception:
        evidence["failureCode"] = "ASSET_INSPECTION_LOAD_FAILED"
        evidence["findings"] = ["ASSET_INSPECTION_LOAD_FAILED"]
        return evidence
    if not loaded:
        evidence["failureCode"] = "ASSET_INSPECTION_LOAD_FAILED"
        evidence["findings"] = ["ASSET_INSPECTION_LOAD_FAILED"]
        return evidence

    multiplier, unit_observations = _system_unit_to_mm()
    nodes = list(_scene_nodes())
    geometry, geometry_findings = _geometry_observations(nodes, multiplier)
    materials, material_findings = _material_observations(nodes)
    camera_count = sum(1 for node in nodes if _is_camera(node))
    light_count = sum(1 for node in nodes if _is_light(node))
    dependencies = {
        "missingExternalFiles": len(missing_external_files),
        "missingDLLs": len(missing_dlls),
        "xrefs": len(missing_xrefs),
        "externalReferenceCount": len(missing_external_files) + len(missing_xrefs),
    }
    findings = [*geometry_findings, *material_findings]
    if any(dependencies.values()):
        findings.append("ASSET_EXTERNAL_DEPENDENCY_DETECTED")
    if dependencies["missingDLLs"] > 0:
        findings.append("ASSET_PLUGIN_DEPENDENCY_MISSING")
    if dependencies["xrefs"] > 0:
        findings.append("ASSET_XREF_DETECTED")
    if camera_count > 0 or light_count > 0 or len(nodes) != 1:
        findings.append("ASSET_UNEXPECTED_SCENE_CONTENT")

    evidence["observations"] = {
        "scene": {
            "nodeCount": len(nodes),
            "geometryNodeCount": sum(1 for node in nodes if _is_geometry(node)),
            "cameraCount": camera_count,
            "lightCount": light_count,
        },
        "geometry": geometry,
        "units": unit_observations,
        "materials": materials,
        "dependencies": dependencies,
        "security": security,
    }
    evidence["findings"] = sorted(set(findings))
    if evidence["findings"]:
        evidence["failureCode"] = evidence["findings"][0]
        return evidence
    evidence["result"] = "pass"
    return evidence


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_INSPECTION_RESULT_PATH")
    artifact_id = os.environ.get("AI_ARCHVIZ_INSPECTION_ARTIFACT_ID", "unknown_artifact")
    artifact_sha256 = os.environ.get("AI_ARCHVIZ_INSPECTION_ARTIFACT_SHA256", "sha256:" + "0" * 64)
    try:
        evidence = inspect()
    except Exception as error:
        evidence = {
            "inspectionVersion": INSPECTION_VERSION,
            "artifactId": artifact_id,
            "artifactSha256": artifact_sha256,
            "inspector": {"type": "trusted_3ds_max_asset_inspector", "version": INSPECTOR_VERSION},
            "dcc": {"product": "3ds_max", "testedMajorVersion": 1, "compatibilityMode": True},
            "result": "fail",
            "failureCode": "ASSET_INSPECTION_LOAD_FAILED",
            "findings": ["ASSET_INSPECTION_LOAD_FAILED"],
            "observations": _empty_observations(),
        }
    payload = {"status": "SUCCESS" if evidence["result"] == "pass" else "FAILED", "evidence": evidence}
    _write_json(result_path, payload)
    print("AI_ARCHVIZ_ASSET_INSPECTION_RESULT=" + json.dumps(payload, separators=(",", ":")), flush=True)
    return 0 if evidence["result"] == "pass" else 2


if __name__ == "__main__":
    sys.exit(main())
