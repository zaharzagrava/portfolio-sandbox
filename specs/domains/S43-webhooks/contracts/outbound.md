# Contract: outbound webhook to a receiver (S43)

## Request

`POST <endpoint url>` over https, port 443, never redirected. Headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Marketplace-Webhooks/1` |
| `Marketplace-Signature` | `t=<unix seconds>,v1=<hex>[,v1=<hex>]`; HMAC-SHA256 with key = one active secret over `"<t>.<exact body bytes>"`; current secret first, previous second while valid (taken per attempt) |
| `Marketplace-Event-Id` | `evt_…` (same on every attempt and replay) |
| `Marketplace-Delivery-Id` | new per delivery (replays and pings get their own) |
| `Marketplace-Event-Type` | the type |
| `Marketplace-Attempt` | 1-based attempt number |
| `Marketplace-Replay` | `1` on replays only |

## Body

```json
{ "id": "evt_…", "object": "event", "type": "order.paid", "created": "<source occurredAt>",
  "api_version": "2026-10-01", "resource_version": 12, "data": { "object": { … } } }
```

`resource_version` is null for pings. Money is integer minor units (`{amount, currency}` in the latest version; older pinned versions render through S42's transformer). Only the receiving shop's slice; no buyer identity; cancel/refund without amounts. Body ≤ 256 KiB, bytes identical across attempts and replays.

`data.object` shapes: `order` `{id, object, shop_order_id, status, total, lines[{product_id, title, quantity, unit_price}]}` (cancel/refund: `{id, object, status, reason?}`); `product` `{id, object, title, price, stock, status, changed_fields}` (deleted: `{id, object}`; stock_low adds `threshold: 5`); `payout` `{id, object, amount, period_start, status, transfer_ref? | failure_code?}`; ping `{object: "ping"}`.

## Receiver duties and our behaviour

- Success is any `2xx`; everything else (including `3xx`, resets, timeouts, our own blocked-address refusal) is a failed attempt.
- Deadline 10 s overall; only 1 KiB of the response is read.
- Retries: attempts 1–3 30 s apart in the endpoint's lane, then 5 min, 30 min, 2 h, 5 h, 10 h, 24 h, 24 h, 24 h (±20 % jitter, `Retry-After` honoured, cap 24 h); then `exhausted`, replayable for 30 days.
- A retried event can arrive after newer ones: use `created` and `resource_version`; deduplicate on `id`.
- Three days of continuous failure disables the endpoint and alerts the shop's owners (host only).

## Reference verifier (published in the developer docs; the function the tests use)

`verify(header, rawBody, secrets[], now, toleranceSeconds = 300) → boolean`: never throws; false for absent/empty header, missing or duplicate `t`, non-numeric `t`, no `v1`, odd-length or non-hex `v1`, `|now − t| > tolerance`; true if any `v1` matches any secret; constant-time comparison. Lives in `domain/signature.ts` (clock injected) and is exported through the contracts package for docs.
