#!/usr/bin/env bash
# Fixture-based regression tests for check_commit_attribution.sh.
#
# Builds a disposable temporary Git repository, creates one commit per
# fixture on top of a shared base commit, and asserts the checker's exit
# code matches the expected outcome. Also covers the 4-argument
# exception/error-path contract (owner exception, and fail-closed technical
# errors that the exception must never bypass). Does not depend on network
# access, GitHub Actions, or this repository's own history.
#
# Usage: check_commit_attribution_test.sh

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checker="$script_dir/check_commit_attribution.sh"

if [ ! -f "$checker" ]; then
  echo "check_commit_attribution_test: error: checker script not found at ${checker}" >&2
  exit 2
fi

workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT

repo="$workdir/repo"
git init -q -b main "$repo"
(
  cd "$repo"
  git config user.name "Test Runner"
  git config user.email "test-runner@example.invalid"
  git config commit.gpgsign false
)

base_sha="$(cd "$repo" && git commit --allow-empty -q -m "chore: base commit" && git rev-parse HEAD)"

pass_count=0
fail_count=0

expected_rc_for() {
  case "$1" in
    pass) echo 0 ;;
    fail) echo 1 ;;
    error) echo 2 ;;
    *) echo "unknown expectation: $1" >&2; exit 2 ;;
  esac
}

report() {
  local expect="$1" expected_rc="$2" rc="$3" desc="$4" output="$5"
  if [ "$rc" -eq "$expected_rc" ]; then
    echo "PASS  [${expect}] ${desc}"
    pass_count=$((pass_count + 1))
  else
    echo "FAIL  [expected ${expect} -> rc=${expected_rc}, got rc=${rc}] ${desc}"
    echo "${output}" | sed 's/^/    /'
    fail_count=$((fail_count + 1))
  fi
}

# Two-argument identity fixtures: no PR/exception context.
run_case() {
  local expect="$1" desc="$2" message="$3"
  local expected_rc
  expected_rc="$(expected_rc_for "$expect")"

  (cd "$repo" && git reset -q --hard "$base_sha")
  (cd "$repo" && git commit --allow-empty -q -m "$message")
  local head_sha
  head_sha="$(cd "$repo" && git rev-parse HEAD)"

  local output rc=0
  output="$(cd "$repo" && bash "$checker" "$base_sha" "$head_sha" 2>&1)" || rc=$?

  report "$expect" "$expected_rc" "$rc" "$desc" "$output"
}

# Scan all commits, not only the clean final HEAD.
run_multi_commit_case() {
  local expect="$1" desc="$2" first_message="$3" second_message="$4"
  local expected_rc
  expected_rc="$(expected_rc_for "$expect")"

  (cd "$repo" && git reset -q --hard "$base_sha")
  (cd "$repo" && git commit --allow-empty -q -m "$first_message")
  (cd "$repo" && git commit --allow-empty -q -m "$second_message")
  local head_sha output rc=0
  head_sha="$(cd "$repo" && git rev-parse HEAD)"
  output="$(cd "$repo" && bash "$checker" "$base_sha" "$head_sha" 2>&1)" || rc=$?

  report "$expect" "$expected_rc" "$rc" "$desc" "$output"
}

# Four-argument exception-aware fixtures.
run_case_ex() {
  local expect="$1" desc="$2" message="$3" pr_number="$4" exception_pr="$5"
  local expected_rc
  expected_rc="$(expected_rc_for "$expect")"

  (cd "$repo" && git reset -q --hard "$base_sha")
  (cd "$repo" && git commit --allow-empty -q -m "$message")
  local head_sha
  head_sha="$(cd "$repo" && git rev-parse HEAD)"

  local output rc=0
  output="$(cd "$repo" && bash "$checker" "$base_sha" "$head_sha" "$pr_number" "$exception_pr" 2>&1)" || rc=$?

  report "$expect" "$expected_rc" "$rc" "$desc" "$output"
}

# Invalid-ref / technical-failure fixtures: must return rc=2 even when a
# matching exception is supplied.
run_invalid_ref_case() {
  local desc="$1" base_arg="$2" head_arg="$3" pr_number="$4" exception_pr="$5"
  local expected_rc=2

  local output rc=0
  output="$(cd "$repo" && bash "$checker" "$base_arg" "$head_arg" "$pr_number" "$exception_pr" 2>&1)" || rc=$?

  report "error" "$expected_rc" "$rc" "$desc" "$output"
}

# --- PASS: no trailer at all ---
run_case pass "no Co-Authored-By trailer" \
  "$(printf 'feat: add widget\n\nRegular commit body with no trailer at all.')"

# --- PASS: single ordinary human co-author ---
run_case pass "single human co-author" \
  "$(printf 'feat: add widget\n\nBody text.\n\nCo-Authored-By: Jane Developer <jane@example.com>')"

# --- PASS: multiple ordinary human co-authors ---
run_case pass "multiple human co-authors" \
  "$(printf 'feat: add widget\n\nBody text.\n\nCo-Authored-By: Jane Developer <jane@example.com>\nCo-Authored-By: John Smith <john@example.com>')"

# --- PASS: human whose first name happens to be "Claude" ---
run_case pass "human named Claude with a personal email" \
  "$(printf 'fix: correct off-by-one\n\nBody text.\n\nCo-Authored-By: Claude Dupont <claude.dupont@example.com>')"

# --- PASS: ordinary prose mentioning AI vendor names outside a trailer ---
run_case pass "prose mentions Claude/OpenAI outside any trailer" \
  "$(printf 'docs: mention Claude and OpenAI\n\nThis commit updates docs that mention Claude and OpenAI in prose, not as a trailer.')"

# --- FAIL: the actual PR #282 regression identity ---
run_case fail "Claude with anthropic.com email" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>')"

# --- FAIL: lower-case trailer key + Claude Sonnet display name ---
run_case fail "case-variant trailer key with Claude Sonnet identity" \
  "$(printf 'feat: x\n\nBody.\n\nco-authored-by: Claude Sonnet <sonnet@anthropic.com>')"

# --- FAIL: Anthropic display name ---
run_case fail "Anthropic display identity" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: Anthropic <bot@anthropic.com>')"

# --- FAIL: Codex identity ---
run_case fail "Codex identity" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: Codex <codex@openai.com>')"

# --- FAIL: OpenAI identity ---
run_case fail "OpenAI identity" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: OpenAI <bot@openai.com>')"

# --- FAIL: OpenAI Codex identity ---
run_case fail "OpenAI Codex identity" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: OpenAI Codex <codex@openai.com>')"

# --- FAIL: AI trailer mixed among otherwise-normal human co-authors ---
run_case fail "AI trailer mixed among human co-authors" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: Jane Developer <jane@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>')"

# --- Exception-contract fixtures (4-argument form) ---

# clean range + no exception -> PASS
run_case_ex pass "clean range, no exception set" \
  "$(printf 'chore: x\n\nNo trailer here.')" "42" ""

# violation + no exception -> FAIL rc=1
run_case_ex fail "violation, no exception set" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>')" "42" ""

# violation + different PR exception -> FAIL rc=1
run_case_ex fail "violation, exception set for a different PR" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>')" "42" "43"

# violation + exact matching PR exception -> PASS rc=0
run_case_ex pass "violation, exact matching PR exception" \
  "$(printf 'feat: x\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>')" "42" "42"

# --- Fail-closed technical-failure fixtures: exception must NEVER apply ---

# invalid base ref + exact matching exception -> FAIL rc=2, not bypassed
run_invalid_ref_case "invalid base ref with matching exception must still fail closed (rc=2)" \
  "not-a-real-ref" "$base_sha" "42" "42"

# invalid head ref + exact matching exception -> FAIL rc=2, not bypassed
run_invalid_ref_case "invalid head ref with matching exception must still fail closed (rc=2)" \
  "$base_sha" "0000000000000000000000000000000000dead" "42" "42"


# Expanded provider and equivalent self-credit regression fixtures.
run_case fail "Claude Opus version with a personal-domain email" \
  "$(printf 'feat: x\n\nCo-Authored-By: Claude Opus 5.5 <bot@example.com>')"

run_case fail "Copilot SWE agent noreply identity" \
  "$(printf 'feat: x\n\nCo-Authored-By: copilot-swe-agent <123+copilot-swe-agent@users.noreply.github.com>')"

run_case fail "Google Gemini identity" \
  "$(printf 'feat: x\n\nCo-Authored-By: Google Gemini <bot@example.com>')"

run_case fail "AI signed-off-by trailer" \
  "$(printf 'feat: x\n\nSigned-off-by: Claude Code <noreply@anthropic.com>')"

run_case fail "AI-assisted trailer" \
  "$(printf 'feat: x\n\nAI-assisted: true')"

run_case fail "Assisted-by trailer" \
  "$(printf 'feat: x\n\nAssisted-by: GPT-6')"

run_case fail "free-form generated with footer" \
  "$(printf 'feat: x\n\nGenerated with Claude Code')"

run_case pass "legitimate human signed-off-by" \
  "$(printf 'feat: x\n\nSigned-off-by: Jane Developer <jane@example.com>')"

run_case pass "non-AI generator footer" \
  "$(printf 'chore: x\n\nGenerated-with: Kotlin compiler')"

# Review regression cases: bot banners, non-trailer AI-assisted text, humans.
run_case fail "emoji and markdown-linked generated-with AI footer" \
  "$(printf 'docs: x\n\n🤖 Generated with [Claude Code](https://claude.ai/code)')"

run_case fail "free-form AI-assisted with Claude Code" \
  "$(printf 'feat: x\n\nAI-assisted with Claude Code')"

run_case pass "human Assisted-by with Claude first name" \
  "$(printf 'fix: x\n\nAssisted-by: Claude Dupont <claude.dupont@example.com>')"



# Review follow-up: exact known AI identity and human false positives.
run_case fail "Cursor co-author with known provider domain" \
  "$(printf 'feat: x\n\nCo-Authored-By: Cursor <cursoragent@cursor.com>')"

run_case fail "Cursor co-author alias on GitHub noreply" \
  "$(printf 'feat: x\n\nCo-Authored-By: Cursor <cursor-agent@users.noreply.github.com>')"

run_case fail "Cursor agent identity with personal-domain email" \
  "$(printf 'feat: x\n\nCo-Authored-By: Cursor Agent <agent@example.com>')"

run_case fail "generated with Cursor" \
  "$(printf 'feat: x\n\nGenerated with Cursor')"

run_case fail "generated by standalone AI" \
  "$(printf 'feat: x\n\nGenerated by AI')"

run_case fail "AI-assisted development footer" \
  "$(printf 'feat: x\n\nAI-assisted development')"

run_case pass "human co-author named Cursorish" \
  "$(printf 'feat: x\n\nCo-Authored-By: Cursorish Developer <human@example.com>')"

run_case pass "non-attribution prose with Cursor and AI" \
  "$(printf 'docs: explain Cursor\n\nDocument Cursor and AI architecture without attributing authorship.')"

run_case pass "generated with non-AI tool" \
  "$(printf 'feat: x\n\nGenerated with Kotlin compiler')"

# Multi-commit ranges must reject a bad first commit even if HEAD is clean.
run_multi_commit_case fail "AI trailer in earlier commit and clean final HEAD" \
  "$(printf 'feat: first\n\nCo-Authored-By: Cursor <cursoragent@cursor.com>')" \
  "$(printf 'fix: clean final commit\n\nNo attribution here.')"

run_multi_commit_case pass "human trailer in earlier commit and clean final HEAD" \
  "$(printf 'feat: first\n\nCo-Authored-By: Claude Dupont <claude.dupont@example.com>')" \
  "$(printf 'fix: clean final commit\n\nNo attribution here.')"


# New Copilot review (2026-10-22): structured GPT model identities.
run_case fail "GPT-4o co-author with a generic email domain" \
  "$(printf 'feat: x\n\nCo-Authored-By: GPT-4o <bot@example.com>')"

run_case fail "GPT-6 signed-off-by on GitHub noreply" \
  "$(printf 'feat: x\n\nSigned-off-by: GPT-6 <model@users.noreply.github.com>')"

run_case fail "GPT-5.6 decimal model name with personal-domain email" \
  "$(printf 'feat: x\n\nCo-Authored-By: GPT-5.6 <assistant@example.com>')"

run_case pass "human GPT Johnson is not a GPT model identity" \
  "$(printf 'feat: x\n\nCo-Authored-By: GPT Johnson <gpt.johnson@example.com>')"

# Preserve legitimate human attribution at an AI provider's employer domain.
run_case pass "human OpenAI employee signed-off-by" \
  "$(printf 'feat: x\n\nSigned-off-by: Jane Developer <jane@openai.com>')"

run_case pass "human OpenAI employee co-authored-by" \
  "$(printf 'feat: x\n\nCo-Authored-By: Jane Developer <jane@openai.com>')"

run_case pass "human Anthropic employee with Claude first name" \
  "$(printf 'feat: x\n\nCo-Authored-By: Claude Dupont <claude.dupont@anthropic.com>')"

run_case fail "provider-domain noreply bot remains prohibited" \
  "$(printf 'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>')"

run_case fail "provider-domain explicit automation mailbox remains prohibited" \
  "$(printf 'feat: x\n\nSigned-off-by: Automation <ci-bot@openai.com>')"

# Standalone footers do not need a trailing delimiter or provider name.
run_case fail "standalone AI-assisted footer" \
  "$(printf 'feat: x\n\nAI-assisted')"

run_case fail "emoji-prefixed standalone AI-assisted footer" \
  "$(printf 'feat: x\n\n🤖 AI-assisted')"



# Copilot fourth review: versioned Gemini, free-form humans, and prose safety.
run_case fail "Gemini 2.5 Pro structured AI co-author" \
  "$(printf 'feat: x\n\nCo-Authored-By: Gemini 2.5 Pro <bot@example.com>')"

run_case fail "Google Gemini 2.5 Flash structured AI co-author" \
  "$(printf 'feat: x\n\nCo-Authored-By: Google Gemini 2.5 Flash <model@users.noreply.github.com>')"

run_case pass "human Gemini Johnson is not Gemini model" \
  "$(printf 'feat: x\n\nCo-Authored-By: Gemini Johnson <human@example.com>')"

run_case pass "human Gemini Patel does not match versioned model" \
  "$(printf 'feat: x\n\nSigned-off-by: Gemini Patel <gemini.patel@example.com>')"

run_case pass "free-form human Claude first name with email" \
  "$(printf 'fix: x\n\nAssisted by: Claude Dupont <claude.dupont@example.com>')"

run_case pass "free-form human generated by on provider domain" \
  "$(printf 'docs: x\n\nGenerated by: Jane Developer <jane@openai.com>')"

run_case pass "emoji free-form human assisted by" \
  "$(printf 'fix: x\n\n🤖 Assisted by: Claude Dupont <claude.dupont@example.com>')"

run_case fail "free-form structured AI assistant identity" \
  "$(printf 'feat: x\n\nAssisted by: Claude Code <assistant@example.com>')"

run_case fail "free-form structured GPT model identity" \
  "$(printf 'feat: x\n\nGenerated by: GPT-6 <model@users.noreply.github.com>')"

run_case fail "free-form known bot mailbox on provider domain" \
  "$(printf 'feat: x\n\nGenerated by: Claude <noreply@anthropic.com>')"

run_case pass "ordinary AI-assisted transaction prose" \
  "$(printf 'docs: x\n\nAI-assisted transaction import still requires explicit user confirmation.')"

run_case pass "bullet ordinary AI-assisted transaction prose" \
  "$(printf 'docs: x\n\n- AI-assisted transaction import still requires explicit user confirmation.')"

run_case pass "ordinary AI-assisted feature description" \
  "$(printf 'docs: x\n\nAI-assisted development requires consent and audit logging.')"

run_case fail "standalone AI-assisted development remains prohibited" \
  "$(printf 'feat: x\n\nAI-assisted development')"

run_case fail "markdown linked generated with Claude Code still prohibited" \
  "$(printf 'feat: x\n\n🤖 Generated with [Claude Code](https://claude.ai/code)')"


# Trusted main / PR-head freshness regression cases.
# Use a disposable bare origin: never touch any real repository or main.
freshness_checker="$script_dir/check_attribution_base_freshness.sh"
if [ ! -f "$freshness_checker" ]; then
  echo "check_commit_attribution_test: missing freshness checker" >&2
  exit 2
fi

bare_origin="$workdir/origin.git"
git init -q --bare "$bare_origin"
git -C "$repo" remote add origin "$bare_origin"
git -C "$repo" push -q origin "$base_sha:refs/heads/main"

# Start with a PR head that incorporates the current protected main.
git -C "$repo" reset -q --hard "$base_sha"
git -C "$repo" commit -q --allow-empty -m "feat: disposable PR head"
fresh_head="$(git -C "$repo" rev-parse HEAD)"

output="$(cd "$repo" && bash "$freshness_checker" "$base_sha" "$fresh_head" 2>&1)"
report "pass" 0 0 "fresh PR head contains current main" "$output"

# Advance main independently, while the PR head stays unchanged.
git -C "$repo" reset -q --hard "$base_sha"
git -C "$repo" commit -q --allow-empty -m "chore: advance trusted main"
advanced_main="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" push -q origin "$advanced_main:refs/heads/main"

rc=0
output="$(cd "$repo" && bash "$freshness_checker" "$base_sha" "$fresh_head" 2>&1)" || rc=$?
report "fail" 1 "$rc" "main advanced after previous PR check; event base must be stale" "$output"

rc=0
output="$(cd "$repo" && bash "$freshness_checker" "$advanced_main" "$fresh_head" 2>&1)" || rc=$?
report "fail" 1 "$rc" "current main is not an ancestor of outdated PR head" "$output"

# Once the feature incorporates updated main, freshness becomes valid again.
git -C "$repo" reset -q --hard "$advanced_main"
git -C "$repo" commit -q --allow-empty -m "feat: updated PR head"
updated_head="$(git -C "$repo" rev-parse HEAD)"
rc=0
output="$(cd "$repo" && bash "$freshness_checker" "$advanced_main" "$updated_head" 2>&1)" || rc=$?
report "pass" 0 "$rc" "PR updated to current main is accepted" "$output"

rc=0
output="$(cd "$repo" && bash "$freshness_checker" "$advanced_main" "not-a-commit" 2>&1)" || rc=$?
report "error" 2 "$rc" "invalid PR head fails closed even with correct base" "$output"


echo
echo "check_commit_attribution_test: ${pass_count} passed, ${fail_count} failed"

if [ "$fail_count" -ne 0 ]; then
  exit 1
fi

exit 0
