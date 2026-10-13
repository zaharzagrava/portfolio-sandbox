#!/usr/bin/env bash
# Post-deploy check of the media origin (S29 AS-60, FR-070). Run after a deploy against the real origin; it proves what no
# API test can: the CDN answers a derived variant with the headers the design promises, and refuses originals.
#
#   bash scripts/ops/check-media-origin.sh https://dxxxx.cloudfront.net media/derived/<sha256>.webp [media/originals/shops/<id>/<uuid>]
#
# Asserts (non-zero exit on the first drift):
#   - the variant answers 200 with Content-Type image/webp;
#   - X-Content-Type-Options: nosniff;
#   - Cache-Control: public, max-age=31536000, immutable;
#   - no Set-Cookie header;
#   - when an original key is given: it is NOT readable through the origin (403/404).
set -euo pipefail

origin="${1:?usage: $0 <origin> <sample-variant-key> [<original-key>]}"
variant="${2:?usage: $0 <origin> <sample-variant-key> [<original-key>]}"
original="${3:-}"
origin="${origin%/}"

fail() { echo "DRIFT: $*" >&2; exit 1; }

headers="$(curl -fsS -D - -o /dev/null --max-time 15 "$origin/$variant")" || fail "$origin/$variant did not answer 200"
lower="$(printf '%s' "$headers" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"

echo "$lower" | grep -q '^content-type: image/webp' || fail "Content-Type is not image/webp"
echo "$lower" | grep -q '^x-content-type-options: nosniff' || fail "X-Content-Type-Options: nosniff is missing"
echo "$lower" | grep -q '^cache-control: .*max-age=31536000' || fail "Cache-Control lacks max-age=31536000"
echo "$lower" | grep -q '^cache-control: .*immutable' || fail "Cache-Control lacks immutable"
if echo "$lower" | grep -q '^set-cookie:'; then fail "the media origin sets a cookie"; fi

if [ -n "$original" ]; then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$origin/$original" || true)"
  case "$code" in
    403|404) ;;
    *) fail "an original is readable through the media origin (HTTP $code)" ;;
  esac
fi

echo "media origin OK: $origin"
