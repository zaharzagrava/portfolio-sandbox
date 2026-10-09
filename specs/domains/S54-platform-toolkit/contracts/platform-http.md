# Contract: platform HTTP behaviour

## Probes (outside the global prefix; unauthenticated; never rate-limited, shed or access-logged at `info`; `Cache-Control: no-store`; `GET` and `HEAD`)

| Path | 200 when | 503 when | Body |
|---|---|---|---|
| `/health/live` | event-loop p99 ≤ liveness threshold (10 000 ms) and all heartbeats within `maxSilenceMs`; stays 200 during shutdown | threshold exceeded or heartbeat silent | `{ "status": "up" \| "down", "checks"?: { name: "up"\|"down" } }` (no uptime, no error text) |
| `/health/ready` | startup finished, shutdown not begun, no pod-critical check failing; `shared` checks reported only | not started / shutting down / critical check down (or promoted shared check past `failureThreshold`) | `{ "status", "reason"?, "checks": { name: "up"\|"down" } }` |
| `/health/startup` | all warm-ups done (never regresses) | warm-ups pending | `{ "status" }` |

Check timeout 500 ms (abort signal), result cache 2 s, concurrent evaluations share one run. Gauges: `platform_ready`, `health_check_up{check}`.

Apps without HTTP serve the same three paths on the management listener (`management_port`). `/metrics` is served only on a non-public port.

## Pipeline order (AS-140), fixed in `configureHttpApp`

1. request context + `X-Request-Id` (valid single header kept, else UUIDv7), client IP resolution
2. load shedding (before body parsing)
3. helmet / CORS / compression (skips `text/event-stream` and `no-transform`)
4. body parsers with 1 MiB limit + `request.rawBody`
5. guards (authentication, coarse roles)
6. rate limiter (S50, interceptor)
7. idempotency interceptor
8. `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`
9. handler
10. exception filter (single renderer)

## Response headers on every response

Security: `X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-site`, `Referrer-Policy: no-referrer`, CSP, HSTS in production; `@SecurityPolicy('public-embed')` relaxes the named set. `X-Request-Id` always. CORS `exposedHeaders`: `X-Request-Id, Retry-After, RateLimit, RateLimit-Policy, Idempotency-Replayed`; `allowedHeaders` include `Idempotency-Key`. Production startup fails on an empty allowlist, or `*` with credentials.

## Idempotency (routes with `@Idempotent`)

| Situation | Result |
|---|---|
| key missing on `required` route | `422 idempotency_key_required` |
| key malformed / header repeated | `422 idempotency_key_invalid` |
| first request | handler runs; result stored (awaited) |
| replay of completed | stored status/headers/body + `Idempotency-Replayed: true` |
| same key still in flight (lock not expired) | `409 idempotency_in_flight`, `Retry-After: 1` |
| same key, different fingerprint | `422 idempotency_key_reuse` |
| handler error not marked `idempotencyFinal` | key released, error returned |
| stored body over 256 KiB | replay `409 idempotency_replay_unavailable` |
| store unavailable | `503 idempotency_unavailable` |

Scope: authenticated principal, else client address. TTL 24 h (route override ≤ 7 days). Purge job `platform.purge-idempotency-keys`.

## Load shedding

Priority per route (`@LoadSheddingPriority`, default `default`). Threshold `T` = 200 ms event-loop p99: background ≥ T, default ≥ 2T, critical ≥ 5T; in-flight cap 1 000 (critical 2 000). Stop after two samples below 0.8 × tier threshold. Probes and metrics never shed. Fail open when the monitor is unavailable. Response `503 service_overloaded` with `Retry-After` ∈ {1,2,3}, `Connection: close`, `X-Request-Id`.

## Database session settings

`statement_timeout` 30 s, `idle_in_transaction_session_timeout` 30 s, `application_name`, pool acquire timeout 3 s (→ `503 database_unavailable`). Replica handle `READ_REPLICA_CONNECTION`: read-only, verified TLS in production.
