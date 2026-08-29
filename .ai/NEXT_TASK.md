# Next Allowed Task

Technical Spike 8F (canonical material appearance contract: SceneSpec v0.3
`roughness`/`metalness`, Corona execution plan v0.2) is complete and
verified; see [STATUS.md](STATUS.md) and [VALIDATION.md](VALIDATION.md).

## Provisional next candidate: Technical Spike 8G — Canonical Material Appearance Revision for Golden Scene

Not started. Concept only: an explicit material-appearance revision/migration
that moves Golden `rev_golden_0010` (still SceneSpec v0.2) forward to a new
canonical v0.3 Golden revision, with roughness/metalness values chosen as a
deliberate canonical design decision per material — never invented
automatically from the v0.2/plan-v0.1 adapter defaults (`0.45`/non-metal).
This is a provisional candidate only, evaluated from 8F's actual findings,
not a committed scope. It requires explicit user authorization before any
implementation begins. Do not start it, and do not begin any other new
renderer, AI integration, download, or production external `ReplaceAsset`
path, without separate scope.
