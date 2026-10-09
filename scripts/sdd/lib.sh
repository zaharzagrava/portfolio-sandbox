# Shared helpers for scripts/sdd/*.sh (sourced, not executed).

NOTES_DIR="${NOTES_DIR:-interview-prep}"

# Headless Claude Code flags. Override the whole set with CLAUDE_ARGS="..." (word-split, no globbing).
# Spec writing only needs file tools; implementation adds the test/build commands in implement-specs.sh.
# `--allowedTools` is variadic, so the list goes in as ONE comma-separated value and the prompt is passed
# first: otherwise the CLI swallows the prompt as more tool names and waits on stdin.
SPEC_TOOLS=('Read' 'Grep' 'Glob' 'Write' 'Edit' 'Bash(.specify/scripts/bash/*)' 'Bash(ls:*)' 'Bash(git status:*)' 'Bash(git diff:*)' 'Bash(pnpm --dir packages/backend check:table-ownership)')

# run_claude <logfile> <prompt> [extra tool rules...]
run_claude() {
  local log="$1" prompt="$2"; shift 2
  local args tools
  if [[ -n "${CLAUDE_ARGS:-}" ]]; then
    set -f; read -r -a args <<<"$CLAUDE_ARGS"; set +f
  else
    tools="$(IFS=,; echo "${SPEC_TOOLS[*]}${*:+,$*}")"
    args=(-p --permission-mode acceptEdits --add-dir "$NOTES_DIR" --allowedTools "$tools")
  fi
  # Optional safety valve: a step that would spend more than this many USD stops (the run stops with it; nothing is degraded).
  if [[ -n "${STEP_MAX_BUDGET_USD:-}" ]]; then
    args+=(--max-budget-usd "$STEP_MAX_BUDGET_USD")
  fi
  if [[ -n "${CLOUD_SESSION_ID:-}" ]]; then
    args+=(--cloud "$CLOUD_SESSION_ID")
  fi
  claude "$prompt" "${args[@]}" </dev/null >"$log" 2>&1
}

# for_each_capability [ID|domain ...]: prints matching catalog rows (tab-separated), in catalog order.
for_each_capability() {
  local catalog="$ROOT/scripts/sdd/capabilities.tsv"
  awk -F'\t' -v filter="$*" '
    BEGIN { n = split(filter, f, " "); for (i = 1; i <= n; i++) want[f[i]] = 1 }
    /^#/ || NF < 5 { next }
    n == 0 || ($1 in want) || ($2 in want) { print }
  ' "$catalog"
}

# render_prompt <template> <id> <domain> <slug> <title> <sources> <dir>: fills {{PLACEHOLDERS}}.
# Python, not sed or ${//}: titles may contain characters those treat as special (&, /, |).
render_prompt() {
  python3 - "$@" <<'PY'
import sys
template, id_, domain, slug, title, sources, dir_ = sys.argv[1:8]
text = open(template).read()
for key, value in {"ID": id_, "DOMAIN": domain, "SLUG": slug, "TITLE": title,
                   "SOURCES": ", ".join(s for s in sources.split(";") if s), "DIR": dir_}.items():
    text = text.replace("{{" + key + "}}", value)
print(text)
PY
}

# Capability kind from the catalog's domain column: web app, cross-domain journey, or backend.
kind_of() { case "$1" in web) echo web ;; journeys) echo journey ;; *) echo backend ;; esac; }

# spec_dir <domain> <id> <slug>: where a capability's spec lives (repo-relative).
spec_dir() {
  case "$(kind_of "$1")" in
    web)     echo "specs/web/$2-$3" ;;
    journey) echo "specs/journeys/$2-$3" ;;
    *)       echo "specs/domains/$2-$3" ;;
  esac
}

# template_for <domain>: the /speckit-specify prompt template for that kind of capability.
template_for() {
  case "$(kind_of "$1")" in
    web)     echo "$ROOT/scripts/sdd/spec-prompt-web.md" ;;
    journey) echo "$ROOT/scripts/sdd/spec-prompt-journey.md" ;;
    *)       echo "$ROOT/scripts/sdd/spec-prompt.md" ;;
  esac
}
