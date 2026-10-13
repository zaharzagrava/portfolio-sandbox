# HTTP contracts: S14 — `payments` ledger

Schemas live in `packages/contracts/src/payments/ledger.ts` (re-exported from `src/index.ts`); every e2e parses bodies with them (VII.6). All errors are `application/problem+json` with `code` and `requestId` from the S54 filter; the domain registers its problems with `ProblemCatalogModule.forFeature(LEDGER_PROBLEMS)`.

## `GET /shops/:shopId/balance?currency=EUR`

- Guards: `Firewall()` (session), `ShopScoped('payouts.read')`, `@RateLimit('finance.balance.read')`. Controller: parse params with `ParseUUIDPipe` and the query DTO, call `BalanceQueryService.getShopBalance(shopId, currency)`, return `balanceSchema`.
- `200 balanceSchema`: `{ shopId: uuid, currency: "EUR", availableMinor: int (negative allowed), asOf: ISO-8601, source: "read_model" | "ledger" }`.
- Problems: `400 validation_failed` (non-UUID `shopId`, `currency` not `EUR`), `401`, `403 permission_denied`, `404 shop_not_found` (same body for non-member and unknown shop — produced by `ShopScoped`, not by this code), `429 rate_limited` (`Retry-After`).
- Source order: hot copy → durable copy → `AccountBalance` (research R-8). A forced fault in any store never changes the status.
- Removed from this capability: `GET /shops/:shopId/payouts` — `FinanceController.payouts` and the `Payout` import are deleted here; S15 re-creates the route (sibling follow-up in `gaps.md`). Until then it does not exist; the web app does not call it today (checked in WP-0).

## `GET /finance/reconciliation/runs?limit&cursor`

- Guards: `Firewall()`, admin (`role === 'admin'`), `@RateLimit('finance.admin.read')`.
- Query: `limit` int 1–200 (default 50), `cursor` opaque. Keyset `(startedAt DESC, id DESC)`; the cursor is the HMAC-signed base64url of `{t, id}` (secret `LEDGER_CURSOR_SECRET`, ≥ 32 bytes, validated at startup; same codec shape as `payment-cursor.ts`).
- `200 reconciliationRunPageSchema`: `{ items: {id, provider, day, status, providerLines, ledgerJournals, matched, issueCount, skipped, failureCode|null, startedAt, finishedAt|null}[], nextCursor: string|null }`.
- Problems: `400 validation_failed`, `400 invalid_cursor`, `401`, `403 permission_denied`, `429`.

## `GET /finance/reconciliation/issues?status&kind&day&limit&cursor`

- Same guards and cursor rules; policy `finance.admin.read`. Filters: `status` `OPEN|RESOLVED`, `kind` one of the six, `day` `YYYY-MM-DD`. Keyset `(createdAt DESC, id DESC)`.
- `200 reconciliationIssuePageSchema`: items as in the spec (`details` is a bounded object of ids, references and amounts; never a raw provider body).
- Problems as above.

## `POST /finance/reconciliation/issues/:issueId/resolve`

- Guards: `Firewall()`, admin, `@Idempotent()`, `@RateLimit('finance.admin.write')` (fail closed).
- Body `resolveReconciliationIssueRequestSchema` (strict): `{ resolution: "explained"|"adjusted", note: string 1–500, adjustment?: { currency: "EUR", lines: {accountId: string, amountMinor: int ≠ 0}[2–10] } }`. `adjusted` requires `adjustment`; `explained` forbids it.
- `200 reconciliationIssueSchema` (the page item). Header `Idempotency-Replayed: true` on replay.
- Problems: `400 validation_failed` (shape, note length, unknown property, non-UUID id, `currency` ≠ `EUR`), `401`, `403 permission_denied`, `404 reconciliation_issue_not_found`, `409 issue_already_resolved`, `409 idempotency_in_flight` (`Retry-After`), `422 idempotency_key_required | idempotency_key_reuse | adjustment_unbalanced | adjustment_account_invalid | adjustment_too_large`, `429 rate_limited`.
- Order of checks (a bad body never reaches the books): guard → rate limit → idempotency header → body schema → issue lookup (`404`) → state (`409`) → adjustment shape (`422`) → one transaction (conditional update, journal, history, outbox).

## Rate-limit policies (`rate-limit-policies.ts`, registered through `RateLimitModule.forFeature`)

| Policy | Limit | Key | Fail mode |
|---|---|---|---|
| `finance.balance.read` | 120 / 60 s sliding | user | open |
| `finance.admin.read` | 120 / 60 s sliding | user | open |
| `finance.admin.write` | 30 / 60 s sliding | user | closed |

`api/ledger.dto.ts` (the old `CreateLedgerEntryDto`, `SystemAccount`) is deleted; request DTO classes for `ValidationPipe` are thin mirrors of the zod schemas.
