"""Fresh-process verifier for the canonical Corona material appearance state
realized by a MigrateMaterialAppearanceContract revision (Technical Spike 8G).

This process is independent from the mutation process and from the existing
semantic/render-state verifiers: it opens its own copy of the candidate scene
and re-observes native Corona Physical Material state from scratch, including
a materialId-based deduplication re-proof, before any material-appearance
revision is allowed to be promoted.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))

from pymxs import runtime as rt

import render_corona_material_appearance as material_appearance


VERIFY_VERSION = "0.1.0"
CORONA_PHYSICAL_MATERIAL_CLASS = "_CoronaPhysicalMtl"


class MaterialStateError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise MaterialStateError("TRUSTED_INPUT_MISSING", f"Missing trusted environment value: {key}")
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


def _force(code: str) -> bool:
    return os.environ.get("AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE") == code


def _safe_scene() -> dict[str, Any]:
    if _force("safe_scene"):
        raise MaterialStateError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
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
        raise MaterialStateError("SAFE_SCENE_REQUIRED", "Safe Scene must be command-line locked")
    return observation


def _resolve_native_material(expected_material: dict[str, Any], all_nodes: list[Any]) -> Any:
    material_id = str(expected_material["materialId"])
    expected_name = str(expected_material["materialInstanceName"])
    if _force("material_missing"):
        raise MaterialStateError("MATERIAL_NOT_FOUND", "Trusted test forced material absence")
    candidates = [
        node.material
        for node in all_nodes
        if _user_prop(node, "AIArchViz.MaterialId") == material_id
        and node.material is not None
        and str(node.material.name) == expected_name
    ]
    if not candidates:
        raise MaterialStateError(
            "MATERIAL_NOT_FOUND", f"Native material {material_id} was not found in the candidate scene"
        )
    native = candidates[0]
    actual_class = material_appearance._class_name(rt.classOf(native))
    if actual_class != CORONA_PHYSICAL_MATERIAL_CLASS:
        raise MaterialStateError(
            "MATERIAL_TYPE_MISMATCH",
            f"Native material {material_id} is {actual_class}, not {CORONA_PHYSICAL_MATERIAL_CLASS}",
        )
    return native


def _observed_roughness(material: Any) -> float:
    if _force("roughness_property_missing"):
        raise MaterialStateError(
            "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED", "Trusted test forced roughness absence"
        )
    return float(
        material_appearance._read_property(
            material,
            ("baseroughness", "roughness"),
            ("rough",),
            "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED",
        )
    )


def _observed_metalness(material: Any) -> float:
    if _force("metalness_property_missing"):
        raise MaterialStateError(
            "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED", "Trusted test forced metalness absence"
        )
    return material_appearance._read_metalness(material)


def verify() -> tuple[dict[str, Any], dict[str, Any]]:
    candidate_path = _required_path("AI_ARCHVIZ_CANDIDATE_PATH")
    expected_path = _required_path("AI_ARCHVIZ_EXPECTED_MATERIAL_STATE_PATH")
    evidence_path = _required_path("AI_ARCHVIZ_MATERIAL_STATE_PATH")
    result_path = _required_path("AI_ARCHVIZ_MATERIAL_STATE_RESULT_PATH")
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    if _force("timeout"):
        time.sleep(300)
    if not candidate_path.exists() or candidate_path.stat().st_size <= 0:
        raise MaterialStateError("CANDIDATE_MISSING", "Candidate scene is missing")
    if not rt.loadMaxFile(str(candidate_path), useFileUnits=True, quiet=True):
        raise MaterialStateError("CANDIDATE_OPEN_FAILED", "Could not open candidate scene")
    safe_scene = _safe_scene()
    if expected.get("sceneSpecVersion") != "0.3.0":
        raise MaterialStateError("MATERIAL_STATE_INVALID", "Expected material state is not SceneSpec v0.3")
    expected_materials = expected.get("materials")
    expected_assignments = expected.get("materialAssignments")
    if (
        not isinstance(expected_materials, list)
        or not expected_materials
        or not isinstance(expected_assignments, list)
        or not expected_assignments
    ):
        raise MaterialStateError("MATERIAL_STATE_INVALID", "Expected material state is incomplete")

    all_nodes = list(rt.objects)
    native_materials: dict[str, Any] = {}
    material_evidence: list[dict[str, Any]] = []
    for expected_material in expected_materials:
        material_id = str(expected_material["materialId"])
        native = _resolve_native_material(expected_material, all_nodes)
        native_materials[material_id] = native
        observed_base_color = material_appearance._read_base_color(native)
        observed_roughness = _observed_roughness(native)
        observed_metalness = _observed_metalness(native)
        canonical_base_color = [float(channel) for channel in expected_material["canonicalBaseColorRgb"]]
        canonical_roughness = float(expected_material["canonicalRoughness"])
        canonical_metalness = float(expected_material["canonicalMetalness"])
        if any(
            not material_appearance._close(observed, canonical)
            for observed, canonical in zip(observed_base_color, canonical_base_color)
        ):
            raise MaterialStateError(
                "MATERIAL_COLOR_MISMATCH", f"Native material {material_id} base color drifted from canonical intent"
            )
        if not material_appearance._close(observed_roughness, canonical_roughness):
            raise MaterialStateError(
                "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED",
                f"Native material {material_id} roughness drifted from canonical intent",
            )
        if not material_appearance._close(observed_metalness, canonical_metalness):
            raise MaterialStateError(
                "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED",
                f"Native material {material_id} metalness drifted from canonical intent",
            )
        material_evidence.append(
            {
                "materialId": material_id,
                "actualClass": CORONA_PHYSICAL_MATERIAL_CLASS,
                # Evidence carries the canonical contract values after the
                # tolerance-checked runtime observation, matching the
                # normalization pattern established by the canonical
                # render-state verifier: DCC float conversion must not create
                # a new semantic revision or make replay machine-dependent.
                "canonicalBaseColorRgb": canonical_base_color,
                "observedBaseColorRgb": canonical_base_color,
                "canonicalRoughness": canonical_roughness,
                "observedRoughness": canonical_roughness,
                "canonicalMetalness": canonical_metalness,
                "observedMetalness": canonical_metalness,
                "materialInstanceName": str(expected_material["materialInstanceName"]),
            }
        )

    assignment_evidence: list[dict[str, Any]] = []
    assigned_instances_by_material: dict[str, list[Any]] = {}
    for expected_assignment in expected_assignments:
        target_id = str(expected_assignment["targetId"])
        material_id = str(expected_assignment["materialId"])
        native = native_materials.get(material_id)
        if native is None:
            raise MaterialStateError(
                "MATERIAL_STATE_INVALID", f"Assignment references unknown material {material_id}"
            )
        host_nodes = [
            node for node in all_nodes if _user_prop(node, "AIArchViz.LogicalObjectId") == target_id
        ]
        segment_nodes = [
            node for node in all_nodes if _user_prop(node, "AIArchViz.HostLogicalId") == target_id
        ]
        if not host_nodes and not segment_nodes:
            raise MaterialStateError(
                "MATERIAL_ASSIGNMENT_MISMATCH", f"Assignment target {target_id} was not found"
            )
        # A wall host is a non-renderable Dummy helper with no real material
        # slot; its physical segments are the true material carriers. Only
        # non-wall targets (no segments) are verified through the host node.
        for node in segment_nodes if segment_nodes else host_nodes:
            if node.material is None or not material_appearance._same_material_instance(
                node.material, native
            ):
                raise MaterialStateError(
                    "MATERIAL_ASSIGNMENT_MISMATCH",
                    f"Node under {target_id} is not assigned the canonical native material {material_id}",
                )
            assigned_instances_by_material.setdefault(material_id, []).append(node.material)
        assignment_evidence.append(
            {
                "targetId": target_id,
                "materialId": material_id,
                "materialInstanceName": str(expected_assignment["materialInstanceName"]),
            }
        )

    # Re-prove materialId-based deduplication from a fresh process: every
    # assigned node sharing one canonical materialId must resolve to a single
    # native instance, and distinct materialIds must never collapse into a
    # shared instance even when their realized appearance values are
    # identical.
    same_id_shared_instance = True
    for material_id, instances in assigned_instances_by_material.items():
        if any(
            not material_appearance._same_material_instance(instances[0], other)
            for other in instances[1:]
        ):
            same_id_shared_instance = False
    material_ids = list(native_materials.keys())
    different_id_distinct_instances = True
    for left_index, left_id in enumerate(material_ids):
        for right_id in material_ids[left_index + 1 :]:
            if material_appearance._same_material_instance(
                native_materials[left_id], native_materials[right_id]
            ):
                different_id_distinct_instances = False
    if _force("dedup_failure"):
        same_id_shared_instance = False
    if not same_id_shared_instance or not different_id_distinct_instances:
        raise MaterialStateError(
            "CORONA_MATERIAL_ASSIGNMENT_FAILED", "Material identity deduplication proof failed"
        )

    evidence = {
        "materialStateVersion": "0.1.0",
        "projectId": str(expected["projectId"]),
        "sceneId": str(expected["sceneId"]),
        "revisionId": str(expected["revisionId"]),
        "sceneSpecVersion": "0.3.0",
        "materials": sorted(material_evidence, key=lambda entry: entry["materialId"]),
        "materialAssignments": sorted(assignment_evidence, key=lambda entry: entry["targetId"]),
        "deduplication": {
            "sameIdSharedInstance": same_id_shared_instance,
            "differentIdDistinctInstances": different_id_distinct_instances,
        },
        "status": "PASS",
    }
    if _force("invalid_evidence"):
        evidence["materials"] = []
    if _force("material_state_mismatch"):
        evidence["materials"][0]["observedRoughness"] = evidence["materials"][0]["observedRoughness"] + 0.5
    _write_json(evidence_path, evidence)
    result = {
        "verificationVersion": VERIFY_VERSION,
        "status": "SUCCESS",
        "safeScene": safe_scene,
        "materialCount": len(material_evidence),
        "assignmentCount": len(assignment_evidence),
    }
    _write_json(result_path, result)
    return evidence, result


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_MATERIAL_STATE_RESULT_PATH")
    try:
        _, result = verify()
        print("AI_ARCHVIZ_MATERIAL_STATE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        result = {
            "verificationVersion": VERIFY_VERSION,
            "status": "FAILED",
            "errorCode": error.code if isinstance(error, MaterialStateError) else "MATERIAL_STATE_VERIFICATION_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_MATERIAL_STATE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
