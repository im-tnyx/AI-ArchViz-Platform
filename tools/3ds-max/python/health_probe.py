"""Repository-controlled, read-only 3ds Max Python/pymxs health probe."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


PROBE_VERSION = "0.1.0"
RESULT_ENVIRONMENT_KEY = "AI_ARCHVIZ_HEALTH_RESULT_PATH"


def _safe_version(runtime: Any) -> str | None:
    try:
        version = runtime.maxVersion()
        return ".".join(str(part) for part in version)
    except Exception:
        return None


def _safe_unit_state(runtime: Any) -> dict[str, Any] | None:
    try:
        return {
            "systemType": str(runtime.units.SystemType),
            "systemScale": float(runtime.units.SystemScale),
            "displayType": str(runtime.units.DisplayType),
        }
    except Exception:
        return None


def collect_probe_result() -> tuple[dict[str, Any], int]:
    result: dict[str, Any] = {
        "probeVersion": PROBE_VERSION,
        "status": "FAILED",
        "dcc": "3ds_max",
        "dccVersion": None,
        "pythonAvailable": True,
        "pymxsAvailable": False,
        "unitState": None,
        "errorCode": "PYMXS_UNAVAILABLE",
        "message": None,
    }

    try:
        import pymxs  # type: ignore[import-not-found]

        runtime = pymxs.runtime
        result.update(
            {
                "status": "SUCCESS",
                "dccVersion": _safe_version(runtime),
                "pymxsAvailable": True,
                "unitState": _safe_unit_state(runtime),
                "errorCode": None,
            }
        )
        return result, 0
    except Exception as error:
        result["message"] = f"{type(error).__name__}: {error}"
        return result, 2


def write_result(result: dict[str, Any]) -> None:
    result_path_value = os.environ.get(RESULT_ENVIRONMENT_KEY)
    if not result_path_value:
        raise RuntimeError(f"Missing trusted environment value: {RESULT_ENVIRONMENT_KEY}")

    result_path = Path(result_path_value)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = result_path.with_suffix(f"{result_path.suffix}.tmp")
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    temporary_path.write_text(f"{payload}\n", encoding="utf-8", newline="\n")
    os.replace(temporary_path, result_path)
    print(f"AI_ARCHVIZ_HEALTH_RESULT={payload}", flush=True)


def main() -> int:
    result, exit_code = collect_probe_result()
    try:
        write_result(result)
    except Exception as error:
        fallback = {
            **result,
            "status": "FAILED",
            "errorCode": "PYTHON_PROBE_FAILED",
            "message": f"{type(error).__name__}: {error}",
        }
        print(
            "AI_ARCHVIZ_HEALTH_RESULT="
            + json.dumps(fallback, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            flush=True,
        )
        return 3
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
