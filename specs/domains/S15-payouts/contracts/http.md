# HTTP contracts: S15 — `payments` payouts

Schemas live in `packages/contracts/src/payments/payouts.ts` (re-exported from `src/index.ts`); every e2e parses bodies with them (VII.6). All errors are `application/problem+json` with `code` and `requestId` from the S54 filter; the domain registers its problems with `ProblemCatalogModule.forFeature(PAYOUT_PROBLEMS)`. Controllers: `PayoutsController` (seller, `/shops/:shopId/payouts…`) and `PayoutsAdminController` (`/finance/…`); each method parses params/query/body DTOs, makes one service call, returns the DTO.

Money fields end in `Minor` (integers); timestamps are ISO-8601 UTC strings; `periodStart` is `YYYY-MM-DD`.

## Shared shapes

- `payoutStatusPublic`: `"PENDING" | "IN_TRANSIT" | "PAID" | "FAILED" | "CANCELLED"` (`SENDING`, `UNKNOWN` → `IN_TRANSIT`).
- `payoutStatusInternal`: the six statuses.
- `payoutSchema`: `{ id: uuid, shopId: uuid, periodStart, amountMinor, reserveHeldMinor, currency: "EUR", status: payoutStatusPublic, transferRef: string|null, failureCode: string|null, createdAt, paidAt: string|null }`. **Never**: destination, attempts, raw failure reason, other shops' data, internal ids of history rows.
- `payoutDetailSchema = payoutSchema + { timeline: { status: payoutStatusPublic, at }[] }`.
- `adminPayoutSchema = payoutSchema(status overridden: payoutStatusInternal) + { attempts: int, failureReason: string|null (≤ 200, sanitized), destination: string|null (masked: first 5 + "…" + last 3 chars) }`.
- Cursors: HMAC-signed base64url of `{ k: <sort key>, id }` (`PAYOUT_CURSOR_SECRET` falling back to the ledger cursor secret rule); a cursor signed for another route or tampered → `400 invalid_cursor`. Seller list key `periodStart`, operator list key `createdAt`, runs key `periodStart`.

## Seller routes (member with `payouts.read`)

Guards on all three: `Firewall()` (session → `401`), `ShopScoped('payouts.read')` (non-member and unknown shop → identical `404 shop_not_found`; member without the permission, e.g. VIEWER → `403 permission_denied`), `@RateLimit('finance.payouts.read')` (120 / 60 s per user, fail open, `Retry-After` on `429`). Static route `upcoming` is declared **before** `:payoutId`.

### `GET /shops/:shopId/payouts?limit&cursor`

- `limit` int 1–100 (default 20); `cursor` opaque. Order `periodStart DESC, id DESC` (keyset on `(periodStart, id)`; a payout created between pages never repeats or skips an item).
- `200 payoutPageSchema`: `{ items: payoutSchema[], nextCursor: string|null }`.
- Problems: `400 validation_failed` (limit `0`, `101`, non-number, non-UUID `shopId`), `400 invalid_cursor`, `401`, `403 permission_denied`, `404 shop_not_found`, `429 rate_limited`.
- **Takes over** the route S14 removed.

### `GET /shops/:shopId/payouts/upcoming`

- `200 upcomingPayoutSchema`: `{ shopId, currency: "EUR", availableMinor, reserveMinor, estimatedPayoutMinor, nextRunAt: ISO UTC, blockedReason: null | "payouts_disabled" | "destination_missing" | "destination_cooling" | "below_minimum" }`.
- Computed with the **same pure functions as the run**: authoritative balance (`getBalances`), the shop's reserve (override or default), `computePayout`, the eligibility gates over `getShopsByIds([shopId])` (a shop that is not `ACTIVE` reports `payouts_disabled`: the seller is not told internal status codes), the destination and its `effectiveFrom`. Blocking precedence: `payouts_disabled` → `destination_missing` → `destination_cooling` → `below_minimum`; when blocked, `estimatedPayoutMinor = 0`. `nextRunAt` = the next Monday 06:00 `Europe/Warsaw` strictly after the injected clock, as UTC (`2026-10-12T04:00:00.000Z` for Wednesday `2026-10-07T10:00Z`). A negative balance reports `availableMinor` as is, `reserveMinor 0`, `below_minimum`.
- Problems as above (no `validation_failed` except for a malformed `shopId`).

### `GET /shops/:shopId/payouts/:payoutId`

- Lookup by `(id, shopId)` in one predicate (III.4). `200 payoutDetailSchema`.
- Problems: `400 validation_failed` (malformed `payoutId`), `404 payout_not_found` (another shop's payout and an unknown id are byte-identical), plus the shop-scoped ones above.

## Operator routes (platform `admin` only)

Guards: `Firewall()` then the role guard (`AdminOnly`; `401` without session, `403 permission_denied` otherwise — a shop owner is not an admin). Writes are marked sensitive (`Firewall({ sensitive: true })`, S01 follow-up) so a revoked session is refused. Policies: reads `@RateLimit('finance.admin.read')` (fail open), writes `@RateLimit('finance.admin.write')` (30 / 60 s, **fail closed**: limiter store down → `503`, handler not reached). Writes carry `@Idempotent()`: mandatory `Idempotency-Key` header, stored replay with `Idempotency-Replayed: true`, in-flight → `409 idempotency_in_flight`, different body → `422 idempotency_key_reuse`, missing → `422 idempotency_key_required`, retention 24 h, per principal, a request that failed validation does not consume the key. Order of checks: session → role → rate limit → idempotency header → body schema → lookups → state → one transaction.

### `GET /finance/payouts?status&shopId&periodStart&limit&cursor`

- Filters: `status` one of six, `shopId` uuid, `periodStart` date; `limit` 1–100 (default 20). Keyset `(createdAt DESC, id DESC)`.
- `200 adminPayoutPageSchema`: `{ items: adminPayoutSchema[], nextCursor }`.
- Problems: `400 validation_failed`, `400 invalid_cursor`, `401`, `403`, `429`.

### `GET /finance/payouts/runs?limit&cursor`

- `200 payoutRunPageSchema`: `{ items: { periodStart, status: "RUNNING"|"COMPLETED"|"FAILED", created, existing, skipped: Record<string, number>, failureCode: string|null, startedAt, finishedAt: string|null }[], nextCursor }`, newest period first. Static route declared before `/finance/payouts/:payoutId/cancel`'s sibling params (no clash: different verbs/paths).

### `PUT /finance/shops/:shopId/payout-destination`

- Body (strict) `{ providerAccountId: string }` matching `^acct_[A-Za-z0-9]{8,64}$`.
- `200 { shopId, providerAccountId: masked, status: "ACTIVE", effectiveFrom, changedAt }`. `status` is `ACTIVE` in every case (a cooling destination is still the current one; `effectiveFrom` tells when it starts to count). First destination: `effectiveFrom = changedAt`. Different value: `effectiveFrom = changedAt + 48 h`. Same value: nothing written, the stored `effectiveFrom`/`changedAt` are returned. The full value is stored once and never returned or logged again.
- Problems: `401`, `403 permission_denied`, `404 shop_not_found` (unknown to tenancy), `422 destination_invalid`, `422 idempotency_key_required | idempotency_key_reuse`, `409 idempotency_in_flight`, `429`, `503` (limiter down).
- Note on codes: a body that is not an object / has unknown properties is `400 validation_failed`; a string that fails the account format is **`422 destination_invalid`** (semantic).

### `PUT /finance/shops/:shopId/payout-reserve`

- Body (strict) `{ reserveBps: int 0–5000, reason: string 1–200 }`. `200 { shopId, reserveBps, reason, updatedBy, updatedAt }`; one `PayoutReserveHistory` row per effective change (setting the same value and reason again is a no-op write).
- Problems: `400 validation_failed` (`-1`, `5001`, `12.5`, string, missing, empty/too long reason), `401`, `403`, `404 shop_not_found`, `422 idempotency_*`, `409 idempotency_in_flight`, `429`, `503`.

### `POST /finance/payouts/:payoutId/cancel`

- Body (strict) `{ reason: string 1–200 }`. `200 adminPayoutSchema` (status `CANCELLED`). One transaction: conditional update `WHERE id AND status='PENDING'`, `PAYOUT_REVERSAL` journal, history (actor = admin id, reason), `payout.cancelled` event. The queued `payouts.send` job later finds `CANCELLED` and exits.
- Problems: `400 validation_failed` (malformed id, missing/empty reason), `401`, `403`, `404 payout_not_found`, `409 payout_state_conflict` with `details { status }` (the current internal status; nothing changes), `422 idempotency_*`, `409 idempotency_in_flight`, `429`, `503`.

## Problem registry (`PAYOUT_PROBLEMS`)

| code | status | when |
|---|---|---|
| `validation_failed` | 400 | shared S54 code |
| `invalid_cursor` | 400 | tampered / foreign cursor |
| `permission_denied` | 403 | not admin / lacks `payouts.read` |
| `shop_not_found` | 404 | unknown shop (admin routes) — seller routes get it from `ShopScoped` |
| `payout_not_found` | 404 | no payout with this id (for this shop) |
| `payout_state_conflict` | 409 | cancel of a non-`PENDING` payout; `details {status}` |
| `destination_invalid` | 422 | format |
| `period_invalid` | (job) | run refused: not a Monday, future, malformed, > 52 weeks (a job error, not an HTTP problem; listed for `AS-13`) |
| `idempotency_*`, `rate_limited` | S54 / S50 | |

No new HTTP route outside this list; `GET /shops/:shopId/payouts` is the only route S15 inherits from another capability's removal.

## Rate-limit policies (`rate-limit-policies.ts`)

| Policy | Limit | Key | Fail mode | Owner |
|---|---|---|---|---|
| `finance.payouts.read` | 120 / 60 s sliding | user | open | **S15 (new)** |
| `finance.admin.read` | 120 / 60 s sliding | user | open | S14 (reused) |
| `finance.admin.write` | 30 / 60 s sliding | user | closed | S14 (reused) |
