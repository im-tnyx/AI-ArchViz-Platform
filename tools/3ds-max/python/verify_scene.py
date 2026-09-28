"""Fresh-process semantic verifier for the Spike 1B candidate scene."""

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

import render_corona_material_appearance as material_appearance


VERIFY_VERSION = "0.1.0"
TOLERANCE = 0.01
LOCK_USER_PROPERTIES = {
    "geometry": "AIArchViz.LockGeometry",
    "transform": "AIArchViz.LockTransform",
    "material": "AIArchViz.LockMaterial",
}


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


def _require_safe_scene_when_requested() -> None:
    """Fail closed for flows that require an observed Safe Scene lock.

    Normal deterministic fixture verification remains unchanged; controlled
    external ingestion sets the environment flag and therefore requires the
    same command-line lock posture proven by its isolated inspector.
    """
    if os.environ.get("AI_ARCHVIZ_REQUIRE_SAFE_SCENE") != "1":
        return
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_EXTERNAL_SAFE_SCENE_FAILURE") == "1":
        raise RuntimeError("SAFE_SCENE_REQUIRED: trusted test forced failure")
    manager = rt.SceneScriptSecurityManager
    enabled = bool(manager.IsSafeSceneScriptExecutionEnabled(rt.Name("Current")))
    locked = bool(manager.AreSettingsLocked())
    cause = str(manager.GetCauseOfLock()).replace("#", "").lower()
    protected = bool(manager.IsSafeScriptAssetExecutionEnabled())
    if not (enabled and locked and cause == "cmdline" and protected):
        raise RuntimeError("SAFE_SCENE_REQUIRED: command-line lock posture was not observed")


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


def _is_corona_physical_material(material: Any) -> bool:
    class_name = str(rt.classOf(material)).lower()
    return "corona" in class_name and "physical" in class_name


def _normalized_material_color(material: Any) -> list[float] | None:
    try:
        if _is_corona_physical_material(material):
            return material_appearance._read_base_color(material)
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
    class_name = str(rt.classOf(material)).lower()
    if "standard" not in class_name and not _is_corona_physical_material(material):
        errors.append(
            f"{entry['logicalId']}: MATERIAL_TYPE_MISMATCH native is not StandardMaterial or "
            "Corona Physical Material"
        )
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
        # Recover the tolerance-checked canonical color, not the raw native
        # reading: a Corona Physical Material's internal float32
        # representation reads back with harmless sub-percent noise relative
        # to a StandardMaterial's exact 8-bit-quantized `.diffuse` (e.g.
        # 0.7200000239 instead of 0.72), which would otherwise appear as a
        # spurious semantic manifest diff on every native-class change even
        # though nothing about the canonical color actually changed.
        entry["materialBaseColorRgb"] = expected_color


def _validate_metadata(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    if str(node.name) != entry["nodeName"]:
        errors.append(f"{entry['logicalId']}: node name mismatch")
    for key, expected in entry["embeddedMetadata"].items():
        actual = _user_prop(node, key)
        if actual != str(expected):
            errors.append(f"{entry['logicalId']}: metadata {key} mismatch")


def _validate_locks(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    expected_value = entry.get("locks", {})
    if not isinstance(expected_value, dict):
        errors.append(f"{entry['logicalId']}: lock metadata is invalid")
        return
    expected = {
        property_path: True
        for property_path in LOCK_USER_PROPERTIES
        if expected_value.get(property_path) is True
    }
    actual = {
        property_path: True
        for property_path, key in LOCK_USER_PROPERTIES.items()
        if (_user_prop(node, key) or "").lower() == "true"
    }
    if expected != actual:
        errors.append(
            f"{entry['logicalId']}: LOCK_MISMATCH expected {expected}, actual {actual}"
        )
        return
    if actual:
        entry["locks"] = actual
    else:
        entry.pop("locks", None)


def _validate_proxy(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    if str(rt.classOf(node)).lower() != "box":
        errors.append(f"{entry['logicalId']}: proxy is not a Box")
        return
    expected_definition_id = entry.get("assetDefinitionId")
    actual_definition_id = _user_prop(node, "AIArchViz.AssetDefinitionId")
    if not expected_definition_id or actual_definition_id != str(expected_definition_id):
        errors.append(
            f"{entry['logicalId']}: ASSET_DEFINITION_ID_MISMATCH expected {expected_definition_id}, actual {actual_definition_id}"
        )
    else:
        entry["assetDefinitionId"] = actual_definition_id
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


class SurfaceVerificationFailed(RuntimeError):
    """Physical surface verification failed; the detailed result is already written."""


def _observe_mesh(node: Any) -> tuple[list[list[float]], list[list[int]]]:
    """World-space vertices and faces of the reopened node, observation only.

    snapshotAsMesh returns a detached world-state TriMesh copy; the node and
    the candidate file are never edited, welded, converted, or saved.
    """
    snapshot = rt.snapshotAsMesh(node)
    try:
        vertices = []
        for index in range(1, int(rt.getNumVerts(snapshot)) + 1):
            vertex = rt.getVert(snapshot, index)
            vertices.append([float(vertex.x), float(vertex.y), float(vertex.z)])
        faces = []
        for index in range(1, int(rt.getNumFaces(snapshot)) + 1):
            face = rt.getFace(snapshot, index)
            faces.append([int(face.x) - 1, int(face.y) - 1, int(face.z) - 1])
    finally:
        rt.delete(snapshot)
    return vertices, faces


def _polygon_area(points: list[list[float]]) -> float:
    twice = 0.0
    for index, point in enumerate(points):
        following = points[(index + 1) % len(points)]
        twice += point[0] * following[1] - following[0] * point[1]
    return twice / 2.0


def _same_xy(left: list[float], right: list[float]) -> bool:
    return _close(left[0], right[0]) and _close(left[1], right[1])


def _verify_surface_physical(
    node: Any, logical_id: str, expected: dict[str, Any], errors: list[str]
) -> dict[str, Any]:
    """Independent physical check of one surface against the canonical SceneSpec.

    Observed state comes only from the reopened mesh (world-space vertices and
    faces). Expected state comes only from the canonical SceneSpec surface.
    """
    failures: list[str] = []
    vertices, faces = _observe_mesh(node)
    expected_boundary = [[float(point[0]), float(point[1])] for point in expected["boundary"]]
    expected_elevation = float(expected["elevation"])
    expected_area = abs(_polygon_area(expected_boundary))
    count = len(expected_boundary)
    perimeter = 0.0
    for index, point in enumerate(expected_boundary):
        following = expected_boundary[(index + 1) % count]
        perimeter += ((following[0] - point[0]) ** 2 + (following[1] - point[1]) ** 2) ** 0.5
    # Merge coincident observed vertices by position (independent of index layout).
    canonical: list[int] = []
    representatives: list[int] = []
    for index, vertex in enumerate(vertices):
        match = None
        for representative in representatives:
            other = vertices[representative]
            if all(abs(vertex[axis] - other[axis]) <= 1e-6 for axis in range(3)):
                match = representative
                break
        if match is None:
            representatives.append(index)
            match = index
        canonical.append(match)
    elevations = [vertex[2] for vertex in vertices]
    if not vertices or any(not _close(z, expected_elevation) for z in elevations):
        failures.append(
            f"elevation expected {expected_elevation}, observed {sorted(set(elevations))}"
        )
    observed_area = 0.0
    orientations: set[int] = set()
    edge_counts: dict[tuple[int, int], int] = {}
    triangles_xy: list[list[list[float]]] = []
    for face in faces:
        if len(set(face)) != 3 or any(index < 0 or index >= len(vertices) for index in face):
            failures.append(f"invalid face index {face}")
            continue
        a, b, c = (vertices[index] for index in face)
        signed = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2.0
        if abs(signed) <= 1e-6:
            failures.append(f"zero-area face {face}")
            continue
        orientations.add(1 if signed > 0 else -1)
        observed_area += abs(signed)
        triangles_xy.append([[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]])
        ids = [canonical[index] for index in face]
        for left, right in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            key = (min(left, right), max(left, right))
            edge_counts[key] = edge_counts.get(key, 0) + 1
    if len(orientations) > 1:
        failures.append("faces have inconsistent winding (overlap or flipped face)")
    if any(value > 2 for value in edge_counts.values()):
        failures.append("non-manifold edge")
    # Outer boundary = edges referenced by exactly one face; must be one loop.
    boundary_edges = [key for key, value in edge_counts.items() if value == 1]
    adjacency: dict[int, list[int]] = {}
    for left, right in boundary_edges:
        adjacency.setdefault(left, []).append(right)
        adjacency.setdefault(right, []).append(left)
    observed_loop: list[list[float]] = []
    if not boundary_edges or any(len(neighbors) != 2 for neighbors in adjacency.values()):
        failures.append("boundary edges do not form a simple closed loop")
    else:
        start = min(adjacency)
        loop = [start]
        previous, current = start, adjacency[start][0]
        while current != start and len(loop) <= len(adjacency):
            loop.append(current)
            neighbors = adjacency[current]
            following = neighbors[0] if neighbors[0] != previous else neighbors[1]
            previous, current = current, following
        if len(loop) != len(adjacency):
            failures.append("more than one boundary loop (hole or disconnected island)")
        observed_loop = [[vertices[index][0], vertices[index][1]] for index in loop]
    # Same geometric polygon: allow a cyclic start offset and either orientation.
    matched: list[list[float]] | None = None
    if len(observed_loop) == count:
        for candidate in (observed_loop, list(reversed(observed_loop))):
            for offset in range(count):
                rotated = candidate[offset:] + candidate[:offset]
                if all(_same_xy(rotated[i], expected_boundary[i]) for i in range(count)):
                    matched = rotated
                    break
            if matched is not None:
                break
    if matched is None:
        failures.append(
            f"observed boundary {observed_loop} does not equal canonical boundary {expected_boundary}"
        )
    if abs(observed_area - expected_area) > TOLERANCE * max(1.0, perimeter):
        failures.append(f"area expected {expected_area}, observed {observed_area}")
    for failure in failures:
        errors.append(f"{logical_id}: SURFACE_GEOMETRY_MISMATCH {failure}")
    return {
        "logicalId": logical_id,
        "type": expected["type"],
        "expectedBoundary": expected_boundary,
        "observedBoundary": matched if matched is not None else observed_loop,
        "expectedElevation": expected_elevation,
        "observedElevation": sum(elevations) / len(elevations) if elevations else None,
        "expectedAreaMm2": expected_area,
        "observedAreaMm2": observed_area,
        "observedVertexCount": len(vertices),
        "observedFaceCount": len(faces),
        "observedTrianglesXY": triangles_xy,
        "status": "PASS" if not failures else "FAILED",
    }


def _validate_surface(node: Any, entry: dict[str, Any], errors: list[str]) -> None:
    class_name = str(rt.classOf(node)).lower()
    if class_name == "editable_mesh":
        # Build plan v0.2: semantic checks on the observed world geometry.
        vertices, _ = _observe_mesh(node)
        xs = [vertex[0] for vertex in vertices]
        ys = [vertex[1] for vertex in vertices]
        _check_vector(
            errors,
            f"{entry['logicalId']}.dimensions",
            entry["dimensions"][:2],
            [max(xs) - min(xs), max(ys) - min(ys)] if vertices else [],
        )
        _check_vector(
            errors,
            f"{entry['logicalId']}.position",
            entry["transform"]["position"],
            _vector(node.pos),
        )
        return
    if class_name != "plane":
        errors.append(f"{entry['logicalId']}: surface is neither an editable mesh nor a legacy Plane")
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
    _require_safe_scene_when_requested()
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

    # Optional canonical EXPECTED state for exact physical surface verification
    # (the initial build always supplies it; the verifier never trusts
    # build-written geometry metadata for surfaces).
    expected_surfaces: dict[str, dict[str, Any]] | None = None
    scene_spec_path = os.environ.get("AI_ARCHVIZ_SCENE_SPEC_PATH")
    if scene_spec_path:
        scene_spec = json.loads(Path(scene_spec_path).read_text(encoding="utf-8"))
        expected_surfaces = {
            str(entry["id"]): entry
            for entry in scene_spec.get("geometry", [])
            if entry.get("type") in {"floor", "ceiling"}
        }

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
        _validate_locks(node, entry, errors)
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

    surface_verification: dict[str, Any] | None = None
    if expected_surfaces is not None:
        reports: list[dict[str, Any]] = []
        for logical_id in sorted(expected_surfaces):
            matches = [
                node
                for node, entry in entries
                if entry.get("logicalId") == logical_id
                and entry.get("type") in {"floor", "ceiling"}
            ]
            if len(matches) != 1:
                errors.append(
                    f"{logical_id}: SURFACE_GEOMETRY_MISMATCH expected exactly one managed surface node"
                )
                continue
            if str(rt.classOf(matches[0])).lower() != "editable_mesh":
                errors.append(
                    f"{logical_id}: SURFACE_GEOMETRY_MISMATCH surface is not an editable mesh"
                )
                continue
            reports.append(
                _verify_surface_physical(
                    matches[0], logical_id, expected_surfaces[logical_id], errors
                )
            )
        surface_verification = {
            "status": "PASS"
            if len(reports) == len(expected_surfaces)
            and all(report["status"] == "PASS" for report in reports)
            else "FAILED",
            "surfaces": reports,
        }

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
        if surface_verification is not None:
            # Persist the physical observation even on failure (diagnostics only).
            _write_json(
                result_path,
                {
                    "verificationVersion": VERIFY_VERSION,
                    "status": "FAILED",
                    "errorCode": "VERIFICATION_FAILED",
                    "message": "; ".join(sorted(errors)),
                    "surfaceVerification": surface_verification,
                },
            )
            raise SurfaceVerificationFailed("; ".join(sorted(errors)))
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
        **(
            {"surfaceVerification": surface_verification}
            if surface_verification is not None
            else {}
        ),
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
    except SurfaceVerificationFailed as error:
        # The detailed FAILED result (with surfaceVerification) is already written.
        print(
            "AI_ARCHVIZ_VERIFY_RESULT="
            + json.dumps({"status": "FAILED", "message": str(error)}, separators=(",", ":")),
            flush=True,
        )
        return 2
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
