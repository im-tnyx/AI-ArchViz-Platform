"""Apply one trusted deterministic revision to an isolated verified scene copy."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

# 3ds Max's Python ExecuteFile does not always prepend the script directory;
# trusted helper modules must resolve from this repository-owned directory.
sys.path.insert(0, os.path.dirname(__file__))

from pymxs import runtime as rt

import render_corona_baseline as corona
import render_corona_material_appearance as material_appearance
import verify_scene


REVISION_RUNNER_VERSION = "0.1.0"
SUPPORTED_REVISION_PLAN_VERSIONS = {"0.1.0", "0.2.0"}
LOCK_USER_PROPERTIES = {
    "geometry": "AIArchViz.LockGeometry",
    "transform": "AIArchViz.LockTransform",
    "material": "AIArchViz.LockMaterial",
}
LIGHT_USER_PROPERTIES = {
    "logical": "AIArchViz.LogicalObjectId",
    "project": "AIArchViz.ProjectId",
    "scene": "AIArchViz.SceneId",
    "revision": "AIArchViz.RevisionId",
    "type": "AIArchViz.LightType",
    "canonicalIntensity": "AIArchViz.CanonicalIntensity",
    "mappedIntensity": "AIArchViz.MappedIntensity",
    "widthMm": "AIArchViz.WidthMm",
}


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


def _proxy_anchor_signature(node: Any) -> tuple[float, ...]:
    rotation = rt.quatToEuler(node.rotation)
    return (
        float(node.pos.x),
        float(node.pos.y),
        float(node.pos.z),
        float(rotation.x),
        float(rotation.y),
        float(rotation.z),
        float(node.scale.x),
        float(node.scale.y),
        float(node.scale.z),
    )


def _proxy_material_signature(node: Any) -> tuple[str | None, str | None]:
    material = node.material
    return (
        _user_prop(node, "AIArchViz.MaterialId"),
        str(material.name) if material is not None else None,
    )


def _proxy_lock_signature(node: Any) -> tuple[str | None, ...]:
    return tuple(_user_prop(node, key) for key in LOCK_USER_PROPERTIES.values())


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
    if plan.get("revisionPlanVersion") not in SUPPORTED_REVISION_PLAN_VERSIONS:
        raise MutationError("REVISION_PLAN_UNSUPPORTED", "Unsupported revision plan version")
    operation = plan.get("operation")
    if not isinstance(operation, dict) or operation.get("type") not in {
        "MoveObject",
        "UpdateOpening",
        "AssignMaterial",
        "LockProperty",
        "UnlockProperty",
        "ReplaceAsset",
        "SetRenderIntent",
        "AddLight",
        "MigrateMaterialAppearanceContract",
    }:
        raise MutationError(
            "OPERATION_UNSUPPORTED",
            "Runner supports MoveObject, UpdateOpening, AssignMaterial, LockProperty, UnlockProperty, "
            "ReplaceAsset, SetRenderIntent, AddLight, and MigrateMaterialAppearanceContract only",
        )
    if not base_path.exists() or base_path.stat().st_size <= 0:
        raise MutationError("BASE_ARTIFACT_MISSING", "Verified base checkpoint is missing")
    if not rt.loadMaxFile(str(base_path), useFileUnits=True, quiet=True):
        raise MutationError("BASE_ARTIFACT_OPEN_FAILED", "Could not open verified base checkpoint")
    if os.environ.get("AI_ARCHVIZ_REQUIRE_SAFE_SCENE") == "1":
        if os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE") == "safe_scene":
            raise MutationError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
        try:
            verify_scene._require_safe_scene_when_requested()
        except Exception as error:
            raise MutationError("SAFE_SCENE_REQUIRED", str(error)) from error
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

    scene_scoped_operations = {"SetRenderIntent", "AddLight", "MigrateMaterialAppearanceContract"}
    target_id = str(operation["targetId"])
    target = None
    if operation["type"] not in scene_scoped_operations:
        targets = logical_nodes.get(target_id, [])
        if not targets:
            raise MutationError("TARGET_NOT_FOUND", f"Target {target_id} was not found")
        if len(targets) > 1:
            raise MutationError("DUPLICATE_LOGICAL_ID", f"Target {target_id} is not unique")
        target = targets[0]
    if target_id != str(plan["sceneId"]):
        if operation["type"] in scene_scoped_operations:
            raise MutationError("TARGET_NOT_FOUND", f"Scene target {target_id} was not found")
    rebuilt_host_id: str | None = None
    deleted_segment_count = 0
    created_segment_count = 0
    preserved_segment_count = 0
    assigned_material_id: str | None = None
    assigned_wall_segment_count = 0
    locked_property_path: str | None = None
    unlocked_property_path: str | None = None
    replaced_asset_definition_id: str | None = None
    render_intent_configured = False
    added_light_id: str | None = None
    migrated_material_count: int | None = None
    if operation["type"] == "SetRenderIntent":
        if os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE") == "corona_missing":
            raise MutationError("CORONA_NOT_FOUND", "Trusted test forced Corona absence")
        if os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE") == "mutation_timeout":
            import time
            time.sleep(300)
        if operation.get("engine") != "corona" or operation.get("mode") != "preview":
            raise MutationError("REVISION_PLAN_INVALID", "SetRenderIntent only supports Corona preview")
        try:
            renderer_class, discovered_class = corona._discover_corona_renderer()
            _renderer, observed_class, _version = corona._configure_renderer(renderer_class)
        except Exception as error:
            code = getattr(error, "code", "CORONA_NOT_FOUND")
            raise MutationError(str(code), str(error)) from error
        if corona._normalized_name(discovered_class) != corona._normalized_name(observed_class):
            raise MutationError("CORONA_RENDERER_ASSIGNMENT_FAILED", "Production renderer is not Corona")
        render_intent_configured = True
    elif operation["type"] == "AddLight":
        if os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE") == "light_missing":
            raise MutationError("CORONA_LIGHT_CLASS_NOT_FOUND", "Trusted test forced CoronaLight absence")
        if os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE") == "property_missing":
            raise MutationError("CORONA_LIGHT_PROPERTY_UNSUPPORTED", "Trusted test forced CoronaLight property failure")
        if operation.get("renderEngine") != "corona" or operation.get("renderMode") != "preview":
            raise MutationError("RENDERER_NOT_CONFIGURED", "AddLight requires Corona preview render intent")
        existing_lights = [
            node for node in list(rt.objects)
            if _user_prop(node, LIGHT_USER_PROPERTIES["logical"]) == str(operation["light"]["id"])
        ]
        if existing_lights:
            raise MutationError("LIGHT_ID_ALREADY_EXISTS", "Canonical light logical ID already exists")
        production = getattr(rt.renderers, "production", None)
        if production is None or "corona" not in corona._normalized_name(rt.classOf(production)):
            raise MutationError("RENDERER_NOT_CONFIGURED", "Production renderer is not Corona")
        light_spec = operation.get("light")
        if not isinstance(light_spec, dict) or light_spec.get("type") != "area":
            raise MutationError("REVISION_PLAN_INVALID", "AddLight supports area lights only")
        transform = light_spec.get("transform")
        if (
            not isinstance(transform, dict)
            or transform.get("scale") != [1, 1, 1]
            or not isinstance(light_spec.get("intensity"), (int, float))
            or float(light_spec["intensity"]) < 0
        ):
            raise MutationError("LIGHT_INVALID", "Canonical area light transform or intensity is invalid")
        light_id = str(light_spec["id"])
        try:
            light, class_name = corona.create_corona_area_light(
                position=transform["position"],
                rotation_euler=transform["rotationEuler"],
                intensity=float(light_spec["intensity"]) * corona.INTENSITY_SCALE,
                width_mm=corona.AREA_LIGHT_WIDTH_MM,
                light_name=f"AVZ_{light_id}",
            )
        except Exception as error:
            code = getattr(error, "code", "CORONA_LIGHT_CLASS_NOT_FOUND")
            raise MutationError(str(code), str(error)) from error
        if corona._normalized_name(class_name) != "coronalight":
            raise MutationError("CORONA_LIGHT_CLASS_NOT_FOUND", "Created light is not CoronaLight")
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["logical"], light_id)
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["project"], str(plan["projectId"]))
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["scene"], str(plan["sceneId"]))
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["revision"], str(plan["targetRevisionId"]))
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["type"], "area")
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["canonicalIntensity"], str(float(light_spec["intensity"])))
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["mappedIntensity"], str(float(light_spec["intensity"]) * corona.INTENSITY_SCALE))
        rt.setUserProp(light, LIGHT_USER_PROPERTIES["widthMm"], str(float(corona.AREA_LIGHT_WIDTH_MM)))
        added_light_id = light_id
    elif operation["type"] == "MigrateMaterialAppearanceContract":
        if os.environ.get("AI_ARCHVIZ_TEST_FORCE_MATERIAL_APPEARANCE_FAILURE") == "renderer_missing":
            raise MutationError("CORONA_NOT_FOUND", "Trusted test forced renderer absence")
        production = getattr(rt.renderers, "production", None)
        if production is None or "corona" not in corona._normalized_name(rt.classOf(production)):
            raise MutationError("RENDERER_NOT_CONFIGURED", "Production renderer is not Corona")
        materials_spec = operation.get("materials")
        assignments_spec = operation.get("materialAssignments")
        if (
            not isinstance(materials_spec, list)
            or not materials_spec
            or not isinstance(assignments_spec, list)
            or not assignments_spec
        ):
            raise MutationError(
                "REVISION_PLAN_INVALID", "MigrateMaterialAppearanceContract plan is incomplete"
            )
        all_nodes = list(rt.objects)
        native_appearance_materials: dict[str, Any] = {}
        for material_spec in materials_spec:
            material_id = str(material_spec["materialId"])
            expected_name = f"AVZ_MATERIAL_{material_id}"
            # Confirms the pre-migration native material is the trusted
            # StandardMaterial this SceneSpec revision expects, using the
            # same lookup AssignMaterial already relies on, before it is
            # replaced by a canonical Corona Physical Material below.
            _find_existing_material(
                {"id": material_id, "baseColorRgb": material_spec["baseColorRgb"]}, all_nodes
            )
            try:
                appearance_material = material_appearance._create_appearance_material(
                    [float(channel) for channel in material_spec["baseColorRgb"]],
                    float(material_spec["roughness"]),
                    float(material_spec["metalness"]),
                    expected_name,
                )
            except material_appearance.MaterialAppearanceError as error:
                raise MutationError(error.code, str(error)) from error
            observed_roughness = float(
                material_appearance._read_property(
                    appearance_material,
                    ("baseroughness", "roughness"),
                    ("rough",),
                    "CORONA_MATERIAL_ROUGHNESS_PROPERTY_UNSUPPORTED",
                )
            )
            observed_metalness = material_appearance._read_metalness(appearance_material)
            observed_base_color = material_appearance._read_base_color(appearance_material)
            expected_color = [float(channel) for channel in material_spec["baseColorRgb"]]
            if (
                not material_appearance._close(observed_roughness, float(material_spec["roughness"]))
                or not material_appearance._close(observed_metalness, float(material_spec["metalness"]))
                or any(
                    not material_appearance._close(observed, canonical)
                    for observed, canonical in zip(observed_base_color, expected_color)
                )
            ):
                raise MutationError(
                    "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
                    f"Realized appearance does not match canonical intent for {material_id}",
                )
            native_appearance_materials[material_id] = appearance_material

        by_material_id: dict[str, list[Any]] = {}
        for assignment in assignments_spec:
            assignment_target_id = str(assignment["targetId"])
            assignment_material_id = str(assignment["materialId"])
            new_material = native_appearance_materials.get(assignment_material_id)
            if new_material is None:
                raise MutationError(
                    "REVISION_PLAN_INVALID",
                    f"MigrateMaterialAppearanceContract assignment references unknown material "
                    f"{assignment_material_id}",
                )
            host_nodes = [
                node
                for node in all_nodes
                if _user_prop(node, "AIArchViz.LogicalObjectId") == assignment_target_id
            ]
            segment_nodes = [
                node
                for node in all_nodes
                if _user_prop(node, "AIArchViz.HostLogicalId") == assignment_target_id
            ]
            if not host_nodes and not segment_nodes:
                raise MutationError(
                    "MATERIAL_ASSIGNMENT_MISMATCH",
                    f"MigrateMaterialAppearanceContract assignment target {assignment_target_id} "
                    "was not found",
                )
            # A wall host is a non-renderable Dummy helper with no real
            # material slot (verify_scene.py never validates material on a
            # wall host either, only on its physical segments); assign it for
            # display-tree consistency but do not attempt to verify the
            # instance identity of a property it does not meaningfully carry.
            # Non-wall targets have no segments, so their single physical
            # node is both assigned and verified directly.
            verifiable_nodes = segment_nodes if segment_nodes else host_nodes
            for node in host_nodes + segment_nodes:
                if _user_prop(node, "AIArchViz.MaterialId") != assignment_material_id:
                    raise MutationError(
                        "MATERIAL_ASSIGNMENT_MISMATCH",
                        f"Node under {assignment_target_id} does not carry canonical material ID "
                        f"{assignment_material_id}",
                    )
                node.material = new_material
            for node in verifiable_nodes:
                if not material_appearance._same_material_instance(node.material, new_material):
                    raise MutationError(
                        "CORONA_MATERIAL_ASSIGNMENT_FAILED",
                        f"Material mismatch on {assignment_target_id}",
                    )
                by_material_id.setdefault(assignment_material_id, []).append(node.material)

        # materialId-based deduplication proof: every physical node sharing
        # one canonical materialId must resolve to a single native instance,
        # and distinct materialIds must never collapse into a shared instance
        # even when their realized appearance values are identical.
        for material_id, instances in by_material_id.items():
            if any(
                not material_appearance._same_material_instance(instances[0], other)
                for other in instances[1:]
            ):
                raise MutationError(
                    "CORONA_MATERIAL_ASSIGNMENT_FAILED",
                    f"Material {material_id} did not realize to a single shared native instance",
                )
        appearance_material_ids = list(native_appearance_materials.keys())
        for left_index, left_id in enumerate(appearance_material_ids):
            for right_id in appearance_material_ids[left_index + 1 :]:
                if material_appearance._same_material_instance(
                    native_appearance_materials[left_id], native_appearance_materials[right_id]
                ):
                    raise MutationError(
                        "CORONA_MATERIAL_ASSIGNMENT_FAILED",
                        f"Distinct materials {left_id} and {right_id} were merged into one native "
                        "instance",
                    )
        migrated_material_count = len(native_appearance_materials)
    elif operation["type"] == "MoveObject":
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
    elif operation["type"] == "AssignMaterial":
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
    elif operation["type"] == "ReplaceAsset":
        old_asset_definition_id = operation.get("oldAssetDefinitionId")
        new_asset_definition = operation.get("newAssetDefinition")
        if not isinstance(old_asset_definition_id, str) or not isinstance(
            new_asset_definition, dict
        ):
            raise MutationError("REVISION_PLAN_INVALID", "ReplaceAsset plan is incomplete")
        if operation.get("placementPolicy") != "preserve_anchor":
            raise MutationError(
                "REVISION_PLAN_INVALID", "ReplaceAsset placement policy is invalid"
            )
        new_asset_definition_id = new_asset_definition.get("id")
        dimensions = new_asset_definition.get("dimensions")
        if (
            not isinstance(new_asset_definition_id, str)
            or not isinstance(dimensions, list)
            or len(dimensions) != 3
            or not all(isinstance(dimension, (int, float)) and dimension > 0 for dimension in dimensions)
        ):
            raise MutationError("REVISION_PLAN_INVALID", "ReplaceAsset definition is invalid")
        if _user_prop(target, "AIArchViz.AssetDefinitionId") != old_asset_definition_id:
            raise MutationError(
                "ASSET_DEFINITION_STATE_MISMATCH",
                f"Target {target_id} definition does not match verified base state",
            )
        if str(rt.classOf(target)).lower() != "box":
            raise MutationError("TARGET_TYPE_MISMATCH", f"Target {target_id} is not a Box proxy")
        anchor_before = _proxy_anchor_signature(target)
        material_before = _proxy_material_signature(target)
        locks_before = _proxy_lock_signature(target)
        target.width = float(dimensions[0])
        target.length = float(dimensions[1])
        target.height = float(dimensions[2])
        if _proxy_anchor_signature(target) != anchor_before:
            raise MutationError(
                "PRESERVE_ANCHOR_VIOLATION",
                f"ReplaceAsset changed target {target_id} transform",
            )
        if _proxy_material_signature(target) != material_before:
            raise MutationError(
                "MATERIAL_PRESERVATION_VIOLATION",
                f"ReplaceAsset changed target {target_id} material",
            )
        if _proxy_lock_signature(target) != locks_before:
            raise MutationError(
                "LOCK_PRESERVATION_VIOLATION",
                f"ReplaceAsset changed target {target_id} locks",
            )
        rt.setUserProp(target, "AIArchViz.AssetDefinitionId", new_asset_definition_id)
        replaced_asset_definition_id = new_asset_definition_id
    else:
        property_path = operation.get("propertyPath")
        if property_path not in LOCK_USER_PROPERTIES:
            raise MutationError("REVISION_PLAN_INVALID", "Property lock path is invalid")
        if operation["type"] == "LockProperty":
            rt.setUserProp(target, LOCK_USER_PROPERTIES[property_path], "true")
            locked_property_path = property_path
        else:
            rt.deleteUserProp(target, LOCK_USER_PROPERTIES[property_path])
            if _user_prop(target, LOCK_USER_PROPERTIES[property_path]) is not None:
                rt.setUserProp(target, LOCK_USER_PROPERTIES[property_path], "false")
            unlocked_property_path = property_path

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
            elif operation["type"] == "ReplaceAsset":
                entry["assetDefinitionId"] = operation["newAssetDefinition"]["id"]
                entry["dimensions"] = operation["newAssetDefinition"]["dimensions"]
                metadata["AIArchViz.AssetDefinitionId"] = operation["newAssetDefinition"]["id"]
            elif operation["type"] in {"LockProperty", "UnlockProperty"}:
                current_locks = entry.get("locks", {})
                if not isinstance(current_locks, dict):
                    raise MutationError("MANIFEST_ENTRY_INVALID", "Lock metadata is invalid")
                active_locks = {
                    property_path: True
                    for property_path in LOCK_USER_PROPERTIES
                    if current_locks.get(property_path) is True
                }
                if operation["type"] == "LockProperty":
                    active_locks[operation["propertyPath"]] = True
                else:
                    active_locks.pop(operation["propertyPath"], None)
                if active_locks:
                    entry["locks"] = active_locks
                else:
                    entry.pop("locks", None)
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
        "revisionRunnerVersion": plan["revisionPlanVersion"],
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
        "lockedPropertyPath": locked_property_path,
        "unlockedPropertyPath": unlocked_property_path,
        "replacedAssetDefinitionId": replaced_asset_definition_id,
        "renderIntentConfigured": render_intent_configured,
        "addedLightId": added_light_id,
        "migratedMaterialCount": migrated_material_count,
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
