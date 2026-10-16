# Contract: journey control surface

All routes are under `/api`, admin role required, `application/problem+json` errors with a stable `code` (V.3). Zod schemas live in `packages/contracts/src/admin/` and e2e specs parse with them (VII.6). Existing contracts consumed by the journey (S10, S13–S16, S28, S51) are in their own specs and are not repeated.

## Jobs (S49 service, S01 admin routes)

`POST /api/admin/jobs` — header `Idempotency-Key` (required).
Body `{ type, payload? }`; `type` ∈ allow-list `payouts.run-weekly`, `statements.close-month`, `payments.reconcile-daily`.
- `202 { jobId }`. Same key + same body → same `jobId`; in flight → `409 idempotency_in_flight`; same key, different body → `422 idempotency_key_reuse`.
- `422 job_type_not_allowed` for any other type; `422 invalid_payload` (e.g. malformed `periodStart`); `401`; `403` for non-admin.

`GET /api/admin/jobs/:jobId` → `{ id, type, status: QUEUED|RUNNING|SUCCEEDED|FAILED|DEAD, attempts, finishedAt|null }`; unknown id `404 job_not_found`. Starts within 5 s (H13).

## Consumers (S53)

`GET /api/admin/consumers/:group` → `{ group, topics[], state: RUNNING|PAUSED, lag, lastProcessedAt|null }`; unknown group `404 consumer_not_found`.
`POST …/pause` → `200` current view (already paused: `200`, no change). `POST …/resume` → `200` (idempotent). `POST …/replay { since: ISO }` → `202`; `since` in the future or malformed `422`.
Groups of the journey: `payments-order-copy`, `orders-payment-results`, `ledger-settlement`, `ledger-balances`, `notification-router`, `statements-facts`.
Admin role **and** a sensitive session in every profile. A pause is visible to all processes running the group within 2 s.

## DLQ redrive (S53, G-26)

`POST /api/admin/consumers/:group/dlq/redrive { limit? }` → `202 { requeued }`; `GET /api/admin/consumers/:group` also returns `dlqDepth`. A metric `consumer_dlq_depth{group}` backs an alert.

## Clock (S54)

Enabled only by `CLOCK_CONTROL=enabled`; otherwise the routes answer `404`. Startup fails when enabled in production.
`GET /api/admin/clock` → `{ now: ISO, mode: "real"|"offset", offsetSeconds }`.
`PUT /api/admin/clock { advanceSeconds }` (integer 1…`31_536_000`) → `200` view; negative or zero → `422`. `PUT { mode: "real" }` → `200`, offset cleared (idempotent). All processes use the new time within 1 s.

## Provider doubles (local/test profile, not HTTP)

Enabled by `PROVIDER_DOUBLES=enabled` (refused in production). `paymentMethodId`: `pm_test_visa` succeeds; `pm_test_declined` definite decline; `pm_test_slow` succeeds after 8 s; `pm_test_timeout` never answers. `providerAccountId`: `acct_test_ok`; `acct_test_reject` definite rejection; `acct_test_timeout` no answer. Unknown ids behave as `ok`. Charge currency is the order's currency.

## Tests per route (VII.2/VII.3)

Happy path, each validation class, `401`, `403` non-admin, idempotency (replay/in-flight/different body) for jobs, concurrent pause/resume, a clock refusal test (production config rejects), a persisted-state assertion (flag/offset/job row).
