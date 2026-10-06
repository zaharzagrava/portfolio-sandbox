# Questions and decisions: S15 — Seller payouts

Decisions taken unattended under the decision policy (production-grade, notes and constitution first). BREAKING first, then CONTRACT, then LOCAL.

## BREAKING

- [BREAKING] Ineligible shops (no destination, payouts disabled, inactive) → skipped before any money moves, with a named reason; today a payout row and a `PAYOUT` journal are created, and the send step reverses them when the shop has no payout account (`payout.jobs.ts:61-77, 86`) → money must not shuttle through payout clearing for payouts that cannot be sent; 10/02 Ex1 reserves reversal for definite provider failure.
- [BREAKING] Payout states `PENDING | PAID | FAILED` → `PENDING | SENDING | UNKNOWN | PAID | FAILED | CANCELLED` with a claim step and a history table; the `CHECK` on `Payout.status` and the model type change (`payout.model.ts:5`, migration `20261001160000`) → 10/02 Ex1: a timeout is `UNKNOWN`, queried by reference with backoff, never blindly resent; today any non-Stripe-typed error is rethrown with no state, and `err.type !== 'StripeInvalidRequestError'` couples the job to one provider (`payout.jobs.ts:106-108`).
- [BREAKING] Reserve introduced: payout = balance − reserve (default 10%, per-shop override 0–50%, rounded up); today the whole balance is paid and `finance.e2e-spec.ts:114-118` expects `5000` transferred for a `5000` balance → SD-20 "payout = sum of available balance after reserve"; update that test to `4500`.
- [BREAKING] `GET /shops/:shopId/payouts` returns the ORM model array, newest 52, unpaged (`finance.controller.ts:35-39`) → explicit `payoutSchema` DTO in a keyset page (default 20, max 100, `invalid_cursor`), public statuses with `IN_TRANSIT`, no destination or raw failure text → V.1, V.6, III.10, least exposure; the S14 spec already removed the route from the ledger.
- [BREAKING] Money field `Payout.amount` and `failureReason` free text → `amountMinor`, `reserveHeldMinor`, `failureCode` plus a sanitized reason of at most 200 characters; expand/contract migration with the old column readable until callers move → money naming used by S10/S13/S14, III.11.
- [BREAKING] Balances found by raw `SUM(amount)` over `LedgerEntry` with `LIKE 'SHOP\_%'` (`payout.jobs.ts:52-56`) → S14 `listSellerBalances` and `getBalances`, batched (≤ 200 per page) → notes: "balance page never sums entries", and S14 owns the ledger tables' access.
- [BREAKING] Journals posted through `LedgerService.post({journalId, kind, lines})` with `deriveJournalId` UUIDv5 helpers (`payout.jobs.ts:70, 98, 117, 138-141`) → S14 `postJournal({kind, reference, currency, lines})`, once per `(kind, reference)`: `(PAYOUT, id)`, `(PAYOUT, id:sent)`, `(PAYOUT_REVERSAL, id)`; the non-negative guard is S14's atomic one → III.6; `deriveJournalId` and the namespace constant are deleted.
- [BREAKING] The payout destination is read from `Shop.stripeAccountId` through `ShopModel` (`payout.jobs.ts:83-90`) → S15 owns `PayoutDestination`; migration copies the column; tenancy drops it afterwards; the seller sees nothing of it → IX.4 (D-7), S03/S14 CONTRACT lines; destination snapshot stored on each payout.
- [BREAKING] `Payout.shopId REFERENCES "Shop"` (migration `20261001160000:108`) → plain ID column, no foreign key → IX.4.
- [BREAKING] Barrel exports `PayoutModel`; modules `FinanceModule` / `FinanceWorkerModule` mix payouts with the ledger (`index.ts:9-11`) → `PayoutsModule` and `PayoutsWorkerModule` only; no model, no provider port → X.4, D-7/D-8.
- [BREAKING] Provider classification by error shape and no timeout (`payout-provider.port.ts`, `stripe.service.ts:222-229`) → the port returns a typed outcome (`success | rejected{code} | transient | unknown`), validates the answer (amount, currency, destination, reference), 10 s timeout, no retry inside the adapter; retries only in the job layer, 5 attempts, backoff with full jitter → IV.6, IV.8.
- [BREAKING] The send job swallows a failed outcome by marking the payout `FAILED` and reversing, with no check of what the provider might already have done (`payout.jobs.ts:105-126`) → rejected is final only for definite provider codes; everything else is retried or `UNKNOWN`.
- [BREAKING] New operator surface: destination, reserve and cancel with mandatory `Idempotency-Key`, admin only, cooling period 48 h after a destination change → fraud control (redirecting a seller's money), P0414; there is no write endpoint today.
- [BREAKING] The weekly run accepts any `periodStart` string (`payout.jobs.ts:50-51`) → must be a Monday, not future, ≤ 52 weeks old, else `period_invalid`.
- [BREAKING] `payouts.run-weekly` has no run record or summary → `PayoutRun` per period with counts and skip reasons, listed by `GET /finance/payouts/runs`.

## CONTRACT

- [CONTRACT] S14 `postJournal` kinds → S15 uses `PAYOUT` for both the creation (seller → clearing) and the sent step (clearing → payouts sent, reference `<payoutId>:sent`) and `PAYOUT_REVERSAL` for failure and cancel → S14's FR-009 refuses only `PAYOUT` debits of seller accounts that overdraw and protects `PAYOUT_CLEARING`; the sent step debits `PAYOUT_CLEARING` which is always funded by the creation journal.
- [CONTRACT] S14 `listSellerBalances({currency, minMinor, limit ≤ 200, after})` → S15 passes `minMinor = minimum payout` (a superset: the reserve is applied afterwards) and re-reads the authoritative balance with `getBalances` per batch inside the creation step → the listing is an index, the decision uses the exact balance.
- [CONTRACT] S14 removes `GET /shops/:shopId/payouts` and the `Payout` model/barrel exports; S15 takes the route with the same path and a new body → one owner per route.
- [CONTRACT] S03 `ShopQueryService.getShopsByIds` → S15 needs `status` and `payoutsEnabled` only, ≤ 200 IDs per call; an ID missing from the map means `shop_unknown` → no cross-domain read of `Shop`.
- [CONTRACT] S03 drops `Shop.stripeAccountId` after S15's migration copies it (S03 questions.md line 42 already says so) → S15 owns the payout destination.
- [CONTRACT] S03 permission matrix → seller routes use `payouts.read`; S03's FR-020 says owner and admin only while the current code grants it to the viewer role too (`permissions.ts:33`) → S15 relies on S03's matrix, not its own list.
- [CONTRACT] S04's open question (IBAN for payouts) → S15 needs only the payment-provider account ID, set by an operator; no export of sealed values is needed → least exposure of PII; closes S04's CONTRACT line.
- [CONTRACT] S49 → needs `enqueue` callable inside the caller's transaction with an idempotency key, attempt number and attempt limit in the handler, retry backoff with jitter, delayed `runAt`, cooperative stop → the creation step must enqueue atomically with the payout row (III.3: no publish inside a transaction).
- [CONTRACT] S53 / events → a new topic `payouts.events` keyed by `payoutId` (S13 uses `payments.events`, S14 `ledger.events`) → payouts have their own consumers (S28, S16, J01) and ordering key; every payload has `payoutVersion`.
- [CONTRACT] S54 idempotency facility → retention 24 h, per-principal scope, header `Idempotency-Replayed`, a validation failure does not consume the key → pattern P0414 (replay, in-flight 409, different-body 422, TTL).
- [CONTRACT] S50 → policies `finance.payouts.read` 120/min fail open, `finance.admin.read` 120/min fail open, `finance.admin.write` 30/min fail closed (the last two are S14's).
- [CONTRACT] S16 (statements) and S28 (notifications) → consume `payout.paid`, `payout.failed`, `payout.in_doubt`, `payout.discrepancy_detected`; neither reads our tables → R3.
- [CONTRACT] S13 / S14 provider reconciliation skips `transfer`, `payout`, `payout_reversal` lines (S14 questions line 54) → S15's daily audit checks payouts by looking up each transfer by reference; S14 stays out of it.
- [CONTRACT] W04 / J01 → the seller screens call `GET /shops/:shopId/payouts` and `.../payouts/upcoming`; J01 proves order paid → settlement → payout `PAID` → statement.

## LOCAL

- [LOCAL] Reserve rounding → round up (favours the platform), integer `BigInt` math → exact for balances up to 2^53.
- [LOCAL] Cap per payout 5,000,000 minor → the rest rolls to next week; limits blast radius of a bug or compromise.
- [LOCAL] Minimum payout 1000 minor, applied before and after the reserve → matches today's `MIN_PAYOUT_MINOR`.
- [LOCAL] Reserve is a percentage of the balance at each run, no separate release schedule → simplest rule that tests exactly; a rolling-window reserve is a later change.
- [LOCAL] Failed or cancelled payouts are not retried in the same week (unique shop+week) → the next run pays; avoids a retry loop on a bad destination.
- [LOCAL] Provider unreachable never means `FAILED`; 24 h in doubt raises `payout.in_doubt` and stops → a human decides, the code never guesses with money.
- [LOCAL] Resolver delays 1, 2, 4 … 15 min with full jitter; re-send at most 3 times with the same key; stale `SENDING` threshold 5 min → same shape as S13's resolver.
- [LOCAL] Job retries 5 with backoff and jitter, then `UNKNOWN` → exactly one retry layer.
- [LOCAL] Provider lookup by reference is by payout ID (transfer group / metadata at the provider) → needed by the resolver and the audit; adapter detail.
- [LOCAL] Public status `IN_TRANSIT` for `SENDING` and `UNKNOWN` → the seller need not see internal doubt.
- [LOCAL] Destination masked as first 5 and last 3 characters → enough for support to recognise it.
- [LOCAL] Cooling period only when an existing destination changes to a different value → a first destination is set by an operator who has just verified it.
- [LOCAL] Run record per period, updated by re-executions → one row per week keeps the list short.
- [LOCAL] History table `PayoutHistory` → III.7 requires a history row per transition.
- [LOCAL] No row-level tenant security on payout tables → access control is by predicate (III.4); S03's tenant-context mechanism is not applied to these payments-owned tables.
- [LOCAL] Currency fixed to `EUR`, one payout per shop per currency per week is future work → single currency platform.
- [LOCAL] Audit looks only at the previous UTC day's `PAID` payouts → bounded work, idempotent per day.
- [LOCAL] Weekly run time and zone unchanged (Monday 06:00 `Europe/Warsaw`) → today's schedule, correct under S49's tz-aware cron.
