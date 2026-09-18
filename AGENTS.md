# Repository Agent Instructions

This repository is designed for long-running work by humans and coding agents such as Codex and Claude Code.

## Read First

Before changing code or documentation, read these files in order:

1. `.ai/STATUS.md`
2. `.ai/NEXT_TASK.md`
3. `.ai/ARCHITECTURE.md`
4. `.ai/CONTRACTS.md`, `.ai/DECISIONS.md`, and `.ai/VALIDATION.md` as relevant to the task

The authoritative behavior remains in source code, schemas, tests, and canonical `docs/` files. The `.ai/` directory is the compact continuity and authorization layer.

## Authorization Boundary

Treat `.ai/NEXT_TASK.md` as the current work authorization boundary.

- Do not start a new spike, renderer integration, AI integration, external download flow, or production external `ReplaceAsset` path unless the user explicitly authorizes it.
- Do not infer authorization from a plausible future task.
- If no next task is authorized, restrict work to the explicit user request.

## Architecture Guardrails

- A saved, editable real 3D scene is production truth.
- `SceneSpec` is the canonical software-independent scene contract.
- Revisions must be deterministic `SceneChangeSet` transitions against an existing verified scene.
- Explicit dimensions, CAD geometry, and other human-verifiable evidence override AI inference.
- AI providers, DCC applications, and renderers must remain adapter-based.
- Never promote a candidate scene without independent fresh-process reopen and semantic verification.
- Do not silently weaken validation, identity, revision, idempotency, timeout, or failure-safety guarantees.

## Toolchain

- Package manager: `pnpm@11.19.x`
- Node.js: `>=24 <25`
- TypeScript monorepo
- 3ds Max automation: Python + `pymxs`
- Primary local worker: `apps/worker/`
- 3ds Max scripts: `tools/3ds-max/python/`

## Standard Validation

For ordinary repository changes, run the relevant subset of:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

3ds Max integration tests require a supported local Windows + 3ds Max environment. Useful entry points include:

```bash
pnpm test:3dsmax:health
pnpm test:3dsmax:golden
pnpm test:3dsmax:resilience
pnpm test:3dsmax:revision
pnpm test:3dsmax:materials
pnpm test:3dsmax:replace-asset
```

Do not report a 3ds Max integration test as passed unless it actually ran against the required local DCC environment and produced the expected verification evidence.

## Change Discipline

- Prefer the smallest change that satisfies the authorized task.
- Preserve public contracts unless the task explicitly changes them.
- Update tests when behavior changes.
- Update canonical docs or `.ai/` continuity files only when verified project state changes.
- When a confirmed milestone changes, update the relevant `.ai/` file in the same focused change and keep it concise and evidence-based.
- Never put secrets, credentials, machine-specific absolute paths, transient logs, generated `.max` files, or `.workspace/` contents into tracked documentation.
- Do not commit large generated artifacts unless the repository explicitly defines them as fixtures.

## 3ds Max Safety

- Do not hardcode a developer's local 3ds Max executable path.
- Do not modify a verified output scene in place when the workflow requires candidate + promotion semantics.
- Do not kill unrelated 3ds Max processes.
- Preserve stable logical IDs across revisions.
- Treat fresh-process semantic manifest verification as a required promotion gate where defined by the current contract.

## Repository Orientation

Key locations:

```text
.ai/                         Agent continuity, status, authorization, validation evidence
apps/worker/                 Local Windows worker and orchestration
packages/scene-spec/         Canonical scene contracts
packages/worker-contracts/   Worker job and result contracts
tools/3ds-max/python/        Trusted 3ds Max Python automation
docs/architecture/           Canonical architecture
docs/testing/                Test strategy and golden project docs
tests/fixtures/              Deterministic fixtures
```

When instructions conflict, follow this precedence:

1. Explicit current user request
2. `.ai/NEXT_TASK.md` authorization boundary
3. Canonical contracts/tests/source
4. This file
5. General assumptions
