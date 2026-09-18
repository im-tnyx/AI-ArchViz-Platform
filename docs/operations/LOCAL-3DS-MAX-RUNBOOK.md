# Local 3ds Max Runbook

**Purpose:** Give humans and coding agents a safe, repeatable way to operate the local 3ds Max automation path without embedding machine-specific assumptions in the repository.

This runbook is operational guidance. Canonical architecture and contracts remain under `docs/`, source code, tests, and `.ai/`.

## 1. Required Environment

The 3ds Max integration path is expected to run on a local Windows machine with:

- Node.js `>=24 <25`
- `pnpm@11.19.x`
- a compatible Autodesk 3ds Max installation
- Python support provided by 3ds Max
- `pymxs`
- Corona only for tests or workflows that explicitly require the Corona adapter

Do not hardcode the 3ds Max or Corona version in automation unless the compatibility contract explicitly requires it. Detect and report the actual environment.

## 2. Repository Setup

From the repository root:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The deterministic worker lives under:

```text
apps/worker/
```

Trusted 3ds Max Python scripts live under:

```text
tools/3ds-max/python/
```

## 3. Local Configuration

Use the repository's supported local worker configuration mechanism, based on the current examples and contracts.

Rules:

- keep machine-specific paths out of committed source
- never commit credentials or secrets
- do not copy local executable paths into `.ai/`
- keep generated workspaces and transient logs untracked

When configuration or path behavior is unclear, inspect the current worker source and `worker.config.example.json` before changing anything.

## 4. Health Check

Before running a scene build, verify controlled communication with 3ds Max:

```bash
pnpm test:3dsmax:health
```

A valid health check should prove, at minimum, that the worker can locate the configured DCC executable, start the controlled process, execute the trusted script path, and return structured success/failure evidence.

Do not treat process launch alone as proof that the automation path is healthy.

## 5. Golden Scene Build

The canonical deterministic scene entry point is:

```bash
pnpm test:3dsmax:golden
```

The intended flow is:

```text
Golden SceneSpec
  -> local worker
  -> trusted DCC plan
  -> candidate .max
  -> fresh 3ds Max process
  -> normalized semantic manifest
  -> verification
  -> verified editable scene
```

A candidate `.max` file is not considered verified merely because it saved successfully.

## 6. Revision and Safety Checks

Useful deterministic integration commands include:

```bash
pnpm test:3dsmax:resilience
pnpm test:3dsmax:revision
pnpm test:3dsmax:opening-revision
pnpm test:3dsmax:materials
pnpm test:3dsmax:material-revision
pnpm test:3dsmax:lock-revision
pnpm test:3dsmax:unlock-revision
pnpm test:3dsmax:asset-identity
pnpm test:3dsmax:replace-asset
```

For revisions, preserve:

- stable logical object identity
- deterministic application order
- unrelated scene state
- idempotency guarantees
- failure safety
- verified checkpoint semantics

## 7. Corona Workflows

Corona is an adapter layer and must not bypass the deterministic scene verification spine.

Available repository entry points include:

```bash
pnpm test:3dsmax:corona-baseline
pnpm test:3dsmax:corona-adapter
pnpm test:3dsmax:golden-corona-preview
pnpm test:3dsmax:canonical-render-state-revision
pnpm test:3dsmax:canonical-golden-corona-preview
pnpm test:3dsmax:corona-material-appearance
pnpm test:3dsmax:canonical-material-appearance-revision
pnpm test:3dsmax:canonical-camera-revision
```

Only run these when the local environment has the renderer capability required by the corresponding test.

## 8. Failure Recovery

If a DCC job fails:

1. Preserve the failure report and relevant structured diagnostics.
2. Do not promote the candidate output.
3. Confirm owned child processes were terminated according to worker policy.
4. Do not terminate unrelated user-launched 3ds Max processes.
5. Re-run the health check before retrying if the failure indicates environment or process instability.
6. Re-run only the smallest relevant deterministic test before broader test coverage.

If a retry changes repository state, verify idempotency and replay behavior rather than assuming the second success is equivalent to a clean first run.

## 9. Agent Operating Rules

Coding agents working on this repository must:

- read `AGENTS.md`
- read `.ai/STATUS.md`
- read `.ai/NEXT_TASK.md`
- stay inside the explicitly authorized scope
- inspect existing tests and contracts before introducing new abstractions
- never claim local 3ds Max verification without actual execution evidence
- never replace real scene-state validation with visual-only judgment

## 10. Never Do This

Do not:

- hardcode a local developer path such as `C:\\Program Files\\Autodesk\\...`
- commit generated `.max` files unless explicitly defined as fixtures
- mutate verified output directly when candidate/promotion semantics apply
- bypass fresh-process reopen verification
- silently relax validation because a test is inconvenient
- kill all `3dsmax.exe` processes indiscriminately
- record secrets or copied terminal dumps in tracked agent continuity files

## 11. Source of Truth

If this runbook conflicts with implementation or a canonical contract, inspect:

1. current source and tests
2. `.ai/NEXT_TASK.md`
3. `.ai/STATUS.md`
4. `.ai/CONTRACTS.md`
5. `.ai/VALIDATION.md`
6. canonical files under `docs/`

Update this runbook only when verified operational behavior changes.
