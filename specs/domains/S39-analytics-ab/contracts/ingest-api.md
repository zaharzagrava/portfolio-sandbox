# Contract: event ingestion (fallback `POST /api/events`, edge `POST /collect`, topic `analytics.events`)

Schemas live in `packages/contracts/src/analytics/` (`ingest.ts` for the zod request/response schemas, `ingest-rules.ts` for the dependency-free rules shared with the edge worker, `stored-event.ts` extended). All error bodies are problem+json with a stable `code`.

## Request

`POST /api/events` and `POST /collect`, `Content-Type: application/json` or `text/plain` (same JSON, what `sendBeacon` sends); anonymous allowed; optional `Authorization: Bearer` (a bad or expired token leaves the request anonymous); optional `X-Client-Platform`, `CF-IPCountry` + `X-Edge-Credential` (edge only).

```json
{ "events": [ { "event_id": "uuid", "name": "page_view", "anonymous_id": "8-64 [A-Za-z0-9_-]",
                "ts": 1760000000000, "page": "≤500 chars", "props": { "k": "string ≤500 | number | boolean" } } ] }
```

Rules: 1–50 events; body ≤ 128 KiB; names `page_view product_view search add_to_cart checkout_step exposure click video_view` (`purchase` is server-only); props flat, ≤ 30 keys, key 1–64 `[A-Za-z0-9_.-]`; body fields `user_id`, `received_at`, `country`, `platform` → `forbidden_field`; other unknown top-level fields ignored.

## Response

| Case | Status | Body |
|---|---|---|
| valid envelope (even `accepted: 0`) | `202` | `{accepted: number, rejected: [{index, code}]}` (`ingestResultSchema`), `rejected` in input order |
| not JSON, `events` missing / not an array / 0 / 51 | `400` | `validation_failed` |
| body > 128 KiB | `413` | `payload_too_large` |
| other content type | `415` | `unsupported_media_type` |
| over 120 requests/min per user or IP | `429` | `rate_limited` + `Retry-After` (+ structured `RateLimit` headers from S50) |
| stream not acknowledged within 2 s (fallback only) | `503` | `ingest_unavailable` + `Retry-After` |

Per-event codes (closed list): `invalid_event_id`, `unknown_event_name`, `invalid_anonymous_id`, `invalid_timestamp`, `invalid_props`, `invalid_page`, `invalid_exposure`, `forbidden_field`, `event_too_old`, `duplicate_in_batch`. Precedence when an event has several problems: the order above, first match wins (one code per event; pinned by the vectors).

Exposure shapes (exactly one): `props {experiment, variant}` or `props {flag_key, variant, flag_version}`, all strings, `variant` 1–32 characters.

Clock: `ts < now − 7 d` → `event_too_old`; `ts > now + 10 min` → stored `ts = now`; otherwise kept (boundaries inclusive: exactly `now − 7 d` and exactly `now + 10 min` are kept as sent).

Enrichment: `user_id` from the verified token only; `country` only with the edge credential (two uppercase letters, not `XX`/`T1`); `platform` ∈ `web|ios|android`, default `web`, never `server`; no IP, no user agent.

## Edge differences (observable)

`202` is sent before the stream acknowledges; failed produces are retried 3 times with full-jitter backoff in `waitUntil`; the edge never answers `503`; the rate limit is the edge's own store (fail open). Everything else, including the per-index codes, is identical (vectors).

## Topic `analytics.events`

Key `anonymous_id`; value = stored event: `{event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props}`, `ts`/`received_at` `YYYY-MM-DD HH:mm:ss.SSS` UTC, `props` all strings. Schema `storedAnalyticsEventSchema` (extended additively, see `plan.md` follow-up 1). Guarantees: at-least-once; `product_view` and `add_to_cart` forward `props.product_id` and `props.category` unchanged. Consumers: S35 (idempotent by `event_id`), ClickHouse's own Kafka engine (group `clickhouse-analytics`).

## Shared vectors

`packages/contracts/src/analytics/ingest-vectors.json`: `[{name, now, request: {headers, body}, expect: {status, accepted, rejected: [{index, code}], stored: [...] }}]` covering AS-01 – AS-07 and AS-11 inputs, ids of 7/8/64/65 characters, 30/31 props, key/value lengths, ±1 ms around both clock limits. Read by `analytics-ingest.e2e-spec.ts` (fallback) and `edge-be/test/collect.spec.ts` (edge); `received_at` is compared as `now`.

## Breaking changes (from `questions.md`)

`rejected` items change from `{index, error: text}` to `{index, code}`; the edge response `rejected` changes from a number to the same array; 413/415/503 are new; `anonymous_id`/`ts`/props rules tighten; `forbidden_field` is new. Known emitter: `packages/web/lib/api/events.ts` (W02) ignores partial rejections and retries only `408/429/5xx`, so it keeps working unchanged. `packages/contracts/src/events/client-events.ts` (`clientEventSchema`, W02's) already lists the same eight names and is looser on `anonymous_id` characters; S39 does not edit it, a drift test (research R-19) fails if the name lists diverge, and W02 gets a follow-up bullet to tighten the charset.
