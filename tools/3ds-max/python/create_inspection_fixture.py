"""Create the controlled Spike 7B external .max fixture in a fresh batch process."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from pymxs import runtime as rt


FIXTURE_VERSION = "0.1.0"
FIXTURE_DIMENSIONS_MM = [2200.0, 900.0, 760.0]


def _required_path(key: str) -> Path:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Missing trusted environment value: {key}")
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


def _normalize_units() -> None:
    rt.units.SystemType = rt.Name("millimeters")
    rt.units.SystemScale = 1.0
    rt.units.DisplayType = rt.Name("metric")
    try:
        rt.units.MetricType = rt.Name("millimeters")
    except Exception:
        pass
    if "millimeter" not in str(rt.units.SystemType).lower():
        raise RuntimeError(f"Fixture system units are not millimeters: {rt.units.SystemType}")


def create_fixture() -> dict[str, Any]:
    source_path = _required_path("AI_ARCHVIZ_INSPECTION_FIXTURE_PATH")
    result_path = _required_path("AI_ARCHVIZ_INSPECTION_FIXTURE_RESULT_PATH")
    rt.resetMaxFile(rt.Name("noPrompt"))
    _normalize_units()

    width, length, height = FIXTURE_DIMENSIONS_MM
    sofa = rt.Box(width=width, length=length, height=height)
    sofa.name = "inspection_fixture_sofa"
    # A 3ds Max Box is centered on its X/Y transform origin and rests at local
    # Z=0. This places the observed pivot at the floor-center anchor.
    sofa.pos = rt.Point3(width / 2.0, length / 2.0, 0.0)
    material = rt.StandardMaterial()
    material.name = "inspection_fixture_standard_material"
    material.diffuse = rt.Color(96, 112, 128)
    sofa.material = material

    source_path.parent.mkdir(parents=True, exist_ok=True)
    if not rt.saveMaxFile(str(source_path), useNewFile=True, quiet=True):
        raise RuntimeError("3ds Max did not save the controlled inspection fixture")
    if not source_path.exists() or source_path.stat().st_size <= 0:
        raise RuntimeError("Controlled inspection fixture is missing or empty")

    result = {
        "fixtureVersion": FIXTURE_VERSION,
        "status": "SUCCESS",
        "dimensionsMm": FIXTURE_DIMENSIONS_MM,
        "expectedPivotPositionMm": [width / 2.0, length / 2.0, 0.0],
        "units": {
            "systemType": str(rt.units.SystemType),
            "systemScale": float(rt.units.SystemScale),
            "displayType": str(rt.units.DisplayType),
        },
        "sourceSizeBytes": source_path.stat().st_size,
    }
    _write_json(result_path, result)
    return result


def main() -> int:
    result_path = _required_path("AI_ARCHVIZ_INSPECTION_FIXTURE_RESULT_PATH")
    try:
        result = create_fixture()
        print("AI_ARCHVIZ_INSPECTION_FIXTURE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:
        result = {
            "fixtureVersion": FIXTURE_VERSION,
            "status": "FAILED",
            "errorCode": "INSPECTION_FIXTURE_BUILD_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        _write_json(result_path, result)
        print("AI_ARCHVIZ_INSPECTION_FIXTURE_RESULT=" + json.dumps(result, separators=(",", ":")), flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
