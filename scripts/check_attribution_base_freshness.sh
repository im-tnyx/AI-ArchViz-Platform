#!/usr/bin/env bash
# Fail closed unless an ArchViz PR head includes the CURRENT main commit and the
# event-reported base is still main's current tip.
#
# Usage: check_attribution_base_freshness.sh <event-base-sha> <pr-head-sha>
# Exit 0: up to date. Exit 1: stale/behind. Exit 2: technical/invalid ref.
# This one-time check alone is not enough if main advances AFTER it runs:
# the protected-main ruleset must ALSO require branches up to date (strict).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "attribution-base-freshness: usage: $0 <event-base-sha> <pr-head-sha>" >&2
  exit 2
fi

base_sha="$1"
head_sha="$2"
for sha in "$base_sha" "$head_sha"; do
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "attribution-base-freshness: error: invalid or unavailable commit ${sha}." >&2
    exit 2
  fi
done

if ! remote_ref="$(git ls-remote --exit-code origin refs/heads/main)"; then
  echo "attribution-base-freshness: error: cannot resolve current origin/main." >&2
  exit 2
fi
current_main_sha="${remote_ref%%$'\t'*}"
if [ -z "$current_main_sha" ]; then
  echo "attribution-base-freshness: error: empty origin/main response." >&2
  exit 2
fi

if [ "$current_main_sha" != "$base_sha" ]; then
  echo "attribution-base-freshness: stale event base ${base_sha}; main is now ${current_main_sha}. Update PR branch and re-run checks." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$base_sha" "$head_sha"; then
  echo "attribution-base-freshness: PR head ${head_sha} does not contain current main ${base_sha}; update PR branch and re-run checks." >&2
  exit 1
fi

echo "attribution-base-freshness: PR head ${head_sha} contains current main ${base_sha}."
