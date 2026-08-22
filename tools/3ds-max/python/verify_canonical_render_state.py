"""Fresh-process verifier for the canonical Corona render state."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(__file__))

from pymxs import runtime as rt

import render_corona_baseline as corona


VERIFY_VERSION = "0.1.0"
TOLERANCE = 0.01
ROTATION_TOLERANCE = 0.001
LIGHT_PROPERTIES = {
    "logical": "AIArchViz.LogicalObjectId",
    "project": "AIArchViz.ProjectId",
    "scene": "AIArchViz.SceneId",
    "revision": "AIArchViz.RevisionId",
    "type": "AIArchViz.LightType",
    "canonicalIntensity": "AIArchViz.CanonicalIntensity",
    "mappedIntensity": "AIArchViz.MappedIntensity",
    "widthMm": "AIArchViz.WidthMm",
}


class RenderStateError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise RenderStateError("TRUSTED_INPUT_MISSING", f"Missing trusted environment value: {key}")
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


def _close(left: float, right: float, tolerance: float = TOLERANCE) -> bool:
    return abs(float(left) - float(right)) <= tolerance


def _angle_close(left: float, right: float) -> bool:
    difference = (float(left) - float(right) + 180.0) % 360.0 - 180.0
    return abs(difference) <= ROTATION_TOLERANCE


def _vector(value: Any) -> list[float]:
    return [float(value.x), float(value.y), float(value.z)]


def _euler(node: Any) -> list[float]:
    value = rt.quatToEuler(node.rotation)
    return [float(value.x), float(value.y), float(value.z)]


def _check_vector(expected: list[float], actual: list[float], label: str) -> None:
    if len(expected) != len(actual) or any(
        not _close(expected[index], actual[index]) for index in range(len(expected))
    ):
        raise RenderStateError("LIGHT_PHYSICAL_PROPERTY_MISMATCH", f"{label}: expected {expected}, actual {actual}")


def _check_rotation(expected: list[float], actual: list[float], label: str) -> None:
    if len(expected) != len(actual) or any(
        not _angle_close(expected[index], actual[index]) for index in range(len(expected))
    ):
        raise RenderStateError("LIGHT_PHYSICAL_PROPERTY_MISMATCH", f"{label}: expected {expected}, actual {actual}")


def _safe_scene() -> dict[str, Any]:
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE") == "safe_scene":
        raise RenderStateError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
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
        raise RenderStateError("SAFE_SCENE_REQUIRED", "Safe Scene must be command-line locked")
    return observation


def _actual_property(instance: Any, exact_names: tuple[str, ...], tokens: tuple[str, ...]) -> float:
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE") == "property_missing":
        raise RenderStateError("CORONA_LIGHT_PROPERTY_UNSUPPORTED", "Trusted test forced property failure")
    try:
        _name, value = corona.read_discovered_property(instance, exact_names, tokens)
        return float(value)
    except Exception as error:
        if isinstance(error, RenderStateError):
            raise
        code = getattr(error, "code", "CORONA_LIGHT_PROPERTY_UNSUPPORTED")
        raise RenderStateError(str(code), str(error)) from error


def verify() -> tuple[dict[str, Any], dict[str, Any]]:
    candidate_path = _required_path("AI_ARCHVIZ_CANDIDATE_PATH")
    expected_path = _required_path("AI_ARCHVIZ_EXPECTED_RENDER_STATE_PATH")
    evidence_path = _required_path("AI_ARCHVIZ_RENDER_STATE_PATH")
    result_path = _required_path("AI_ARCHVIZ_RENDER_STATE_RESULT_PATH")
    expected = json.loads(expected_path.read_text(encoding="utf-8"))
    forced_failure = os.environ.get("AI_ARCHVIZ_TEST_FORCE_RENDER_STATE_FAILURE")
    if forced_failure == "timeout":
        time.sleep(300)
    if not candidate_path.exists() or candidate_path.stat().st_size <= 0:
        raise RenderStateError("CANDIDATE_MISSING", "Candidate scene is missing")
    if not rt.loadMaxFile(str(candidate_path), useFileUnits=True, quiet=True):
        raise RenderStateError("CANDIDATE_OPEN_FAILED", "Could not open candidate scene")
    safe_scene = _safe_scene()
    if forced_failure == "corona_missing":
        raise RenderStateError("CORONA_NOT_FOUND", "Trusted test forced Corona absence")
    if forced_failure == "render_state_mismatch":
        raise RenderStateError("RENDER_STATE_MISMATCH", "Trusted test forced render-state mismatch")
    if forced_failure == "duplicate_logical_light":
        raise RenderStateError("DUPLICATE_LOGICAL_LIGHT", "Trusted test forced duplicate logical light")
    if forced_failure == "light_physical_mismatch":
        raise RenderStateError("LIGHT_PHYSICAL_PROPERTY_MISMATCH", "Trusted test forced light property mismatch")
    production = getattr(rt.renderers, "production", None)
    actual_renderer_class = str(rt.classOf(production)).replace("#", "") if production is not None else ""
    if not production or "corona" not in corona._normalized_name(actual_renderer_class):
        raise RenderStateError("CORONA_NOT_FOUND", "Production renderer is not Corona")
    expected_render = expected.get("render")
    if not isinstance(expected_render, dict) or expected_render.get("engine") != "corona" or expected_render.get("mode") != "preview":
        raise RenderStateError("RENDER_STATE_MISMATCH", "Expected render state is not Corona preview")
    expected_lights = expected.get("lights")
    if not isinstance(expected_lights, list):
        raise RenderStateError("RENDER_STATE_MISMATCH", "Expected lights are malformed")
    all_lights = [
        node for node in list(rt.objects)
        if _user_prop(node, LIGHT_PROPERTIES["type"]) == "area"
        or _user_prop(node, LIGHT_PROPERTIES["logical"]) in {str(entry.get("logicalId")) for entry in expected_lights}
    ]
    expected_ids = [str(entry.get("logicalId")) for entry in expected_lights]
    actual_ids = [_user_prop(node, LIGHT_PROPERTIES["logical"]) for node in all_lights]
    if len(actual_ids) != len(set(actual_ids)):
        raise RenderStateError("DUPLICATE_LOGICAL_LIGHT", "Duplicate canonical light logical ID")
    if sorted(actual_ids) != sorted(expected_ids):
        raise RenderStateError("LIGHT_STATE_MISMATCH", f"Expected {expected_ids}, actual {actual_ids}")
    evidence_lights: list[dict[str, Any]] = []
    for expected_light in sorted(expected_lights, key=lambda entry: str(entry["logicalId"])):
        logical_id = str(expected_light["logicalId"])
        matches = [node for node in all_lights if _user_prop(node, LIGHT_PROPERTIES["logical"]) == logical_id]
        if len(matches) != 1:
            raise RenderStateError("DUPLICATE_LOGICAL_LIGHT", f"Expected exactly one {logical_id}")
        light = matches[0]
        if forced_failure == "light_missing":
            raise RenderStateError("CORONA_LIGHT_CLASS_NOT_FOUND", "Trusted test forced CoronaLight absence")
        actual_class = str(rt.classOf(light)).replace("#", "")
        if corona._normalized_name(actual_class) != "coronalight":
            raise RenderStateError("CORONA_LIGHT_CLASS_NOT_FOUND", f"{logical_id} is not CoronaLight")
        if _user_prop(light, LIGHT_PROPERTIES["type"]) != "area":
            raise RenderStateError("LIGHT_STATE_MISMATCH", f"{logical_id} is not an area light")
        _check_vector(expected_light["position"], _vector(light.pos), f"{logical_id}.position")
        _check_rotation(expected_light["rotationEuler"], _euler(light), f"{logical_id}.rotationEuler")
        actual_intensity = _actual_property(light, ("intensity", "multiplier", "intensitymultiplier"), ("intensity",))
        actual_width = _actual_property(light, ("width", "size", "radius"), ("width",))
        canonical_intensity = float(_user_prop(light, LIGHT_PROPERTIES["canonicalIntensity"]) or "nan")
        mapped_intensity = float(_user_prop(light, LIGHT_PROPERTIES["mappedIntensity"]) or "nan")
        width_metadata = float(_user_prop(light, LIGHT_PROPERTIES["widthMm"]) or "nan")
        if not _close(canonical_intensity, float(expected_light["canonicalIntensity"])):
            raise RenderStateError("LIGHT_PHYSICAL_PROPERTY_MISMATCH", f"{logical_id} canonical intensity metadata mismatch")
        if not _close(mapped_intensity, float(expected_light["mappedIntensity"])) or not _close(actual_intensity, mapped_intensity):
            raise RenderStateError("LIGHT_PHYSICAL_PROPERTY_MISMATCH", f"{logical_id} intensity mismatch")
        if not _close(width_metadata, float(expected_light["widthMm"])) or not _close(actual_width, width_metadata):
            raise RenderStateError("LIGHT_PHYSICAL_PROPERTY_MISMATCH", f"{logical_id} width mismatch")
        evidence_lights.append({
            "logicalId": logical_id,
            "type": "area",
            "actualClass": "CoronaLight",
            # Evidence carries the canonical contract values after the
            # tolerance-checked runtime observation.  DCC float conversion
            # (for example -34.999992 instead of -35) must not create a new
            # semantic revision or make replay machine-dependent.
            "position": [float(value) for value in expected_light["position"]],
            "rotationEuler": [float(value) for value in expected_light["rotationEuler"]],
            "canonicalIntensity": float(expected_light["canonicalIntensity"]),
            "mappedIntensity": float(expected_light["mappedIntensity"]),
            "widthMm": float(expected_light["widthMm"]),
        })
    evidence = {
        "renderStateVersion": "0.1.0",
        "sceneId": str(expected["sceneId"]),
        "revisionId": str(expected["revisionId"]),
        "render": {"engine": "corona", "mode": "preview", "actualRendererClass": "Corona"},
        "lights": evidence_lights,
        "status": "PASS",
    }
    _write_json(evidence_path, evidence)
    result = {
        "verificationVersion": VERIFY_VERSION,
        "status": "SUCCESS",
        "safeScene": safe_scene,
        "actualRendererClass": actual_renderer_class,
        "lightCount": len(evidence_lights),
    }
    _write_json(result_path, result)
    return evidence, result


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_RENDER_STATE_RESULT_PATH")
    try:
        _, result = verify()
        print("AI_ARCHVIZ_RENDER_STATE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        result = {
            "verificationVersion": VERIFY_VERSION,
            "status": "FAILED",
            "errorCode": error.code if isinstance(error, RenderStateError) else "RENDER_STATE_VERIFICATION_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_RENDER_STATE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
