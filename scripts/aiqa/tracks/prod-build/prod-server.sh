#!/usr/bin/env bash
# The production web server on port 3100 (distDir .next-prod, the same one Playwright's W07_PROD uses), against the API on 8000.
#   prod-server.sh up       build it only if .next-prod is older than the sources, then start it detached (waits until it answers)
#   prod-server.sh down     stop the one this script started (never touches a server it did not start)
#   prod-server.sh status   prints "up" or "down"
# Pid and log live in $AIQA_PROD_DIR (default /tmp/aiqa-prod-server).
set -uo pipefail
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WEB="$ROOT/packages/web"
D="${AIQA_PROD_DIR:-/tmp/aiqa-prod-server}"; mkdir -p "$D"
PORT=3100
alive() { curl -s -o /dev/null --max-time 5 "http://localhost:$PORT/"; }
case "${1:-status}" in
  status) alive && echo up || echo down ;;
  down)
    if [[ -f "$D/pid" ]]; then   # setsid made a session of its own: end every process of it (pnpm, sh, next-server)
      sid="$(ps -o sid= -p "$(cat "$D/pid")" 2>/dev/null | tr -d ' ')"
      if [[ -n "$sid" ]]; then pkill -s "$sid" 2>/dev/null; else kill "$(cat "$D/pid")" 2>/dev/null; fi
      rm -f "$D/pid"; echo "stopped"; else echo "no server of mine to stop"; fi
    if [[ -f "$D/webdir" ]]; then rm -rf "$(cat "$D/webdir")"; rm -f "$D/webdir"; fi ;;
  up)
    if alive; then echo "already up on $PORT"; exit 0; fi
    curl -sf localhost:8000/health/ready >/dev/null || { echo "the API on 8000 is not ready" >&2; exit 1; }
    stamp="$WEB/.next-prod/BUILD_ID"
    stale=1
    if [[ -f "$stamp" ]]; then
      newer="$(find "$WEB/app" "$WEB/components" "$WEB/lib" "$WEB/public" "$WEB/next.config.ts" "$WEB/package.json" "$ROOT/packages/contracts/src" -type f -newer "$stamp" 2>/dev/null | grep -v -E '\.(test|spec)\.' | head -1)"
      [[ -z "$newer" ]] && stale=0 || echo "build is stale (for example $newer)"
    fi
    if [[ $stale == 1 ]]; then
      echo "building the production bundle (a few minutes)..."
      if (cd "$WEB" && pnpm run build:e2e >"$D/build.log" 2>&1); then rm -f "$D/webdir"
      elif grep -qE '\.(test|spec)\.tsx?\([0-9]+,[0-9]+\): error TS' "$D/build.log" && ! grep -E 'error TS' "$D/build.log" | grep -vqE '\.(test|spec)\.tsx?\('; then
        # The type check of `next build` also reads test files (tsconfig includes **/*.ts). Only test files fail: the product code is fine.
        # Build a throwaway copy without tests (never edit the real tests); the failure itself is reported by run.sh.
        echo "build failed ONLY on type errors inside test files (see $D/build.log); building from a copy without tests"
        cp "$D/build.log" "$D/build-failed-in-tests.log"
        COPY="$ROOT/packages/.web-aiqa-copy"; rm -rf "$COPY"; mkdir -p "$COPY"
        (cd "$WEB" && tar --exclude=./node_modules --exclude='./.next*' --exclude=./playwright-report --exclude=./test-results --exclude=./reports --exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts' --exclude='./aiqa-*' -cf - .) | tar -xf - -C "$COPY"
        ln -s "$WEB/node_modules" "$COPY/node_modules"
        node -e 'const f=process.argv[1],t=require(f);t.exclude=["node_modules","**/*.test.ts","**/*.test.tsx","**/*.spec.ts"];require("fs").writeFileSync(f,JSON.stringify(t,null,2))' "$COPY/tsconfig.json"
        (cd "$COPY" && pnpm run build:e2e >"$D/build-copy.log" 2>&1) || { echo "copy build failed: see $D/build-copy.log" >&2; exit 1; }
        echo "$COPY" >"$D/webdir"
      else echo "build failed: see $D/build.log" >&2; exit 1; fi
    else echo "the production build is fresh, not rebuilding"; fi
    [[ -f "$D/webdir" ]] && WEB="$(cat "$D/webdir")"
    (cd "$WEB" && setsid pnpm run start:e2e >"$D/server.log" 2>&1 & echo $! >"$D/pid")
    for _ in $(seq 1 60); do alive && break; sleep 2; done
    alive && echo "production server up on $PORT" || { echo "it did not answer: see $D/server.log" >&2; exit 1; } ;;
esac
