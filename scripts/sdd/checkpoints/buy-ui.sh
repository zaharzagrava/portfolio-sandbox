#!/usr/bin/env bash
# The buy flow through the API only, as a person would do it: register, sign in, a product of its own, cart, checkout, pay with the sandbox card,
# then wait up to 30 s for the order to be PAID. Exit 0 = the flow works. On failure it prints the stuck step and what is behind it (order, payment,
# outbox rows, queue state). Needs the dev stack and the API (API_URL, default http://localhost:8000). Run by checkpoint.sh for the label buy-ui.
set -uo pipefail
API="${API_URL:-http://localhost:8000}/api"
PW='SuperSecurePassword123!'; SELLER=seller@marketplace.local; SELLER_PW='Demo-Seed-Pw-7491!'
BUYER="buyflow-$(date +%s)-$RANDOM@example.com"; STAMP="$(date +%s)$RANDOM"
fail() { echo "BUY FLOW FAILED at: $1" >&2; shift; [[ $# -gt 0 ]] && printf '%s\n' "$@" >&2; diagnose; exit 1; }
# curl wrapper: body in $BODY, status in $CODE
call() { local method="$1" path="$2" data="${3:-}"; shift 3 2>/dev/null || shift $#; local args=(-s -o /tmp/buyui.$$ -w '%{http_code}' -X "$method" "$API$path" -H 'content-type: application/json')
  [[ -n "${TOKEN:-}" ]] && args+=(-H "authorization: Bearer $TOKEN"); [[ -n "$data" ]] && args+=(-d "$data"); args+=("$@")
  CODE="$(curl "${args[@]}")"; BODY="$(cat /tmp/buyui.$$ 2>/dev/null)"; rm -f /tmp/buyui.$$; }
diagnose() {
  echo "--- what is behind it" >&2
  [[ -n "${PAY_ID:-}" ]] && { call GET "/payments/$PAY_ID" ""; echo "payment: $BODY" >&2; }
  [[ -n "${ORDER_ID:-}" ]] && { call GET "/orders/$ORDER_ID" ""; echo "order: $(echo "$BODY" | jq -c '{status,totalMinor}' 2>/dev/null || echo "$BODY")" >&2; }
  local pg; pg="$(docker ps --format '{{.Names}}' | grep -m1 payment_system_db || true)"
  if [[ -n "$pg" ]]; then
    echo "outbox rows that are not published (topic, kind, status, attempts, parked reason, error):" >&2
    docker exec -i "$pg" psql -U postgres -d marketplace -At >&2 2>&1 <<'SQL' || true
select topic, kind, status, attempts, coalesce("parkedReason",''), left(coalesce(error::text,''),160) from "Outbox" where status <> 'published' order by "createdAt" desc limit 5;
SQL
  fi
  local mq; mq="$(docker ps --format '{{.Names}}' | grep -m1 payment_system_elasticmq || true)"
  if [[ -n "$pg" && -n "$mq" ]]; then   # a waiting task whose queue the queue server does not know is the clearest cause there is
    local have want; have="$(curl -s 'localhost:9324/?Action=ListQueues' | grep -o '<QueueUrl>[^<]*' | sed 's#.*/##')"
    want="$(docker exec -i "$pg" psql -U postgres -d marketplace -At -c "select distinct topic from \"Outbox\" where kind='task' and status <> 'published'" 2>/dev/null)"
    for q in $want; do grep -qx "$q" <<<"$have" || echo "CAUSE: outbox rows wait for queue '$q' and the queue server has no such queue (infra/docker/elasticmq/elasticmq.conf)" >&2; done
  fi
  # a consumer that fails the message names its reason in the API log (a payment that stays PENDING with nothing parked is usually this)
  local alog="${API_LOG:-$(ls -t /tmp/tmp.*/api.log /tmp/api*.log 2>/dev/null | head -1)}"
  if [[ -n "$alog" && -f "$alog" ]]; then
    local fl; fl="$(sed 's/\x1b\[[0-9;]*m//g' "$alog" | grep -E "\[[a-z-]+\] message [0-9a-f-]+ failed" | tail -3 | cut -c1-240)"
    [[ -n "$fl" ]] && { echo "CAUSE (API log $alog): a queue consumer fails its message:" >&2; echo "$fl" >&2; }
  fi
  [[ -n "$mq" ]] && { echo "payment queues known to the queue server:" >&2; curl -s 'localhost:9324/?Action=ListQueues' | grep -o '<QueueUrl>[^<]*' | sed 's/<QueueUrl>.*\///' | grep -i "payments\|refund" | sed 's/^/  /' >&2; }
}

# 0 the stack must be healthy before the flow starts (a missing queue or a parked row is named here, not 30 s later as a stuck order)
DOCTOR="$(dirname "${BASH_SOURCE[0]}")/../../infra/doctor-live.sh"
if [[ -x "$DOCTOR" ]]; then out="$("$DOCTOR" --quiet 2>&1)" || fail "the stack is not healthy before the flow" "$out"; fi

# 1 seller product with its own stock (a seeded product's stock is shared by every run)
TOKEN=""; call POST /auth/login "{\"email\":\"$SELLER\",\"password\":\"$SELLER_PW\"}"
if [[ "$CODE" == 401 ]]; then (cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pnpm --filter api seed:dev >/dev/null 2>&1); call POST /auth/login "{\"email\":\"$SELLER\",\"password\":\"$SELLER_PW\"}"; fi   # a fresh stack has no seeded accounts
[[ "$CODE" == 200 ]] || fail "seller sign-in ($CODE)" "$BODY"
TOKEN="$(echo "$BODY" | jq -r .accessToken.token)"
call GET /shops/mine ""; SHOP="$(echo "$BODY" | jq -r '(.items // .)[0].id')"; [[ -n "$SHOP" && "$SHOP" != null ]] || fail "seller shop ($CODE)" "$BODY"
TITLE="Buyflow Lantern $STAMP"
call POST "/shops/$SHOP/products" "{\"title\":\"$TITLE\",\"brand\":\"Test\",\"category\":\"buyflow-$STAMP\",\"quantity\":50,\"priceMinor\":1999,\"description\":\"$TITLE. Created by the buy flow check.\",\"tags\":[\"buyflow\"]}"
[[ "$CODE" == 201 ]] || fail "create product ($CODE)" "$BODY"

# 2 the product becomes searchable (indexing is asynchronous)
TOKEN=""; PID=""
for _ in $(seq 1 40); do
  call GET "/products/search?q=$(printf %s "$TITLE" | jq -sRr @uri)" ""
  PID="$(echo "$BODY" | jq -r --arg t "$TITLE" '.items[]? | select(.title==$t) | .id' 2>/dev/null | head -1)"; [[ -n "$PID" ]] && break; sleep 1
done
[[ -n "$PID" ]] || fail "search never found the new product within 40 s (indexing broken?)" "last answer: $CODE $BODY"

# 3 a buyer registers and signs in
call POST /auth/register "{\"email\":\"$BUYER\",\"password\":\"$PW\"}"
[[ "$CODE" == 202 ]] || fail "register ($CODE)" "$BODY"
call POST /auth/login "{\"email\":\"$BUYER\",\"password\":\"$PW\"}"; [[ "$CODE" == 200 ]] || fail "buyer sign-in ($CODE)" "$BODY"
TOKEN="$(echo "$BODY" | jq -r .accessToken.token)"

# 4 cart and checkout
call PUT "/cart/items/$PID" '{"quantity":2}'; [[ "$CODE" == 200 ]] || fail "add to cart ($CODE)" "$BODY"
call GET /cart ""; TOTAL="$(echo "$BODY" | jq -r '.totalMinor // .subtotalMinor // empty')"
call POST /checkout "{${TOTAL:+\"expectedTotalMinor\":$TOTAL}}" -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)"
[[ "$CODE" == 202 ]] || fail "checkout ($CODE)" "$BODY"
ORDER_ID="$(echo "$BODY" | jq -r .orderId)"

# 5 pay with the sandbox card
call POST /payments/intents "{\"orderId\":\"$ORDER_ID\",\"paymentMethodId\":\"pm_card_visa\"}" -H "Idempotency-Key: $(cat /proc/sys/kernel/random/uuid)"
[[ "$CODE" == 200 || "$CODE" == 201 || "$CODE" == 202 ]] || fail "create the payment ($CODE)" "$BODY"
PAY_ID="$(echo "$BODY" | jq -r '.paymentId // .id')"

# 6 the order must become PAID
for _ in $(seq 1 30); do
  call GET "/orders/$ORDER_ID" ""; STATUS="$(echo "$BODY" | jq -r .status)"
  [[ "$STATUS" == PAID ]] && { echo "buy flow OK: order $ORDER_ID is PAID"; [[ -x "$DOCTOR" ]] && { out="$("$DOCTOR" --quiet 2>&1)" || fail "the order is PAID but the stack reports problems" "$out"; }; exit 0; }; sleep 1
done
fail "the order stayed $STATUS for 30 s after the payment was accepted (payment $PAY_ID)"
