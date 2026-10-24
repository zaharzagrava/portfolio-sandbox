#!/usr/bin/env bash
# Looks at ONE commit made by a fixing agent and says whether it weakens the tests or is too big.
#   scripts/qa/guard-tests.sh <commit> [repo-folder]     exit 0 = fine, exit 1 = rejected (the reasons are printed, one per line), exit 2 = bad call
# Rejected when the commit: removes a test (a title that no longer exists anywhere in the tree), removes an expect( line without putting one back,
# adds .skip / .fixme / xit / .todo, adds retries, raises a timeout or loosens a number in a test (toBeLessThan up, toBeGreaterThan down),
# touches a test-settings file (playwright / vitest / jest config), or is bigger than GUARD_MAX_LINES (150) changed lines or GUARD_MAX_FILES (5) files.
# (scripts/sdd/check-tests.py integrity looks at the working folder against HEAD, not at one commit, so it cannot be used here.)
set -uo pipefail
C="${1:?usage: guard-tests.sh <commit> [repo-folder]}"; REPO="${2:-.}"
MAX_LINES="${GUARD_MAX_LINES:-150}"; MAX_FILES="${GUARD_MAX_FILES:-5}"
g() { git -C "$REPO" "$@"; }
g rev-parse --verify -q "$C^{commit}" >/dev/null || { echo "no such commit: $C" >&2; exit 2; }
bad=()
TESTFILE='\.(e2e-spec|spec|test|journey-spec)\.tsx?$'
CONFIG='(^|/)(playwright\.config|vitest[^/]*\.config|jest[^/]*\.config)\.[cm]?[jt]s$|(^|/)jest[^/]*\.json$'

# size: files and changed lines
files="$(g diff-tree --no-commit-id --name-only -r -m --first-parent "$C")"
nfiles="$(grep -c . <<<"$files")"
nlines="$(g show --format= --numstat "$C" | awk '{ if ($1 != "-") n += $1 + $2 } END { print n + 0 }')"
(( nfiles > MAX_FILES )) && bad+=("too big: $nfiles files (limit $MAX_FILES); needs the owner")
(( nlines > MAX_LINES )) && bad+=("too big: $nlines changed lines (limit $MAX_LINES); needs the owner")

# test-settings files
while IFS= read -r f; do
  [[ -n "$f" ]] && grep -Eq "$CONFIG" <<<"$f" && bad+=("touches a test settings file: $f")
done <<<"$files"

# the lines of the diff, tests files only
diff="$(g show --format= -U0 "$C" | awk -v re="$TESTFILE" '
  /^diff --git/ { intest = ($NF ~ re); next }
  /^(\+\+\+|---)/ { next }
  intest && /^[-+]/ { print }')"
removed="$(grep '^-' <<<"$diff" | sed 's/^-//')"
added="$(grep '^+' <<<"$diff" | sed 's/^+//')"

grep -Eq '\.(skip|fixme|todo)\b|\bx(it|describe|test)\(' <<<"$added" && bad+=("adds a skipped test (.skip / .fixme / .todo / xit)")
grep -Eq '\bretries\b' <<<"$added" && ! grep -Eq '\bretries\b' <<<"$removed" && bad+=("adds retries to a test")

# removed test titles must still exist somewhere in the tree after the commit
while IFS= read -r line; do
  title="$(sed -nE "s/^[[:space:]]*(it|test)(\.[a-z]+)?\(\s*(['\"\`])(.*)\3.*/\4/p" <<<"$line")"
  [[ -z "$title" ]] && continue
  g grep -qF -- "$title" "$C" -- '*.ts' '*.tsx' || bad+=("removes the test: $title")
done <<<"$removed"

# fewer expect( lines than before
nr="$(grep -c 'expect(' <<<"$removed")"; na="$(grep -c 'expect(' <<<"$added")"
(( nr > na )) && bad+=("removes expect( lines: $nr removed, $na added")

# loosened numbers: a removed and an added line that are the same except for one number
pairs="$( { sed 's/^/-/' <<<"$removed"; sed 's/^/+/' <<<"$added"; } | awk '
  function norm(s) { gsub(/[0-9][0-9_.]*/, "N", s); return s }
  function nums(s, a,   n) { n = 0; while (match(s, /[0-9][0-9_.]*/)) { a[++n] = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH) } return n }
  { sign = substr($0, 1, 1); line = substr($0, 2); key = norm(line)
    if (sign == "-") { old[key] = line }
    else if (key in old && old[key] != line) {
      nums(old[key], a); nums(line, b)
      kind = ""
      if (line ~ /timeout|Timeout|toBeLessThan|toBeLessThanOrEqual|toBeCloseTo|slow/) kind = "up"
      if (line ~ /toBeGreaterThan|toBeGreaterThanOrEqual|toHaveLength|toHaveCount|toBeGreater/) kind = "down"
      if (kind == "up" && (b[1] + 0) > (a[1] + 0)) print "raised a limit: " line
      if (kind == "down" && (b[1] + 0) < (a[1] + 0)) print "lowered a lower bound: " line
    } }')"
while IFS= read -r p; do [[ -n "$p" ]] && bad+=("$p"); done <<<"$pairs"

if (( ${#bad[@]} )); then
  printf 'REJECTED %s:\n' "$(g rev-parse --short "$C")"; printf '  - %s\n' "${bad[@]}"; exit 1
fi
exit 0
