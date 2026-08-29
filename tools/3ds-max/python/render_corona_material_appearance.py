"""Realize canonical Corona material appearance (roughness + metalness) from
a validated Corona execution plan v0.2 and observe the actual native Corona
Physical Material properties (Technical Spike 8F).

This is a capability/contract spike: it proves real Corona Physical Material
realization and property mapping, not a photorealistic render. No render call
is made and the scene is never saved.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIRECTORY = str(Path(__file__).resolve().parent)
if SCRIPT_DIRECTORY not in sys.path:
    sys.path.insert(0, SCRIPT_DIRECTORY)

import render_corona_baseline as corona  # noqa: E402
from pymxs import runtime as rt  # noqa: E402


RUNNER_VERSION = "0.1.0"
PLAN_VERSION = "0.2.0"
TOLERANCE = 0.01


class MaterialAppearanceError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise MaterialAppearanceError("TRUSTED_INPUT_MISSING", f"Missing worker-owned input {key}")
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
    return os.environ.get("AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE") == code


def _normalized_name(value: Any) -> str:
    return corona._normalized_name(value)


def _class_name(value: Any) -> str:
    return corona._class_name(value)


def _close(left: float, right: float, tolerance: float = TOLERANCE) -> bool:
    return abs(float(left) - float(right)) <= tolerance


def _validate_plan(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise MaterialAppearanceError("CORONA_EXECUTION_PLAN_INVALID", "Plan must be an object")
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
        raise MaterialAppearanceError("CORONA_EXECUTION_PLAN_INVALID", "Plan keys are not trusted")
    if value["planVersion"] != PLAN_VERSION or value["engine"] != "corona":
        raise MaterialAppearanceError(
            "CORONA_EXECUTION_PLAN_INVALID", "Unsupported plan version or engine"
        )
    if not isinstance(value["materials"], list) or len(value["materials"]) == 0:
        raise MaterialAppearanceError("CORONA_EXECUTION_PLAN_INVALID", "Plan must contain materials")
    for entry in value["materials"]:
        if not isinstance(entry, dict) or "roughness" not in entry or "metalness" not in entry:
            raise MaterialAppearanceError(
                "CORONA_EXECUTION_PLAN_INVALID", "Plan v0.2 material is missing canonical appearance"
            )
    if "material" in value.get("adapterDefaults", {}):
        raise MaterialAppearanceError(
            "CORONA_EXECUTION_PLAN_INVALID",
            "Plan v0.2 must not carry a legacy material adapter default",
        )
    if not isinstance(value["materialAssignments"], list) or len(value["materialAssignments"]) == 0:
        raise MaterialAppearanceError(
            "CORONA_EXECUTION_PLAN_INVALID", "Plan must contain material assignments"
        )
    return value


def _require_safe_scene() -> dict[str, Any]:
    if _force("safe_scene"):
        raise MaterialAppearanceError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
    try:
        security = corona._security_observation()
    except corona.CoronaBaselineError as error:
        raise MaterialAppearanceError("SAFE_SCENE_REQUIRED", "Safe Scene posture could not be observed") from error
    if not (
        security["safeSceneScriptExecutionEnabled"]
        and security["settingsLocked"]
        and security["lockCause"] == "cmdline"
        and security["scriptAssetsProtected"]
    ):
        raise MaterialAppearanceError("SAFE_SCENE_REQUIRED", "Safe Scene must be command-line locked")
    return security


def _discover_renderer() -> tuple[str, str | None]:
    if _force("renderer_missing"):
        raise MaterialAppearanceError("CORONA_NOT_FOUND", "Trusted test forced renderer absence")
    renderer_class, discovered_class = corona._discover_corona_renderer()
    _renderer, observed_class, plugin_version = corona._configure_renderer(renderer_class)
    if _normalized_name(discovered_class) != _normalized_name(observed_class):
        raise MaterialAppearanceError("CORONA_RENDERER_ASSIGNMENT_FAILED", "Renderer identity changed")
    return observed_class, plugin_version


def _read_property(instance: Any, exact_names: tuple[str, ...], tokens: tuple[str, ...], error_code: str) -> Any:
    properties = corona._property_names(instance)
    selected = next((properties[name] for name in exact_names if name in properties), None)
    if selected is None:
        matches = [
            original
            for normalized, original in properties.items()
            if all(token in normalized for token in tokens)
        ]
        if len(matches) == 1:
            selected = matches[0]
    if selected is None:
        raise MaterialAppearanceError(error_code, f"Required Corona property is unavailable: {'/'.join(exact_names)}")
    try:
        return rt.getProperty(instance, rt.Name(selected))
    except Exception as error:
        raise MaterialAppearanceError(error_code, f"Could not read supported property {selected}") from error


def _create_appearance_material(base_color_rgb: list[float], roughness: float, metalness: float, name: str) -> Any:
    if _force("material_missing"):
        raise MaterialAppearanceError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Trusted test forced material absence")
    material_class = corona._unique_class(
        rt.Material.classes,
        lambda entry: "corona" in entry and "physical" in entry and "mtl" in entry,
        "CORONA_MATERIAL_CLASS_NOT_FOUND",
        "CORONA_MATERIAL_CLASS_AMBIGUOUS",
    )
    try:
        material = material_class()
    except Exception as error:
        raise MaterialAppearanceError(
            "CORONA_MATERIAL_CLASS_NOT_FOUND", "Corona Physical Material could not be instantiated"
        ) from error
    corona._set_discovered_property(
        material,
        ("basecolor", "basecol"),
        ("base", "color"),
        rt.Color(*(component * 255.0 for component in base_color_rgb)),
        "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
    )
    if _force("roughness_property_missing"):
        raise MaterialAppearanceError(
            "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED", "Trusted test forced roughness absence"
        )
    corona._set_discovered_property(
        material,
        ("baseroughness", "roughness"),
        ("rough",),
        float(roughness),
        "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED",
    )
    _set_metalness(material, metalness)
    material.name = name
    return material


def _set_metalness(material: Any, metalness: float) -> None:
    if _force("metalness_property_missing"):
        raise MaterialAppearanceError(
            "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED", "Trusted test forced metalness absence"
        )
    properties = corona._property_names(material)
    if "basemetalness" in properties or "metalness" in properties:
        corona._set_discovered_property(
            material,
            ("basemetalness", "metalness"),
            ("metal",),
            float(metalness),
            "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED",
        )
        return
    if "metalnessmode" in properties:
        if metalness not in (0.0, 1.0):
            raise MaterialAppearanceError(
                "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED",
                "Installed Corona metalness enum cannot represent a fractional value",
            )
        corona._set_discovered_property(
            material,
            ("metalnessmode",),
            ("metal", "mode"),
            int(metalness),
            "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED",
        )
        return
    raise MaterialAppearanceError(
        "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED", "No metalness property is available"
    )


def _read_metalness(material: Any) -> float:
    properties = corona._property_names(material)
    if "basemetalness" in properties or "metalness" in properties:
        return float(
            _read_property(
                material, ("basemetalness", "metalness"), ("metal",), "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED"
            )
        )
    if "metalnessmode" in properties:
        return float(
            _read_property(
                material, ("metalnessmode",), ("metal", "mode"), "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED"
            )
        )
    raise MaterialAppearanceError(
        "CORONA_MATERIAL_METALNESS_PROPERTY_UNSUPPORTED", "No metalness property is available"
    )


def _read_base_color(material: Any) -> list[float]:
    color = _read_property(
        material, ("basecolor", "basecol"), ("base", "color"), "CORONA_MATERIAL_PROPERTY_UNSUPPORTED"
    )
    return [float(color.r) / 255.0, float(color.g) / 255.0, float(color.b) / 255.0]


def _same_material_instance(left: Any, right: Any) -> bool:
    try:
        return int(rt.getHandleByAnim(left)) == int(rt.getHandleByAnim(right))
    except Exception:
        return str(left) == str(right) and str(left.name) == str(right.name)


def _create_geometry_targets(plan: dict[str, Any]) -> dict[str, Any]:
    target_ids = sorted({str(entry["targetId"]) for entry in plan["materialAssignments"]})
    nodes: dict[str, Any] = {}
    for target_id in target_ids:
        box = rt.Box(width=500.0, length=500.0, height=500.0)
        box.name = f"AVZ_APPEARANCE_{target_id}"
        nodes[target_id] = box
    return nodes


def realize(plan: dict[str, Any]) -> dict[str, Any]:
    if _force("timeout"):
        import time

        time.sleep(300)
    rt.resetMaxFile(rt.Name("noPrompt"))
    safe_scene = _require_safe_scene()
    observed_renderer_class, plugin_version = _discover_renderer()
    nodes = _create_geometry_targets(plan)

    materials: dict[str, Any] = {}
    material_evidence: list[dict[str, Any]] = []
    for entry in plan["materials"]:
        material_id = str(entry["materialId"])
        material = _create_appearance_material(
            entry["baseColorRgb"], entry["roughness"], entry["metalness"], f"AVZ_CORONA_{material_id}"
        )
        materials[material_id] = material
        observed_roughness = float(
            _read_property(material, ("baseroughness", "roughness"), ("rough",), "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED")
        )
        observed_metalness = _read_metalness(material)
        observed_base_color = _read_base_color(material)
        if (
            not _close(observed_roughness, float(entry["roughness"]))
            or not _close(observed_metalness, float(entry["metalness"]))
            or any(
                not _close(observed, canonical)
                for observed, canonical in zip(observed_base_color, entry["baseColorRgb"])
            )
        ):
            raise MaterialAppearanceError(
                "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
                f"Observed appearance does not match canonical intent for {material_id}",
            )
        material_evidence.append(
            {
                "materialId": material_id,
                "actualClass": _class_name(rt.classOf(material)),
                "canonicalBaseColorRgb": entry["baseColorRgb"],
                "canonicalRoughness": entry["roughness"],
                "canonicalMetalness": entry["metalness"],
                "observedBaseColorRgb": observed_base_color,
                "observedRoughness": observed_roughness,
                "observedMetalness": observed_metalness,
                "materialInstanceName": str(material.name),
            }
        )

    assignments: list[dict[str, Any]] = []
    for entry in plan["materialAssignments"]:
        target_id = str(entry["targetId"])
        material_id = str(entry["materialId"])
        node = nodes.get(target_id)
        material = materials.get(material_id)
        if node is None:
            raise MaterialAppearanceError(
                "MATERIAL_ASSIGNMENT_TARGET_MISSING", f"Canonical target is missing: {target_id}"
            )
        if material is None:
            raise MaterialAppearanceError(
                "CORONA_EXECUTION_PLAN_INVALID", f"Canonical material is missing: {material_id}"
            )
        node.material = material
        if not _same_material_instance(node.material, material):
            raise MaterialAppearanceError(
                "CORONA_MATERIAL_ASSIGNMENT_FAILED", f"Material mismatch on {target_id}"
            )
        assignments.append(
            {
                "targetId": target_id,
                "materialId": material_id,
                "materialInstanceName": str(material.name),
                "className": _class_name(rt.classOf(material)),
                "sharedMaterialInstance": True,
            }
        )

    # Same materialId used by more than one target must realize to one shared
    # native instance; different materialIds must never be value-deduplicated
    # into a shared instance even when appearance is identical.
    by_material: dict[str, list[str]] = {}
    for entry in plan["materialAssignments"]:
        by_material.setdefault(str(entry["materialId"]), []).append(str(entry["targetId"]))
    same_id_shared_instance = True
    for material_id, target_ids in by_material.items():
        if len(target_ids) < 2:
            continue
        instances = [nodes[target_id].material for target_id in target_ids]
        if any(not _same_material_instance(instances[0], other) for other in instances[1:]):
            same_id_shared_instance = False
    material_ids = list(materials.keys())
    different_id_distinct_instances = True
    for left_index, left_id in enumerate(material_ids):
        for right_id in material_ids[left_index + 1 :]:
            if _same_material_instance(materials[left_id], materials[right_id]):
                different_id_distinct_instances = False
    if _force("dedup_failure"):
        same_id_shared_instance = False
    if not same_id_shared_instance or not different_id_distinct_instances:
        raise MaterialAppearanceError(
            "CORONA_MATERIAL_ASSIGNMENT_FAILED", "Material identity deduplication proof failed"
        )

    result = {
        "status": "PASS",
        "runnerVersion": RUNNER_VERSION,
        "renderer": {"className": observed_renderer_class, "version": plugin_version},
        "dcc": {
            "version": corona._runtime_version(),
            "compatibilityMode": corona._runtime_major_version() != 2026,
        },
        "safeScene": safe_scene,
        "materials": sorted(material_evidence, key=lambda entry: entry["materialId"]),
        "materialAssignments": sorted(assignments, key=lambda entry: entry["targetId"]),
        "deduplication": {
            "sameIdSharedInstance": same_id_shared_instance,
            "differentIdDistinctInstances": different_id_distinct_instances,
        },
    }
    if _force("invalid_evidence"):
        result["materials"] = []
    return result


def main() -> int:
    plan_path = _required_path("AI_ARCHVIZ_MATERIAL_APPEARANCE_PLAN_PATH")
    result_path = _required_path("AI_ARCHVIZ_MATERIAL_APPEARANCE_RESULT_PATH")
    try:
        plan = _validate_plan(json.loads(plan_path.read_text(encoding="utf-8")))
        result = realize(plan)
        _write_json(result_path, result)
        print("AI_ARCHVIZ_MATERIAL_APPEARANCE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except (MaterialAppearanceError, corona.CoronaBaselineError) as error:
        result = {"status": "FAILED", "failureCode": error.code, "message": str(error)}
    except Exception as error:
        result = {
            "status": "FAILED",
            "failureCode": "CORONA_RENDER_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
    _write_json(result_path, result)
    print("AI_ARCHVIZ_MATERIAL_APPEARANCE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
