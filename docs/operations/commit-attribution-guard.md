# Commit attribution: review, rollout, and history safety

Tracked in [Issue #2](https://github.com/im-tnyx/AI-ArchViz-Platform/issues/2).

## Policy and scope

AI providers, coding assistants, models and agents are not automatic Git
co-authors. Keep the human/account author and legitimate human sign-offs.
Neither the scanner nor these workflows modify 3D scene implementation,
SceneSpec, DCC automation, assets, the current spike authorization boundary,
or `.ai/NEXT_TASK.md`. This is a repository-governance change only.

## Verified GitHub historical audit

At the audited `main` HEAD `941a5f99238b4a8cdb20327c6bf9e645372ae79f`:
GitHub returned **95 commits** and **26 commits** with a
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.
The affected SHAs are listed below for review and audit traceability.
This is a GitHub commit-message audit, **not a local-hooks/config audit**.
No historical history has been changed.

- `941a5f99238b4a8cdb20327c6bf9e645372ae79f` — docs: sync ai continuity for multi-space scenes
- `81d7b9b18e390f853ddce3a5b2323d0e1e32e3ff` — feat: add canonical multi-space scene contract
- `631901cceb3e16fbc3796b9c88e66f4b624e163f` — docs: sync ai continuity for shared partitions
- `86ab2fe1a533b5a04e798c24fd99fb014e2266bb` — feat: add reviewed shared partition model
- `c02bb4204e1ca11a42f1226c50e8155618b4e175` — docs: sync ai continuity for cad topology
- `c072c110b43d403d7d510d598371f0e04e98992c` — feat: add deterministic cad topology
- `3b9bf3dca7cc4b70e5683c70f23143b699405110` — docs: sync polygon surface realization closure
- `a3bea86cee0362ae0c9245361d3463aae78ed5d9` — fix: realize canonical polygon surfaces
- `ef7ffca2453dac79796c55adef1910c332b1a87e` — docs: sync ai continuity for cad scene seeding
- `f00f743cac67c9e20ecf94889a173cf345d93055` — feat: seed canonical scenes from reviewed cad
- `dd2fd8079390a5283f6181a2fcc92f875a9102c8` — docs: sync ai continuity for cad interpretation
- `8a3e555541ab6b9ce0d25d82a8186418cd827d40` — feat: add deterministic cad interpretation
- `052585b4b700736d7d7008f81ba4e9615ea9191c` — docs: sync cad path containment closure
- `f51ea5aa2e72fb29d6ab9541c7038632f83f94c7` — fix: harden cad path containment
- `aa720f73d7dabaaf35da1bb894ab4b3723e1f3d7` — docs: sync ai continuity for dxf extraction
- `af96b947dc5c3b31224c4541331b683c7ccede4d` — feat: add deterministic dxf extraction
- `081d88a45623ac056f3b02fb98234c020475f430` — docs: sync ai continuity for circulation enforcement
- `d0263aad3cec55e11c53807e9d3b1ecf504ec966` — feat: enforce canonical circulation requirements
- `7095bbfa26896c0f333ae8a4db73e5908ef9a8ae` — docs: sync ai continuity for circulation requirements
- `40e1c38baffe833295adcde4025e788a3f5a3ecf` — feat: add canonical circulation requirement contract
- `f72129f7a1f1b418faa35fcea23a9f6c30bfa02b` — docs: sync circulation space scoping closure
- `8e5808b32fe2913b3635d9e6bc765c78fc65e8b5` — fix: scope circulation obstacles by space
- `f0d2c5c0212579b01803aff92105897d44eed6d5` — docs: sync ai continuity for circulation graph
- `7ed0fee08bc17aea48b397d7d79af293435b34b9` — feat: add deterministic circulation graph
- `4e4b5ca3ccc38d4d17ae4b4044884f9b43b1a70b` — docs: sync dcc batch policy closure
- `0160de67e01c1d34b5c347b5b38fadedd57fdcb0` — fix: centralize dcc batch launch policy

The GitHub commit messages confirm the *presence* of the attribution, but
**not what inserted it**. Local/global/system Git configuration, hooks,
IDE settings and any Claude or agent wrappers cannot be inferred from
these metadata alone. On the machine that creates commits, inspect:

```bash
git config --show-origin --get-regexp '^(user|core\.hooksPath|commit\.template)\.' || true
git config --show-origin --get core.hooksPath || true
git rev-parse --git-path hooks
git log -1 --format='%an <%ae>%n%cn <%ce>%n%B'
```

Also review active Git hooks, `prepare-commit-msg`, `commit-msg`,
`post-commit`, commit templates, Claude tool hooks/settings and wrappers.
Disable any verified source of automatic AI co-author trailers **at its
actual source** and validate a clean disposable commit/PR afterward;
do not guess that `CLAUDE.md` is the injector. The root `CLAUDE.md`
compatibility decision remains separate Issue #1.

## Proposed guard (bootstrap PR)

- `scripts/check_commit_attribution.sh` checks all existing commits in
  the PR `base..head` range for recognized AI co-author/trailer/footer
  credits, preserving ordinary human identities.
- `scripts/check_commit_attribution_test.sh` creates an isolated temporary
  Git repository and runs attribution + branch-freshness regression fixtures.
  `Commit attribution fixture tests` is a **non-secret** PR CI job; passing it
  is not evidence the privileged App guard is enforced.
- `pull_request_target` guard always loads *trusted base-branch code*,
  verifies the exact PR head SHA fetched as Git objects (never checks out or
  executes contributor code), checks freshness against current `main`,
  runs the scanner, and emits a distinct **App-owned** Check Run called
  `Commit attribution guard` only when explicitly enabled. Its GitHub
  Actions runner name is **not** the required App check.
- `Post-merge attribution audit` scans newly landed `main` messages
  after a push. It **cannot undo or prevent** a completed bad merge.

This guard is **not yet live or required** while its code is in a PR.

## Owner-only staged activation

1. Independently review bootstrap PR and its exact-head CI, and choose a
   consciously inspected merge method. Existing published `main` has
   historical AI credits; do not run a whole-history scan as a required
   gate on an unrelated clean PR or rewrite history without authorization.
2. Before deployment, create/verify a protected `main` branch **ruleset**:
   require a PR; deny deletion and force push; require the appropriate
   existing Actions fixture CI; enforce **Require branches to be up to date
   before merging** (`strict_required_status_checks_policy: true`) and
   explicitly record bypass/merge-method decisions. ArchViz originally
   had **no active rulesets and an unprotected main** at this audit.
3. After trusted code has landed on `main`, use a GitHub App
   with `Checks: Read and write` and `Metadata: Read`, installed with
   repository access to `AI-ArchViz-Platform`. The owner reports that the
   existing shared `Tio Attribution Guard` App (ID `5032971`) is now
   selected for ArchViz (alongside other repositories). It may be reused;
   a separate ArchViz-only App has a smaller cross-repository credential
   blast radius. **GitHub check-run evidence must confirm the actual App ID
   and source on a live ArchViz PR**; a screenshot alone does not prove a
   working Check Run.
4. The owner reports the Actions environment `attribution-guard-trusted`
   is configured with trusted `main`-only deployments, environment variable
   `ATTRIBUTION_GUARD_APP_CLIENT_ID` and secret
   `ATTRIBUTION_GUARD_APP_PRIVATE_KEY` for the selected App.
   **The connector cannot read environment settings/secrets**, so verify
   the app/client-id/PEM pair and restrictions from the protected UI and
   a real successful App-run before marking credentials validated.
   Never commit or paste keys.
5. Explicitly set repository Actions variable
   `ARCHVIZ_ATTRIBUTION_APP_ENABLED=true` **only after** the scoped
   installation, environment, App permissions and credentials are ready.
   Until enabled, the credential-dependent job skips rather than issuing
   a misleading App-owned success.
6. Run disposable **clean**, **prohibited attribution**, and
   **remediated** PRs. Verify the dedicated App creates exact-head
   success/failure/success results, respectively. Never merge a
   deliberately bad PR. Also advance trusted `main` via an approved
   clean PR: a stale PR must be blocked by strict status requirements,
   then updated and rescanned against current `main`.
7. Finally add required check `Commit attribution guard` pinned to its
   actual **GitHub App source ID** (not `github-actions`) in the main
   ruleset, retaining the fixture check and strict policy. Record live
   links/results in Issue #2 before claiming enforcement or closing it.

## Workflow security review: October 2026

An independent workflow security review did **not** identify a critical
secret-exfiltration or PR-code-execution finding in the inspected YAML. It
reported two medium and several lower-severity issues. We hardened the
bootstrap PR, but **do not treat the original review as a formal GitHub
APPROVED review**: these changes require re-review and live tests.

- `pull_request_target` still handles `opened`, `synchronize`,
  `reopened`, and `edited`; **title/body edits skip the privileged job**.
  A base-branch edit is the only `edited` event that re-runs it, and edited
  events do not cancel an in-progress App check. Genuine new-head pushes
  still cancel superseded work. A changed base must be revalidated.
- All `actions/checkout` calls use the verified exact commit
  `3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7.0.1`);
  `actions/create-github-app-token` uses verified
  `bcd2ba49218906704ab6c1aa796996da409d3eb1` (`v3.2.0`).
  `.github/dependabot.yml` proposes weekly GitHub Actions updates. Pinning
  does not eliminate the need to review dependency-update PRs.
- The ArchViz repository is **public**, so checkout uses
  `persist-credentials: false`; GitHub's bootstrap checkout step still
  authenticates as necessary, but Git credentials are not left available
  for subsequent scripts. Never change the guard to checkout/execute
  untrusted PR code.
- **Important trust boundary:** the `attribution-guard-trusted` environment's
  `main`-only branch restriction is *not* a filter for trusted PR authors.
  For `pull_request_target` the workflow ref is `refs/heads/main` even
  when the PR originates in an untrusted fork. It is safe **only because**
  the runner checks out a trusted base SHA and fetches the PR head as
  inert Git objects, verifies the exact expected head SHA, and never runs
  PR-supplied code. The environment restriction alone would not stop a
  malicious fork from triggering a vulnerable trusted workflow.
- The optional owner exception variable is now
  `AI_ATTRIBUTION_EXCEPTION_PR_HEAD` and must equal
  `<PR_NUMBER>:<FULL_PR_HEAD_SHA>` (for example `12:abcdef...`, using the
  actual complete 40-hex Git commit SHA). A different head, different PR,
  or legacy PR-number-only value **does not** grant an exception. Obtain
  explicit owner approval of the exact commit and clear the variable
  immediately afterward. This exemption is never available for scanner or
  ref-validation errors. **Do not** enable exceptions as a routine workflow.
- The `main` post-merge audit executes the checker extracted from the
  previous trusted `main` SHA (`github.event.before`), rather than the
  newly pushed revision of its own checker. On the **first bootstrap push**,
  the prior `main` does not contain the script, so this audit deliberately
  **fails closed** and needs separate manual verification; it is not a
  required PR status check. Later pushes audit with the previous trusted
  script. The workflow itself remains editable by an authorized PR,
  so CODEOWNERS/review are still necessary.
- `.github/CODEOWNERS` assigns ownership of the attribution workflows,
  scanner/tests and policy to `@im-tnyx`. **This is informational until**
  the branch ruleset has a required approving review and Code Owner Review
  enabled. Current ruleset `25698567` requires **zero approvals** and
  `require_code_owner_review=false`. The author cannot approve their own
  PR. Arrange an eligible independent collaborator/reviewer and review
  access policy **before** enabling code-owner approvals, to avoid
  deadlocking merges. No settings have been silently changed here.
- The repository currently has **no merge queue**; if one is introduced,
  revisit the expected required-check flow and the `merge_group` event
  compatibility separately. Do not require a non-emitted `merge_group`
  status, or the queue will block.
- `scripts/check_attribution_base_freshness.sh` now instructs a **new
  push/update of the PR branch** after a stale-base failure. Re-running the
  old workflow event still uses its old `base.sha` and is insufficient.
- The non-secret `pull_request` fixture job runs the PR's own proposed
  test files, so a malicious PR could fake *its fixture CI* result.
  **Only** a successfully live-tested App-issued check, pinned to the
  actual GitHub App integration source in the main ruleset, is the
  security-enforcement signal. The fixture may remain useful supplemental
  CI but is not a replacement for the App check.

**Activation gate remains open:** trusted code must land with explicit owner
authorization, a real App-generated clean/fail/remediated sequence must be
verified on ArchViz PR head SHAs, and source-pinned strict required status
must be established and tested before this protection is called enforced.

## Final merge-message limitation

The guard examines existing PR commits. GitHub `squash` and `merge`
can create an editable *new* commit message **after** the PR-head check
passes. Inspect the final subject, body, trailers and author before any
owner-approved merge. Prefer a controlled merge method that does not
introduce a new editable squash/merge message where appropriate, or
an owner-approved server-side final-commit metadata rule if available.
The post-merge audit is only detection; neither CI fixtures nor a
human checklist is an automatic final-commit blocker.

## Historic cleanup: plan only; do not execute

**Default recommendation: leave the published commits intact.**
Any rewrite changes these SHAs and every descendant, can invalidate
references and collaborators' work, and may require temporarily bypassing
protected `main`. Only if the owner gives *separate* explicit approval:

1. Freeze writes, notify collaborators, record current `main` SHA and
   downstream forks/PRs, and create an independently verified full
   `git bundle create pre-attribution-cleanup.bundle --all` backup plus
   an off-repository copy and recorded refs.
2. In an isolated clone (not the canonical checkout), dry-run a narrowly
   scoped commit-message-only rewrite of the **enumerated exact SHAs**
   using a reviewed history-rewrite tool, leaving genuine human
   trailers unchanged. Produce a before/after old-to-new SHA map.
3. Compare file trees, author/committer identities, parent chains, tags,
   branch tips, and sampled DCC/SceneSpec history. Review rewritten GitHub
   attribution in a disposable private mirror before a production change.
4. Obtain specific separate written approval for downtime, branch-rule
   exceptions, and coordinated protected-main ref movement. Never
   force-push by default; never mix this with ordinary guard rollout.
5. Prepare collaborator reset/re-clone instructions and the explicit
   rollback path using the preserved bundle/refs, with an owner-approved
   recovery window. Re-apply protection immediately and revalidate checks.

No cleanup command above has been executed; this document is not merge
or protected-branch authorization.
