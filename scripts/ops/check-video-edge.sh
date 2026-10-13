#!/usr/bin/env bash
# Post-deploy check of the video delivery host (S30 AS-60, SC-008 edge half, FR-044/FR-046). Run after a deploy against
# the real CDN; it proves what no API test can: the edge serves public outputs with the headers the design promises,
# refuses unlisted outputs without a credential, never serves an original, and stops serving a deleted video.
#
#   bash scripts/ops/check-video-edge.sh https://stream.marketplace.dev <publicVideoId> [<unlistedVideoId>] [<deletedVideoId>]
#
# Asserts (non-zero exit on the first drift):
#   - p/<publicVideoId>/master.m3u8 answers 200, Content-Type application/vnd.apple.mpegurl, X-Content-Type-Options:
#     nosniff, Cache-Control with max-age=31536000 and immutable, no Set-Cookie, and an Access-Control-Allow-Origin
#     without credentials;
#   - u/<unlistedVideoId>/master.m3u8 without a credential answers 403 (a signed cookie is required);
#   - vsrc/<anyVideoId>/source answers 403 or 404 (the original is not readable through the edge);
#   - when a deleted public video is given: p/<deletedVideoId>/master.m3u8 answers 403 or 404 (poll for up to 10 minutes).
set -euo pipefail

host="${1:?usage: $0 <host> <publicVideoId> [<unlistedVideoId>] [<deletedVideoId>]}"
public="${2:?usage: $0 <host> <publicVideoId> [<unlistedVideoId>] [<deletedVideoId>]}"
unlisted="${3:-}"
deleted="${4:-}"
host="${host%/}"

fail() { echo "DRIFT: $*" >&2; exit 1; }

headers="$(curl -fsS -D - -o /dev/null --max-time 15 "$host/p/$public/master.m3u8")" || fail "$host/p/$public/master.m3u8 did not answer 200"
lower="$(printf '%s' "$headers" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
echo "$lower" | grep -q '^content-type: application/vnd.apple.mpegurl' || fail "Content-Type is not application/vnd.apple.mpegurl"
echo "$lower" | grep -q '^x-content-type-options: nosniff' || fail "X-Content-Type-Options: nosniff is missing"
echo "$lower" | grep -q '^cache-control: .*max-age=31536000' || fail "Cache-Control lacks max-age=31536000"
echo "$lower" | grep -q '^cache-control: .*immutable' || fail "Cache-Control lacks immutable"
if echo "$lower" | grep -q '^set-cookie:'; then fail "the video host sets a cookie"; fi

cors="$(curl -sS -D - -o /dev/null --max-time 15 -H 'Origin: https://example.org' "$host/p/$public/master.m3u8" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
if echo "$cors" | grep -q '^access-control-allow-credentials: true'; then fail "the public path allows CORS with credentials"; fi

status() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" || true; }

if [ -n "$unlisted" ]; then
  code="$(status "$host/u/$unlisted/master.m3u8")"
  [ "$code" = "403" ] || fail "an unlisted output is readable without a credential (HTTP $code)"
fi

code="$(status "$host/vsrc/$public/source")"
case "$code" in 403|404) ;; *) fail "an original is readable through the video host (HTTP $code)" ;; esac

if [ -n "$deleted" ]; then
  waited=0
  until case "$(status "$host/p/$deleted/master.m3u8")" in 403|404) true ;; *) false ;; esac; do
    [ "$waited" -lt 600 ] || fail "a deleted video is still served after 10 minutes"
    sleep 15
    waited=$((waited + 15))
  done
  echo "deleted video gone from the edge after ${waited}s"
fi

echo "video edge OK: $host"
