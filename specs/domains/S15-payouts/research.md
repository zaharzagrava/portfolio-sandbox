# Research: S15 — Seller Payouts

No `NEEDS CLARIFICATION` remains: the spec and `questions.md` fix the behaviour; this file records the design decisions that the code reading and the toolkit force. Each entry: decision, rationale, alternatives.

## R-1 Module layout and what leaves `LedgerWorkerModule`

- **Decision**: new `PayoutsModule` (HTTP, imports `LedgerModule` for `LedgerService`, `RateLimitModule.forFeature(paymentsRatePolicies)` already registered by `PaymentModule`, tenancy's `ShopBatchReadModule`) and `PayoutsWorkerModule` (jobs, provider adapter, `StripeModule`, `EventsModule.forAggregates([PAYOUTS_AGGREGATE])`). `LedgerWorkerModule` drops `Payout`, `PayoutJobs`, `PayoutProvider`. The barrel exports the two modules; nothing else of S15.
- **Rationale**: B9 (payouts mixed into ledger modules); the S14 note says the payout code "stays in this domain and is registered in `LedgerWorkerModule`" only *until* S15. Two modules mirror S14's core/worker split.
- **Alternatives**: keep payouts in `LedgerWorkerModule` — leaves `Payout` registration beside ledger models and blocks the ownership gate (rejected).

## R-2 The atomic creation step and the authoritative balance

- **Decision**: per shop, inside one `TransactionRunner.run`: `getBalances({accountIds:[shopAccount], currency}, tx)` → pure `computePayout(balance, bps, cap, min)` → `INSERT … ON CONFLICT ("shopId","periodStart") DO NOTHING RETURNING id` (none → counted `existing`, stop) → `postJournal(PAYOUT, id, …, tx)` → history row → outbox `payout.created` → `jobs.enqueue('payouts.send', {payoutId}, {idempotencyKey:'payout-send:'+id, shopId})`. The page-level batched `getBalances` (≤ 200 ids, no tx) is a **prefilter only** (a shop whose authoritative balance already fell under the minimum is skipped without a transaction); the decision always uses the in-transaction read.
- **Rationale**: AS-10 (decide on the authoritative balance), AS-12 (reads batched), AS-16 (one atomic step). Concurrent runs: the second insert blocks on the unique index until the first commits, then returns no row; the journal's `(kind, reference)` uniqueness is a second line of defence. An overdraw between the read and the posting is caught by S14's atomic guard (`InsufficientBalance`) → rollback → skip `insufficient_balance`.
- **Alternatives**: lock the seller balance row `FOR UPDATE` before reading — takes a lock that the posting needs anyway and deadlocks against ad billing's lock order (S14 lock order is inside `postJournal`) (rejected). Trust the listing balance — fails AS-10 (rejected).

## R-3 Claim, attempt fencing and the retry boundary

- **Decision**: `Payout.attempts` counts provider-call attempts and is fenced by the S49 job attempt. The transfer handler receives `ctx.attempt` (incremented by the claim SQL on every delivery, including after a lease-reaped crash: `job-claim.sql.ts:184`, `job-reaper.service.ts:16`):
  1. `PENDING` → `UPDATE … SET status='SENDING', attempts=:attempt, payoutVersion=payoutVersion+1, submittedAt=now WHERE id AND status='PENDING'` (one row) + history; commit. Winner proceeds.
  2. `SENDING` → `UPDATE … SET attempts=:attempt WHERE id AND status='SENDING' AND attempts < :attempt` (one row) → winner proceeds (a redelivery after a crash or transient failure); zero rows → another delivery of the same attempt (or an older one) holds it: finish without calling the provider.
  3. Any other status → finish (cancelled, paid, failed, unknown: `UNKNOWN` belongs to the resolver).
  Then the provider call (no transaction), then the result transaction.
- **Transient answer** (`429`, `502`, `503`, `504`, reset): the handler throws `TransientPayoutError` → S49 retries with its backoff + full jitter up to `maxAttempts: 5`; on `ctx.isLastAttempt` the handler instead transitions `SENDING → UNKNOWN` (`retries_exhausted`) and returns (no throw), so the payout never sits `SENDING` after the last attempt. Same key on every attempt (`idempotencyKey = payoutId`).
- **Timeout / garbage / mismatch**: `SENDING → UNKNOWN` at once (`provider_unknown`); mismatch also emits `payout.discrepancy_detected` and increments `payout_provider_mismatch_total{kind}` (AS-25).
- **Definite rejection**: `SENDING → FAILED` + `PAYOUT_REVERSAL` + `payout.failed`, never retried (AS-23).
- **Rationale**: AS-18 demands exactly one provider call under 10 concurrent deliveries, AS-19 demands a redelivered job to call the provider again with the same key while the payout is `SENDING`. A pure status check cannot tell the two; the attempt fence can, using only the job layer's own counter. The test harness delivers the "same message twice" by passing the same `ctx.attempt` (duplicates) or `attempt + 1` (a real redelivery).
- **Alternatives**: a `lockedBy`/lease column on the payout — a second lease system beside S49's (rejected). Let `SENDING` redeliveries always call the provider — the provider key makes it safe for money but violates AS-18 "others finish without calling the provider" (rejected).
- **CT-1**: two layers wait (job layer for transient, resolver for unknown). They never act on the same state; documented in the plan.

## R-4 Result transaction and the sent journal

- **Decision**: `PAID`: one `TransactionRunner.run`: conditional update `SENDING|UNKNOWN → PAID` (sets `transferRef`, `paidAt`, version+1) asserting one row → history → `postJournal(PAYOUT, '<id>:sent', clearing → sent, tx)` → outbox `payout.paid`. If the conditional update touches zero rows the whole step is a no-op (the other path won: AS-30), and when the stored status is the *opposite* final state the late outcome is counted `payout_conflicting_outcome_total` and one `payout.discrepancy_detected{kind:conflicting_outcome}` is emitted (guarded by a `discrepancyReportedAt` column so it is emitted once: AS-28). `FAILED` and `CANCELLED` symmetric with `PAYOUT_REVERSAL` reference `<id>`.
- **Rationale**: FR-021, FR-024, FR-025; S14 uniqueness of `(kind, reference)` makes a double post impossible even if the conditional update were bypassed.

## R-5 Resolver

- **Decision**: job `payouts.resolve-in-doubt`, schedule `* * * * *` UTC (every minute), `fleetConcurrency: 1`, `maxAttempts: 3`. Each run selects at most 50 payouts that are `UNKNOWN`, or `SENDING` with `updatedAt < now − 5 min`, and `nextResolveAt <= now`, ordered by `nextResolveAt`, by keyset. For each: lookup by reference (outside any transaction). `found(paid, matching)` → `PAID` path of R-4; `found(rejected)` → `FAILED`; `found(reversed)` is not a resolver case (audit's); `not_found` → re-send with the same key while `resendCount < 3` (stored column), spacing by the pure backoff; `unreachable` → leave state, schedule `nextResolveAt = now + backoff(unreachableCount)` (1, 2, 4 … 15 min, full jitter). The in-doubt event is emitted once when `now − inDoubtSince ≥ 24 h`, guarded by `inDoubtEventAt IS NULL` set in the same transaction (a conditional update, not a state change).
- **Rationale**: FR-018, FR-022. The next-look time is stored (not computed from memory) so a restart or a second replica behaves the same.
- **Alternatives**: a delayed job per payout — one more row per payout and cancel/ordering issues with S49 (rejected); polling every minute with a stored `nextResolveAt` is bounded and simple.

## R-6 Provider adapter

- **Decision**: port `PayoutProviderPort` in `domain/`: `transfer(request): Promise<TransferOutcome>`; `lookup(reference): Promise<LookupOutcome>`. Outcomes are discriminated unions: `{kind:'success', answer}`, `{kind:'rejected', code}`, `{kind:'transient', status}`, `{kind:'unknown'}`; lookup `{kind:'found', transfer, reversed}`, `{kind:'not_found'}`, `{kind:'unreachable'}`. The Stripe adapter calls `StripeService.createTransfer({amountMinor, currency, destination, idempotencyKey, reference}, {timeoutMs, maxNetworkRetries: 0})` and sets `transfer_group = payoutId` and `metadata.payoutId`; lookup lists `transfers` filtered by `transfer_group = payoutId` (limit 2; two or more distinct transfers for one reference is an `unknown`-class alarm: `payout_provider_mismatch_total{kind:'duplicate_transfer'}`). It classifies by Stripe error `type`/`code`/`statusCode` into the outcomes (rejection codes: `account_closed`, `invalid_destination`, `insufficient_platform_funds` → `rejected`; 429/502/503/504/connection reset → `transient`; timeout → `unknown`; anything else unclassifiable → `unknown`, never `rejected`). The raw answer is parsed by the pure `validateProviderAnswer(expected, answer)` (amount, currency, destination, non-empty `transferRef`, shape via zod) before it can become `success`. The load-test branch in `stripe.service.ts` (`transfer` returning a fake id) stays for load tests but is selected by configuration, not by the adapter.
- **Rationale**: FR-014…FR-020, IV.8; the existing `err.type === 'StripeInvalidRequestError'` coupling is deleted.
- **Alternatives**: classify in the job — couples the job to one provider (rejected, A10).
- **Probe (WP-0)**: confirm the SDK exposes `transfers.list({transfer_group})`; if not, use `transfers.search`/metadata; the port does not change.

## R-7 Reserve arithmetic

- **Decision**: `reserve = ceil(balance × bps / 10000)` computed as `(B * BigInt(bps) + 9999n) / 10000n` in BigInt, converted with a safe-integer assertion; `payout = balance − reserve`; cap applied after the reserve; `reserveHeldMinor` records the reserve of the run (0 when the cap alone limits, per AS-07 the cap is not a reserve). Minimum is checked on the balance **before** the reserve (listing, `minMinor`) and on the payout **after** (`below_minimum`). Property: `reserve + payout = balance`, `0 ≤ reserve ≤ balance` for balance in `[0, 2^53)` and bps in `[0, 5000]`.
- **Rationale**: FR-011, AS-04; `(9007199254740000, 1000)` needs BigInt (the product exceeds 2^53).

## R-8 Destination table, cooling and `ProviderAccount`

- **Decision**: `PayoutDestination {shopId PK, providerAccountId, effectiveFrom, changedAt, changedBy, version}`. A change to a different value overwrites `providerAccountId`, sets `effectiveFrom = changedAt + cooling` and bumps `version`; the run treats the shop as eligible only when `now ≥ effectiveFrom`, otherwise it skips `destination_cooling` (AS-39: the shop is skipped during cooling, it is **not** paid to the old account — that also closes a fraud path). A first destination is effective at once; the same value changes nothing. History in `PayoutDestinationHistory` (append-only, masked values only). The payout stores the full id in `destinationSnapshot` (needed for the transfer); it is masked everywhere else.
- **Rationale**: FR-028…FR-030; AS-38/39. Skipping during cooling (rather than paying the old account) is exactly what the spec states and removes a fraud path (an attacker changing the account cannot divert the next run, and a legitimate change delays one run at most).
- **`ProviderAccount` (S14)**: kept read-only as the migration source; superseded; dropped in the contract file. S14's note "S15 writes `ProviderAccount`" is overridden by spec FR-028 (own table, cooling, history).
- **Storage of the full id**: plain text column in a payments table; no encryption at rest beyond the platform's database encryption (the id is an opaque provider identifier, not a credential; masked in all outputs and logs). Recorded as an assumption; if a later review wants envelope encryption it is a column swap.

## R-9 Journal references and legacy payouts

- **Decision**: new references `<payoutId>` (create), `<payoutId>:sent`, `<payoutId>` (reversal, kind `PAYOUT_REVERSAL`). Legacy journals use `payout:<id>`, `payout-sent:<id>`, `payout-reversal:<id>`. Legacy `PENDING` payouts at migration time already have the `payout:<id>` creation journal; their later sent/reversal journals use the *new* references (no collision, no double). Legacy `PAID`/`FAILED` payouts are final.
- **Rationale**: spec FR-027 fixes the new references; legacy payouts are few and their only in-flight leg is the send.
- **Risk**: a legacy `PENDING` payout cancelled by an operator posts a `PAYOUT_REVERSAL` with reference `<id>` against a creation journal with a legacy reference: balances are correct (the lines are what matter). Covered by the AS-53 case "legacy pending payout is sent and cancelled".

## R-10 Events

- **Decision**: six `defineEvent`s over zod schemas in `packages/contracts/src/payments/payout-events.ts`, aggregate `payoutId`, topic `payouts.events`; appended by `PayoutTransitionService` (and by the audit/resolver for the two non-transition events) with `OutboxService.append(event, tx)`; `payoutVersion` is the row's version after the update. Versions are monotone but not contiguous (a `SENDING` claim bumps the version without an event) — consumers discard `≤ last seen`, never expect `+1`.
- **Superset check**: S43's `webhookPayoutEventSchemas` is `looseObject` (extra fields allowed) and S28's `payoutConsumedSchemas` is `z.object` (strict on the declared fields — extra keys are stripped, not rejected, in zod 4 `object`); a contract spec in WP-1 parses all six payload fixtures with both, proving compatibility without editing either file.

## R-11 Jobs and schedule bootstrap

- **Decision**: four `declareJobType` with zod contracts: `payouts.run-weekly {periodStart?: YYYY-MM-DD}` (`maxAttempts: 3`), `payouts.send {payoutId: uuid}` (`maxAttempts: 5`), `payouts.resolve-in-doubt {}` (`maxAttempts: 3`), `payouts.audit-daily {day?: YYYY-MM-DD}` (`maxAttempts: 3`). Schedules: run `0 6 * * 1` `Europe/Warsaw`; resolver `* * * * *` UTC; audit `20 3 * * *` UTC (after S14's reconciliation at 02:30). The existing `upsertLedgerSchedule` helper in `infra/schedule-bootstrap.ts` (S14) already catches `InvalidScheduleError`; S15 calls it with its own job types. A malformed `periodStart` in the payload fails the contract at enqueue; an explicit period that is syntactically valid but not a Monday / future / > 52 weeks is `period_invalid`: the run handler records nothing, throws `NonRetryableJobError('period_invalid')` (the job goes dead, no retry), and the same check is exposed as a service result for tests.
- **Rationale**: S49 follow-up; FR-001; FR-050.
- **Alternatives**: schedule the resolver per payout — rejected in R-5.

## R-12 Access control and sibling rules

- **Seller routes**: `@ShopScoped('payouts.read')` (non-member `404 shop_not_found`, no permission `403`; VIEWER excluded by S03's matrix), `@RateLimit('finance.payouts.read')`, no `Idempotency-Key`, `GET` only.
- **Operator routes**: S14's `AdminOnly` decorator (`Firewall()` + role guard, `403 permission_denied`) is the reuse point; for the three writes the S01 rule applies: mark them `Firewall({ sensitive: true })`. WP-0 reads `identity` to see whether `AdminOnly` already offers the option; if not, the payout controller composes `Firewall({ sensitive: true })` with the role guard locally (the guard class is exported from S14's file only through a tiny `AdminOnly({ sensitive })` parameter added **in this domain** — same owner — not in identity).
- **`ShopScoped` closed-shop answers** (`403 shop_suspended`, `409 shop_offboarding`) apply to write permissions of shop-scoped routes; S15 has no shop-scoped write, so they are never produced, and the retest is "a suspended shop's member still reads their payouts" (a row in AS-34).
- **Admin shop lookup**: destination and reserve routes check that the shop exists with `getShopsByIds([id])` (`404 shop_not_found`).

## R-13 Pool arithmetic

- The provider call holds no connection, so `payouts.send` concurrency does not scale connection demand with provider latency: connections held = handlers currently inside a ≈ 10 ms claim or result transaction, which the pool queue absorbs. Handler concurrency for `payouts.send` is **8** (below P = 10); the spec's "10 deliveries at once" test drives the service directly, not through the worker's concurrency. The run holds one connection per shop step; the resolver processes at most 50 payouts per run, sequentially, with lookups outside transactions.

## R-14 Configuration (AS-54)

- **Decision**: `libs/common/config/payout-config.ts` in the style of `ledger-config.ts` (joi keys with defaults): `PAYOUT_DEFAULT_RESERVE_BPS` 1000 (0–5000), `PAYOUT_MIN_MINOR` 1000 (≥ 1), `PAYOUT_CAP_MINOR` 5000000 (≥ min), `PAYOUT_DESTINATION_COOLING_HOURS` 48 (≥ 0), `PAYOUT_PROVIDER_TIMEOUT_MS` 10000 (≥ 1), `PAYOUT_SEND_MAX_ATTEMPTS` 5 (1–10), `PAYOUT_RESOLVER_MAX_RESENDS` 3 (0–10), `PAYOUT_STALE_SENDING_MS` 300000, `PAYOUT_IN_DOUBT_AFTER_HOURS` 24, `PAYOUT_CURSOR_SECRET` falls back to the ledger cursor secret rule (≥ 32 bytes, not the session secret). The provider credential is the existing `stripe_secret_key` (required by the base config); the cross-key rule `cap ≥ min` is a `ConfigRules` check. Messages name the key and the rule, never a value of a secret.
- **Rationale**: FR-048, VIII.5.

## R-15 Rate limits

- New policy `finance.payouts.read` 120/min per user, fail open, added to `paymentsRatePolicies`; `finance.admin.read` and `finance.admin.write` already exist (S14). AS-48: with the limiter store down, `finance.admin.write` fails closed → `503` before the handler runs.

## R-16 What S15 does not do

No consumer (S28/S16/S43 consume), no UI, no tenancy column drop, no edit of S14's specs beyond the moved import in two S14-owned spec files (reported as a sibling follow-up), no `*.reviewed.json`.
