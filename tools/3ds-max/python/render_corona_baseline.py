"""Trusted, non-interactive Corona baseline render for Technical Spike 8A.

The worker owns every input and output path. Runtime class collections are used
only to identify installed Corona classes; no renderer index or generated
MAXScript is used.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import pymxs
from pymxs import runtime as rt


RENDER_RUNNER_VERSION = "0.1.0"
RENDER_JOB_VERSION = "0.1.0"
TARGET_DCC_MAJOR_VERSION = 2026
PASS_LIMIT = 4
RENDER_WIDTH = 320
RENDER_HEIGHT = 240
BASE_COLOR_RGB = [0.72, 0.62, 0.50]
CAMERA_ID = "camera_corona_baseline"
MATERIAL_TARGET_ID = "asset_corona_baseline_subject"
LIGHT_ID = "light_corona_baseline"
CAMERA_FOCAL_LENGTH_MM = 35.0
CAMERA_SENSOR_WIDTH_MM = 36.0
INTENSITY_SCALE = 120.0
AREA_LIGHT_WIDTH_MM = 800.0


class CoronaBaselineError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise CoronaBaselineError("TRUSTED_INPUT_MISSING", f"Missing worker-owned input {key}")
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


def _normalized_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).replace("#", "").lower())


def _class_name(value: Any) -> str:
    return str(value).replace("#", "").strip()


def _runtime_major_version() -> int:
    version = rt.maxVersion()
    raw_major = int(version[0])
    sdk_major = raw_major // 1000 if raw_major >= 1000 else raw_major
    return sdk_major + 1998


def _runtime_version() -> str:
    try:
        version = list(rt.maxVersion())
        # The first value is the SDK build while the final numeric value is the
        # 3ds Max product update. Report a portable product version instead of
        # serializing the machine-specific SDK tuple.
        try:
            update = int(version[-1]) if version else None
        except (TypeError, ValueError):
            update = None
        return f"{_runtime_major_version()}.{update}" if update is not None else str(_runtime_major_version())
    except Exception:
        return str(_runtime_major_version())


def _security_observation() -> dict[str, Any]:
    try:
        manager = rt.SceneScriptSecurityManager
        return {
            "safeSceneScriptExecutionEnabled": bool(
                manager.IsSafeSceneScriptExecutionEnabled(rt.Name("Current"))
            ),
            "settingsLocked": bool(manager.AreSettingsLocked()),
            "lockCause": str(manager.GetCauseOfLock()).replace("#", "").lower(),
            "scriptAssetsProtected": bool(manager.IsSafeScriptAssetExecutionEnabled()),
        }
    except Exception as error:
        raise CoronaBaselineError("SAFE_SCENE_REQUIRED", "Safe Scene posture could not be observed") from error


def _require_safe_scene() -> dict[str, Any]:
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_CORONA_SAFE_SCENE_FAILURE") == "1":
        raise CoronaBaselineError("SAFE_SCENE_REQUIRED", "Trusted test forced Safe Scene failure")
    security = _security_observation()
    if not (
        security["safeSceneScriptExecutionEnabled"]
        and security["settingsLocked"]
        and security["lockCause"] == "cmdline"
        and security["scriptAssetsProtected"]
    ):
        raise CoronaBaselineError("SAFE_SCENE_REQUIRED", "Safe Scene must be command-line locked")
    return security


def _normalize_units() -> None:
    rt.units.SystemType = rt.Name("millimeters")
    rt.units.SystemScale = 1.0
    rt.units.DisplayType = rt.Name("metric")
    try:
        rt.units.MetricType = rt.Name("millimeters")
    except Exception:
        pass
    if "millimeter" not in str(rt.units.SystemType).lower() or float(rt.units.SystemScale) != 1.0:
        raise CoronaBaselineError("UNIT_MISMATCH", "Baseline fixture must use millimeters at scale 1")


def _unique_class(
    classes: Iterable[Any], predicate: Any, missing_code: str, ambiguous_code: str
) -> Any:
    candidates = [entry for entry in classes if predicate(_normalized_name(entry))]
    if not candidates:
        raise CoronaBaselineError(missing_code, f"No matching installed class for {missing_code}")
    if len(candidates) != 1:
        names = ", ".join(sorted(_class_name(candidate) for candidate in candidates))
        raise CoronaBaselineError(ambiguous_code, f"Ambiguous installed classes: {names}")
    return candidates[0]


def _discover_corona_renderer() -> tuple[Any, str]:
    renderer_class = _unique_class(
        rt.RendererClass.classes,
        lambda name: "corona" in name,
        "CORONA_NOT_FOUND",
        "CORONA_RENDERER_AMBIGUOUS",
    )
    return renderer_class, _class_name(renderer_class)


def _property_names(instance: Any) -> dict[str, str]:
    return {_normalized_name(name): str(name) for name in rt.getPropNames(instance)}


def read_discovered_property(
    instance: Any, exact_names: tuple[str, ...], required_tokens: tuple[str, ...]
) -> tuple[str, Any]:
    properties = _property_names(instance)
    selected = next((properties[name] for name in exact_names if name in properties), None)
    if selected is None:
        matches = [
            original
            for normalized, original in properties.items()
            if all(token in normalized for token in required_tokens)
        ]
        if len(matches) == 1:
            selected = matches[0]
    if selected is None:
        raise CoronaBaselineError(
            "CORONA_LIGHT_PROPERTY_UNSUPPORTED",
            f"Required Corona property is unavailable: {'/'.join(exact_names)}",
        )
    try:
        return selected, rt.getProperty(instance, rt.Name(selected))
    except Exception as error:
        raise CoronaBaselineError(
            "CORONA_LIGHT_PROPERTY_UNSUPPORTED",
            f"Could not read supported property {selected}",
        ) from error


def _set_discovered_property(
    instance: Any,
    exact_names: tuple[str, ...],
    required_tokens: tuple[str, ...],
    value: Any,
    error_code: str,
) -> str:
    properties = _property_names(instance)
    selected = next((properties[name] for name in exact_names if name in properties), None)
    if selected is None:
        matches = [
            original
            for normalized, original in properties.items()
            if all(token in normalized for token in required_tokens)
        ]
        if len(matches) == 1:
            selected = matches[0]
    if selected is None:
        available = ",".join(sorted(properties))
        raise CoronaBaselineError(
            error_code,
            f"Required Corona property is unavailable: {'/'.join(exact_names)}; available={available}",
        )
    try:
        rt.setProperty(instance, rt.Name(selected), value)
        return selected
    except Exception as error:
        raise CoronaBaselineError(error_code, f"Could not set supported property {selected}") from error


def _observable_plugin_version(renderer: Any) -> str | None:
    properties = _property_names(renderer)
    for candidate in ("pluginversion", "coronaversion", "versionstring", "version"):
        property_name = properties.get(candidate)
        if property_name is None:
            continue
        try:
            value = rt.getProperty(renderer, rt.Name(property_name))
        except Exception:
            continue
        if isinstance(value, (str, int, float)):
            text = str(value).strip()
            if text:
                return text
    return None


def _set_non_metal_mode(material: Any) -> None:
    properties = _property_names(material)
    if "metalness" in properties or "basemetalness" in properties:
        _set_discovered_property(
            material,
            ("basemetalness", "metalness"),
            ("metal",),
            0.0,
            "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
        )
        return
    # Current Corona Physical Material versions can expose a mode rather than
    # a scalar metalness control. Its zero enum value is the non-metal mode.
    if "metalnessmode" in properties:
        _set_discovered_property(
            material,
            ("metalnessmode",),
            ("metal", "mode"),
            0,
            "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
        )
        return
    raise CoronaBaselineError("CORONA_MATERIAL_PROPERTY_UNSUPPORTED", "No non-metal Corona property is available")


def create_corona_physical_material(
    base_color_rgb: list[float] | tuple[float, float, float] = BASE_COLOR_RGB,
    material_name: str = "AVZ_CORONA_BASELINE_MATERIAL",
) -> tuple[Any, str]:
    material_class = _unique_class(
        rt.Material.classes,
        lambda name: "corona" in name and "physical" in name and "mtl" in name,
        "CORONA_MATERIAL_CLASS_NOT_FOUND",
        "CORONA_MATERIAL_CLASS_AMBIGUOUS",
    )
    try:
        material = material_class()
    except Exception as error:
        raise CoronaBaselineError("CORONA_MATERIAL_CLASS_NOT_FOUND", "Corona Physical Material could not be instantiated") from error
    _set_discovered_property(
        material,
        ("basecolor", "basecol"),
        ("base", "color"),
        rt.Color(*(component * 255.0 for component in base_color_rgb)),
        "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
    )
    _set_discovered_property(
        material,
        ("baseroughness", "roughness"),
        ("rough",),
        0.45,
        "CORONA_MATERIAL_PROPERTY_UNSUPPORTED",
    )
    _set_non_metal_mode(material)
    material.name = material_name
    return material, _class_name(rt.classOf(material))


def create_corona_area_light(
    position: list[float] | tuple[float, float, float] = (-1200.0, -1800.0, 2800.0),
    rotation_euler: list[float] | tuple[float, float, float] = (0.0, 0.0, 0.0),
    intensity: float = 120.0,
    width_mm: float = AREA_LIGHT_WIDTH_MM,
    light_name: str = "AVZ_CORONA_BASELINE_LIGHT",
) -> tuple[Any, str]:
    candidates = [
        entry
        for entry in rt.light.classes
        if _normalized_name(entry) == "coronalight"
    ]
    if len(candidates) != 1:
        raise CoronaBaselineError("CORONA_LIGHT_CLASS_NOT_FOUND", "CoronaLight is unavailable")
    try:
        light = candidates[0]()
        light.name = light_name
        light.rotation = rt.EulerAngles(
            float(rotation_euler[0]),
            float(rotation_euler[1]),
            float(rotation_euler[2]),
        )
        light.pos = rt.Point3(float(position[0]), float(position[1]), float(position[2]))
        _set_discovered_property(
            light,
            ("intensity", "multiplier", "intensitymultiplier"),
            ("intensity",),
            float(intensity),
            "CORONA_LIGHT_PROPERTY_UNSUPPORTED",
        )
        _set_discovered_property(
            light,
            ("width", "size", "radius"),
            ("width",),
            float(width_mm),
            "CORONA_LIGHT_PROPERTY_UNSUPPORTED",
        )
        return light, _class_name(rt.classOf(light))
    except Exception:
        try:
            rt.delete(light)
        except Exception:
            pass
        raise


def _try_create_corona_light() -> tuple[Any, str, str] | None:
    try:
        light, class_name = create_corona_area_light()
        return light, class_name, "corona_light"
    except CoronaBaselineError:
        return None


def _create_light() -> tuple[Any, str, str]:
    corona_light = _try_create_corona_light()
    if corona_light is not None:
        return corona_light
    # The fallback is intentional and recorded. Corona supports native 3ds Max
    # lights, while this baseline avoids version-specific CoronaLight controls
    # that may be unavailable on an installed compatibility release.
    stock_light_class = _unique_class(
        rt.light.classes,
        lambda name: name in {"omni", "omnilight"},
        "CORONA_LIGHT_CLASS_NOT_FOUND",
        "CORONA_LIGHT_CLASS_AMBIGUOUS",
    )
    light = stock_light_class()
    light.name = "AVZ_CORONA_BASELINE_LIGHT"
    light.pos = rt.Point3(-1200.0, -1800.0, 2800.0)
    _set_discovered_property(
        light,
        ("multiplier",),
        ("multiplier",),
        3.0,
        "CORONA_LIGHT_PROPERTY_UNSUPPORTED",
    )
    return light, _class_name(rt.classOf(light)), "stock_omni"


def _create_camera() -> tuple[Any, str]:
    camera = rt.Freecamera()
    camera.name = "AVZ_CORONA_BASELINE_CAMERA"
    camera.pos = rt.Point3(0.0, -6200.0, 2500.0)
    camera.rotation = rt.EulerAngles(-14.0, 0.0, 0.0)
    # Native cameras expose FOV, so derive it from a frozen full-frame 35 mm
    # focal length rather than accepting a camera setting from the render job.
    camera.fov = 2.0 * math.atan(CAMERA_SENSOR_WIDTH_MM / (2.0 * CAMERA_FOCAL_LENGTH_MM))
    return camera, _class_name(rt.classOf(camera))


def _create_fixture(material: Any) -> Any:
    floor = rt.Box(width=6000.0, length=6000.0, height=100.0)
    floor.name = "AVZ_CORONA_BASELINE_FLOOR"
    floor.pos = rt.Point3(0.0, 0.0, -50.0)
    floor.material = material

    wall = rt.Box(width=6000.0, length=100.0, height=3000.0)
    wall.name = "AVZ_CORONA_BASELINE_BACK_WALL"
    wall.pos = rt.Point3(0.0, 3000.0, 1500.0)
    wall.material = material

    subject = rt.Box(width=1200.0, length=800.0, height=800.0)
    subject.name = "AVZ_CORONA_BASELINE_SUBJECT"
    subject.pos = rt.Point3(0.0, 400.0, 400.0)
    subject.material = material
    return subject


def _configure_renderer(renderer_class: Any) -> tuple[Any, str, str | None]:
    try:
        renderer = renderer_class()
        rt.renderers.current = renderer
        rt.renderers.production = renderer
    except Exception as error:
        raise CoronaBaselineError("CORONA_RENDERER_ASSIGNMENT_FAILED", "Corona renderer could not be assigned") from error
    observed_class = _class_name(rt.classOf(rt.renderers.production))
    if "corona" not in _normalized_name(observed_class):
        raise CoronaBaselineError("CORONA_RENDERER_ASSIGNMENT_FAILED", "Production renderer is not Corona")
    _set_discovered_property(
        renderer,
        ("passlimit", "progressivepasslimit"),
        ("pass", "limit"),
        PASS_LIMIT,
        "CORONA_PASS_LIMIT_PROPERTY_NOT_FOUND",
    )
    return renderer, observed_class, _observable_plugin_version(renderer)


def _validate_job(job_path: Path) -> None:
    try:
        job = json.loads(job_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise CoronaBaselineError("RENDER_JOB_INVALID", "Worker-controlled render job is unreadable") from error
    if job != {
        "renderJobVersion": RENDER_JOB_VERSION,
        "engine": "corona",
        "cameraId": CAMERA_ID,
        "mode": "preview",
        "resolution": {"width": RENDER_WIDTH, "height": RENDER_HEIGHT},
    }:
        raise CoronaBaselineError("RENDER_JOB_INVALID", "Render job violated frozen baseline policy")


def render_baseline() -> dict[str, Any]:
    job_path = _required_path("AI_ARCHVIZ_CORONA_RENDER_JOB_PATH")
    output_path = _required_path("AI_ARCHVIZ_CORONA_RENDER_OUTPUT_PATH")
    _validate_job(job_path)
    if os.environ.get("AI_ARCHVIZ_TEST_FORCE_CORONA_TIMEOUT") == "1":
        time.sleep(300)

    rt.resetMaxFile(rt.Name("noPrompt"))
    security = _require_safe_scene()
    _normalize_units()
    renderer_class, discovered_class_name = _discover_corona_renderer()
    renderer, observed_renderer_class, plugin_version = _configure_renderer(renderer_class)
    if _normalized_name(discovered_class_name) != _normalized_name(observed_renderer_class):
        raise CoronaBaselineError("CORONA_RENDERER_ASSIGNMENT_FAILED", "Renderer class identity changed on assignment")
    material, material_class = create_corona_physical_material()
    subject = _create_fixture(material)
    _light, light_class, light_strategy = _create_light()
    camera, camera_class = _create_camera()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        output_path.unlink()
    rt.rendShowVFB = False
    try:
        bitmap = rt.render(
            camera=camera,
            outputwidth=RENDER_WIDTH,
            outputheight=RENDER_HEIGHT,
            outputFile=str(output_path),
            vfb=False,
        )
        try:
            bitmap.close()
        except Exception:
            pass
    except Exception as error:
        message = str(error)
        if any(token in message.lower() for token in ("license", "licence", "activation", "sign in")):
            raise CoronaBaselineError("CORONA_LICENSE_UNAVAILABLE", "Corona rendering requires an unavailable license") from error
        raise CoronaBaselineError("CORONA_RENDER_FAILED", "Corona render invocation failed") from error
    if not output_path.exists() or output_path.stat().st_size <= 0:
        raise CoronaBaselineError("RENDER_OUTPUT_INVALID", "Corona did not create a non-empty PNG")

    return {
        "status": "PASS",
        "runnerVersion": RENDER_RUNNER_VERSION,
        "renderer": {"className": observed_renderer_class, "version": plugin_version},
        "dcc": {"version": _runtime_version(), "compatibilityMode": _runtime_major_version() != TARGET_DCC_MAJOR_VERSION},
        "camera": {"logicalId": CAMERA_ID, "className": camera_class},
        "material": {
            "className": material_class,
            "baseColorRgb": BASE_COLOR_RGB,
            "targetLogicalId": MATERIAL_TARGET_ID,
        },
        "light": {"logicalId": LIGHT_ID, "className": light_class, "strategy": light_strategy},
        "termination": {"type": "pass_limit", "value": PASS_LIMIT},
        "resolution": {"width": RENDER_WIDTH, "height": RENDER_HEIGHT},
        "security": security,
        "fixture": {"subjectClass": _class_name(rt.classOf(subject)), "externalTextures": 0, "xrefs": 0},
    }


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_CORONA_RENDER_RESULT_PATH")
    try:
        result = render_baseline()
        _write_json(result_path, result)
        print("AI_ARCHVIZ_CORONA_RENDER_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except CoronaBaselineError as error:
        result = {"status": "FAILED", "failureCode": error.code, "message": str(error)}
    except Exception as error:
        result = {"status": "FAILED", "failureCode": "CORONA_RENDER_FAILED", "message": f"{type(error).__name__}: {error}"}
    _write_json(result_path, result)
    print("AI_ARCHVIZ_CORONA_RENDER_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
    return 2


if __name__ == "__main__":
    sys.exit(main())
