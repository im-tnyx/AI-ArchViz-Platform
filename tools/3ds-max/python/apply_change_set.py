"""Apply the trusted Spike 2 MoveObject plan to an isolated verified scene copy."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from pymxs import runtime as rt


REVISION_RUNNER_VERSION = "0.1.0"


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


def apply_revision() -> dict[str, Any]:
    base_path = _required_path("AI_ARCHVIZ_BASE_SCENE_PATH")
    candidate_path = _required_path("AI_ARCHVIZ_CANDIDATE_PATH")
    plan_path = _required_path("AI_ARCHVIZ_REVISION_PLAN_PATH")
    result_path = _required_path("AI_ARCHVIZ_MUTATION_RESULT_PATH")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if plan.get("revisionPlanVersion") != REVISION_RUNNER_VERSION:
        raise MutationError("REVISION_PLAN_UNSUPPORTED", "Unsupported revision plan version")
    operation = plan.get("operation")
    if not isinstance(operation, dict) or operation.get("type") != "MoveObject":
        raise MutationError("OPERATION_UNSUPPORTED", "Spike 2 runner supports MoveObject only")
    if not base_path.exists() or base_path.stat().st_size <= 0:
        raise MutationError("BASE_ARTIFACT_MISSING", "Verified base checkpoint is missing")
    if not rt.loadMaxFile(str(base_path), useFileUnits=True, quiet=True):
        raise MutationError("BASE_ARTIFACT_OPEN_FAILED", "Could not open verified base checkpoint")
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

    target_id = str(operation["targetId"])
    targets = logical_nodes.get(target_id, [])
    if not targets:
        raise MutationError("TARGET_NOT_FOUND", f"Target {target_id} was not found")
    if len(targets) > 1:
        raise MutationError("DUPLICATE_LOGICAL_ID", f"Target {target_id} is not unique")
    target = targets[0]
    transform = operation["transform"]
    target.pos = _point(transform["position"])
    rotation = transform["rotationEuler"]
    target.rotation = rt.EulerAngles(
        float(rotation[0]),
        float(rotation[1]),
        float(rotation[2]),
    )
    target.scale = _point(transform["scale"])

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
            entry["transform"] = transform
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
        "revisionRunnerVersion": REVISION_RUNNER_VERSION,
        "status": "SUCCESS",
        "changeSetId": plan["changeSetId"],
        "baseRevisionId": plan["baseRevisionId"],
        "targetRevisionId": plan["targetRevisionId"],
        "targetLogicalId": target_id,
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
