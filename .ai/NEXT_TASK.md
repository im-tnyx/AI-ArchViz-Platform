# Next Allowed Task

Technical Spike 10C (reviewed CAD architectural extraction -> canonical
SceneSpec v0.4 seed, and the first DXF -> editable .max build) is complete
and verified on 3ds Max 2025.3 compatibility mode; see
[STATUS.md](STATUS.md) and [VALIDATION.md](VALIDATION.md). Target 3ds Max
2026 verification is still required.

The post-10C polygon surface realization closure is also complete: the
shared initial build now realizes exact canonical polygon floors/ceilings
(translated, non-axis-aligned, concave), verified physically before
promotion.

Technical Spike 10D (deterministic multi-space shared-boundary topology:
`architectural-topology-v0.1`, shared boundaries, space adjacency,
interior-door resolution) is complete; see [STATUS.md](STATUS.md) and
[VALIDATION.md](VALIDATION.md). It made no SceneSpec or DCC change.

Technical Spike 10E (reviewed shared-partition geometry:
`cad-topology-approval-v0.1` -> `reviewed-partition-model-v0.1`, partition
centerlines, dual interior faces, reviewed interior-door orientation, exact
wall segmentation) is complete. It made no SceneSpec or DCC change.

## No committed next spike

There is no authorized next spike. A plausible future candidate, NOT
authorized:

- Technical Spike 10F — Canonical Multi-Space SceneSpec Contract &
  Shared-Partition Realization. It may introduce the exact SceneSpec
  representation needed for shared partitions, adjacent spaces, interior
  doors, space-side faces, spatial/circulation semantics, and DCC
  realization.

Other directions (a production DWG adapter, an approval / review UX,
AI-assisted interpretation) remain unauthorized as well.

Do not start 10F or any other new spike, renderer, AI integration,
download, DWG/AutoCAD integration, or production external `ReplaceAsset`
path without explicit user authorization and a separate scope description.
