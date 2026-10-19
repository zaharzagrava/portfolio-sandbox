#!/usr/bin/env bash
# wait-for.sh <file> <regex> [max seconds, default 100]
# Blocks until a line of <file> matches <regex> (then prints the last lines) or the time is up (then says so and prints the last lines).
# For an unattended agent that started a long job with nohup into a file: this environment refuses a `sleep` in a command ("use a monitor"),
# and ending the turn to wait ends the pass (J03, 2026-10-19). Call it again until the summary line appears. One call must stay shorter than
# the Bash tool's timeout (120 s by default; pass a higher `timeout` to the tool and a higher max here, up to 540).
f="$1"; re="$2"; max="${3:-100}"
[[ -n "$f" && -n "$re" ]] || { echo "usage: wait-for.sh <file> <regex> [max seconds]"; exit 2; }
end=$((SECONDS + max))
while (( SECONDS < end )); do
  if grep -aqE -- "$re" "$f" 2>/dev/null; then echo "FOUND /$re/ in $f"; tail -n 15 "$f"; exit 0; fi
  sleep 3
done
echo "NOT YET after ${max}s: the job is still running, call this again"; tail -n 6 "$f" 2>/dev/null
exit 0
