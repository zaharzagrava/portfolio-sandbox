#!/usr/bin/env bash
# Runs ONE heavy command at a time on this machine (type check, lint, Playwright, builds).
# Several agents share 31 GB; five parallel type checks and browsers crashed the PC on 2026-10-25.
# Usage: scripts/aiqa/heavy.sh <command...>     (waits for the lock, prints when it waits)
# The lock file descriptor is closed for the command, so servers it starts do not keep the lock.
exec 9>/tmp/aiqa-heavy-run.lock
flock -n 9 || { echo "[heavy] another heavy command runs; waiting for the lock..." >&2; flock 9; }
echo "[heavy] running: $*" >&2
"$@" 9>&-
