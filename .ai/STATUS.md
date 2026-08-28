# Current Status

## Local baseline

- Local `main` HEAD: `9dd86cf`
- Commit: `fix: harden render state and dcc environment`
- Remote tracking state at this snapshot: `origin/main` and local `main` both
  resolve to `9dd86cf`.

## Verified capability boundary

- Deterministic SceneSpec build and SceneChangeSet revision pipeline are in
  place through canonical Corona render-state revisions (rev9 `SetRenderIntent`,
  rev10 `AddLight`).
- `ReplaceAsset` preserves logical object identity, transform, material, and
  locks while changing immutable `assetDefinitionId` and intrinsic geometry,
  including a controlled `VERIFIED` external `.max` source (Spike 7C).
- Fresh-process semantic manifest verification and durable idempotent replay
  are required before a candidate `.max` becomes canonical; the same pattern
  now extends to a fresh canonical render-state verification pass.
- Corona is integrated end-to-end: renderer/material/light discovery and
  realization (8A), a pure `SceneSpec -> CoronaExecutionPlan` adapter (8B), a
  non-canonical Golden preview render (8C), and canonical render-state
  revisions with CoronaLight evidence (8D).
- DCC execution is default-deny end-to-end: trusted local worker configuration
  must set `allowDccExecution: true`, the call site must separately authorize
  the specific launch, and DCC integration suites additionally require
  explicit `AI_ARCHVIZ_ALLOW_DCC_TESTS=1` operator opt-in. `runControlledProcess`
  now requires an explicit `env`; there is no implicit `process.env` fallback.
- Every DCC child process receives an environment built by the shared
  `buildDccChildEnvironment` allowlist (Windows runtime keys plus the exact
  proven `VRAY_FOR_3DSMAX2025_MAIN` key) plus caller-owned `AI_ARCHVIZ_*`
  overrides only; secret and untrusted parent variables never reach a DCC
  process. See [VALIDATION.md](VALIDATION.md) for the regression evidence.
- Local DCC evidence covers 3ds Max 2025.3 compatibility mode across every
  mandatory `test:3dsmax:*` suite. Production target 3ds Max 2026 is not yet
  verified.

## Current guardrails

- SceneSpec is the canonical software-independent contract.
- Real editable 3D scenes, not generated images, are the source of truth.
- No new renderer, AI provider integration, or new spike begins without
  explicit scope authorization. Technical Spike 8E is authorized to start only
  when the user explicitly asks for it (see [NEXT_TASK.md](NEXT_TASK.md)).

## Locally validated worktree milestone

- Post-8D hardening closed three residual gaps without touching the default-
  deny model: canonical render-state evidence lights now sort by `logicalId`
  (source `SceneSpec` order is untouched); the canonical Corona preview and
  `SetRenderIntent` preparation reject non-`area` lights with
  `RENDERER_LIGHT_TYPE_UNSUPPORTED` before any DCC process launches; and every
  remaining call site that built a DCC child environment from
  `{...process.env, ...}` now goes through `buildDccChildEnvironment`.
- A staged diagnostic ladder (bare `3dsmaxbatch` probe -> Corona discovery ->
  Corona object realization -> narrow Corona render suites -> full canonical
  render-state revision suite) confirmed the sanitized environment is
  compatible with the installed 3ds Max 2025.3 + Corona toolchain, and
  regression-proved that `VRAY_FOR_3DSMAX2025_MAIN` (only; not `_PLUGINS`) is
  required because Corona shares Chaos's V-Ray USD/DR startup component.
- Target 3ds Max 2026 verification has not occurred on this workstation.

See [VALIDATION.md](VALIDATION.md) for executed checks and
[NEXT_TASK.md](NEXT_TASK.md) for the next allowed action.
