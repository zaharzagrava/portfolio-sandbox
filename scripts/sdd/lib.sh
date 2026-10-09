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
  # Run in the background and watch it, because `claude -p` has been seen to print its answer and then not exit
  # (idle for 9 minutes with only helper processes left), which stalls the whole loop:
  #  - `claude -p` prints its answer only at the end, so output that has not grown for CLAUDE_EXIT_GRACE_S seconds
  #    means "finished, not exiting": stop it and count the step as done;
  #  - a call that runs longer than PASS_TIMEOUT_S is stopped and returns 124 (implement passes resume afterwards).
  # SDD_LOOP silences the interactive Stop-hook ping.
  local pid code=0 grace="${CLAUDE_EXIT_GRACE_S:-90}" limit="${PASS_TIMEOUT_S:-7200}" start=$SECONDS size last=-1 since=$SECONDS killed=""
  SDD_LOOP=1 setsid claude "$prompt" "${args[@]}" </dev/null >"$log" 2>&1 &   # own process group: one kill reaches every helper
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    size=$(stat -c %s "$log" 2>/dev/null || echo 0)
    if (( size != last )); then last=$size; since=$SECONDS; fi
    if (( size > 0 && SECONDS - since >= grace )); then killed=done; break; fi
    if (( SECONDS - start >= limit )); then killed=timeout; break; fi
  done
  if [[ -n "$killed" ]]; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null; sleep 5
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    if [[ "$killed" == done ]]; then echo "  (answer was complete but claude did not exit within ${grace}s: stopped it)" >&2; return 0; fi
    echo "  (stopped after the ${limit}s pass timeout)" >&2; return 124
  fi
  wait "$pid"; code=$?
  return "$code"
}

# hit_usage_limit <logfile>: did the step die because the plan's usage window is used up?
hit_usage_limit() {
  tail -c 4000 "$1" | grep -q -i -E "hit your .*limit|session limit|weekly limit|usage limit|limit reached|rate.?limit|limit will reset|resets [0-9]|resets at|out of (extra )?usage|credit balance"
}

# limit_reset_hint <logfile>: "resets 1:40pm (Europe/Warsaw)" from the CLI's message, if it gave one.
limit_reset_hint() { tail -c 4000 "$1" | grep -o -i -E "resets [^|]*" | head -1 | sed 's/[[:space:]]*$//'; }

# notify <ok|info|warn|limit|fail> <title> <body>
#   info   progress and recoveries: quiet (no sound, low urgency)
#   warn   something is slow or stuck: one soft sound
#   ok / limit / fail   the run ended: a distinct sound each
# Channels: desktop (notify-send + canberra) when available, and ntfy when NTFY_TOPIC is set (the topic is the only
# secret: keep it long and random; NTFY_SERVER defaults to https://ntfy.sh). NOTIFY_DRY=1 prints instead of sending.
# Best effort: a missing tool or a failed request is never an error.
notify() {
  local kind="$1" title="$2" body="$3" sound="" urgency=normal prio=3 tag=white_check_mark
  case "$kind" in
    ok)    sound=complete;       urgency=normal;   prio=3; tag=white_check_mark ;;
    info)  sound="";             urgency=low;      prio=2; tag=information_source ;;
    warn)  sound=dialog-warning; urgency=normal;   prio=4; tag=warning ;;
    limit) sound=bell;           urgency=critical; prio=5; tag=hourglass ;;
    fail)  sound=dialog-warning; urgency=critical; prio=5; tag=x ;;
  esac
  if [[ -n "${NOTIFY_DRY:-}" ]]; then echo "NOTIFY[$kind] $title: $body"; return 0; fi
  command -v notify-send >/dev/null && notify-send -u "$urgency" "$title" "$body" || true
  if [[ -n "$sound" ]]; then command -v canberra-gtk-play >/dev/null && { canberra-gtk-play -i "$sound" >/dev/null 2>&1 & } || true; fi
  if [[ -n "${NTFY_TOPIC:-}" ]]; then
    curl -fsS -m 10 -H "Title: $title" -H "Priority: $prio" -H "Tags: $tag" -d "$body" \
      "${NTFY_SERVER:-https://ntfy.sh}/$NTFY_TOPIC" >/dev/null 2>&1 || true
  fi
  return 0
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

# ordered_capabilities [ID|domain ...]: for_each_capability, re-sorted by the order file (IDs it does not list come last, in
# catalog order). The file is scripts/sdd/orders/$ORDER.txt (default by-layer; by-flow builds vertical slices) or ORDER_FILE.
# A line "!STOP <label> <message>" is a checkpoint: with no ID filter it comes out as the row  !STOP<TAB>label<TAB>-<TAB>message<TAB>-
ORDER_FILE="${ORDER_FILE:-$ROOT/scripts/sdd/orders/${ORDER:-by-layer}.txt}"
ordered_capabilities() {
  [[ -f "$ORDER_FILE" ]] || { echo "order file not found: $ORDER_FILE" >&2; return 1; }
  for_each_capability "$@" | awk -F'\t' -v order="$ORDER_FILE" -v withstops="$#" '
    BEGIN {
      while ((getline line < order) > 0) {
        if (line ~ /^#/ || line ~ /^[[:space:]]*$/) continue
        n++
        if (line ~ /^!STOP[[:space:]]/) { stops[n] = line; continue }
        pos[line] = n
      }
    }
    { print (($1 in pos) ? pos[$1] : 100000 + NR) "\t" $0 }
    END {
      if (withstops != 0) exit
      for (i in stops) {
        split(stops[i], w, /[[:space:]]+/); label = w[2]
        msg = stops[i]; sub(/^!STOP[[:space:]]+[^[:space:]]+[[:space:]]*/, "", msg); if (msg == "") msg = label
        print (i - 0.5) "\t!STOP\t" label "\t-\t" msg "\t-"
      }
    }
  ' | sort -n -k1,1 | cut -f2-
}
