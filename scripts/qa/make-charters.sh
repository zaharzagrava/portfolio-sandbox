#!/usr/bin/env bash
# Drafts QA charters for built capabilities that no charter covers (scripts/qa/select.py --uncovered), so coverage grows with the product without a person writing them.
#   scripts/qa/make-charters.sh [capability-id...]        default: the uncovered ones, at most $MAX_NEW_CHARTERS (2) per call
# A fresh session reads the living page and one finished charter as the example, then either writes a charter (saved with `status: draft`: a person should read it, but
# it already takes part in selection; the verify step protects against what a weak charter reports) or answers NONE when the capability has no flow a user or a client can
# walk (an internal hub, a queue consumer): such ids go to scripts/qa/charters/.no-flow and are not asked again. Never edits anything but those two places.
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; cd "$ROOT"
source scripts/sdd/lib.sh
IDS=("$@"); [[ ${#IDS[@]} -gt 0 ]] || IDS=($(scripts/qa/select.py --uncovered | head -n "${MAX_NEW_CHARTERS:-2}"))
[[ ${#IDS[@]} -gt 0 ]] || { echo "every built capability is covered by a charter or marked as having no flow"; exit 0; }
for id in "${IDS[@]}"; do
  page="$(ls docs/spec/capabilities/${id}-*.md 2>/dev/null | head -1)"; [[ -n "$page" ]] || { echo "no living page for $id" >&2; continue; }
  slug="$(basename "$page" .md | sed -E 's/^[A-Za-z0-9]+-//')"; work="$(mktemp -d)"; out="$work/charter.md"; cp "$page" "$work/page.md"; cp scripts/qa/charters/buy.md "$work/example.md"   # copies: the session works in its scratch directory and reads nothing else
  prompt="You write ONE exploratory-testing charter for a QA agent that uses the running product (browser with Playwright, plus curl against the API at localhost:8000, the web app at localhost:3000).
1. Read the living-specification page $work/page.md, and the finished example charter $work/example.md (copy its tone and size; its front lines are name, specs, minutes).
2. If the capability has a flow that a visitor, a buyer, a seller or an API client can walk (screens, endpoints, visible effects), write $out: first lines exactly 'name: $slug', 'specs: $id', 'status: draft', 'minutes: 15' (or 10 to 20 by the size of the flow), then one paragraph that says what to do and what to try to break, in the example's style: concrete user steps first, then odd inputs, repeats, reloads, concurrency, and what to check behind the screen. Stay inside this capability. Name the pages and endpoints from the spec, not invented ones.
3. If there is nothing a person or a client can walk (an internal hub, a worker, a library), do not write the file; instead write $work/none.txt with one line: the reason.
Finish by printing which of the two you did."
  ( cd "$work" && NOTES_DIR="$work" SPEC_TOOLS=(Read Glob Grep Write) PASS_TIMEOUT_S=900 run_claude "$work/claude.log" "$prompt" ) >/dev/null 2>&1
  if [[ -s "$out" ]] && head -4 "$out" | grep -q "^name: $slug" && grep -q '^minutes:' "$out"; then
    cp "$out" "scripts/qa/charters/$slug.md"; echo "drafted scripts/qa/charters/$slug.md for $id"
  elif [[ -s "$work/none.txt" ]]; then
    echo "$id" >> scripts/qa/charters/.no-flow; echo "$id has no flow to test: $(head -1 "$work/none.txt")"
  else
    echo "no charter for $id (log: $work/claude.log)" >&2
  fi
done
