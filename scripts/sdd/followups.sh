#!/usr/bin/env bash
# followups.sh <ID>: the bullets that already-built specs left for capability <ID> in the
# "## Sibling-spec follow-ups" section of their gaps.md (format: "- **S50** (name): what to adopt").
# implement-specs.sh puts the output into the agent's prompt, so follow-ups are applied without anyone relaying them.
set -euo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
id="${1:?usage: followups.sh <ID>}"
shopt -s nullglob
for f in "$ROOT"/specs/*/*/gaps.md; do
  awk -v id="$id" -v src="$(basename "$(dirname "$f")")" '
    /^## Sibling-spec follow-ups/ { on = 1; next }
    /^## /                        { on = 0 }
    on && /^- / && $0 ~ ("^- \\*\\*([^*]*[^0-9A-Za-z])?" id "([^0-9A-Za-z]|$)") { print "- (from " src ") " substr($0, 3) }
  ' "$f"
done
