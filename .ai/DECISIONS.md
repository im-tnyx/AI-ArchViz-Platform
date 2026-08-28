# Decision Index

Canonical ADRs remain under `docs/decisions/`:

- `0001-real-3d-source-of-truth.md`
- `0002-scenespec-canonical-contract.md`
- `0003-flexible-input-evidence-modes.md`
- `0004-ai-proposes-platform-validates.md`

Operational decisions currently in force:

- SceneSpec and Golden fixtures define deterministic expected state.
- The local Windows worker sends only trusted structured plans to the DCC; a
  SceneChangeSet never contains executable scripts, shell data, asset paths,
  URLs, or renderer commands.
- Asset replacement changes an instance's definition reference, not its
  `logicalId`; intrinsic dimensions resolve from the selected definition.
- A target DCC version is a policy target, not validation evidence. Record the
  actual tested DCC version with every compatibility result.
- External asset bytes require an explicit three-part identity boundary:
  logical object ID, immutable asset definition ID, and immutable artifact ID.
  Artifact storage locations stay worker-local and are not portable scene data.
- External artifact trust is deny-by-default: only verified, evidence-bound,
  exact bytes inside the canonical trusted root are eligible for a future
  staging-only loader. No unsafe bypass is permitted.
- DCC process launch is an explicit local operator decision, not a side effect
  of ordinary tests or a job payload. Local config controls production worker
  execution; DCC integration suites require a separate environment opt-in.
- The DCC child process never inherits the parent environment, implicitly or
  by wildcard. `buildDccChildEnvironment` copies only an explicit, named
  Windows-runtime-plus-exact-vendor-key allowlist and caller-owned
  `AI_ARCHVIZ_*` overrides; `runControlledProcess` requires `env` and has no
  `process.env` fallback. A new vendor key is added only after a required
  regression proves it necessary (see `VRAY_FOR_3DSMAX2025_MAIN` in
  [VALIDATION.md](VALIDATION.md)), never as a wildcard prefix.
