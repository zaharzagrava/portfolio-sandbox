---
id: S15
title: Seller payouts - weekly run, reserves, provider transfer with idempotency, payout states
kind: capability
status: draft
generated_at: 471c6555
depends_on: [S01, S03, S13, S14, S28, S43, S49, S50, S53, S54]
concepts: [outbox-task-queue, transaction-runner, idempotency-key, rate-limit-policy, job-scheduler-lease, problem-json-errors]
models: []
scope:
  - packages/backend/libs/domains/payments/**/payout*
  - packages/backend/libs/domains/payments/payouts*
  - packages/contracts/src/payments/payout*
---
# S15 - Seller payouts - weekly run, reserves, provider transfer with idempotency, payout states

## Purpose
Every Monday the platform pays each eligible seller what the ledger says it owes, minus a reserve, exactly once. A payout is created atomically with its journal, job and event, sent to the payment provider with the payout id as the idempotency key, and moves through a closed set of states; an answer that never came is looked up by reference, never guessed and never sent blindly. Sellers read their payouts and the next one; operators set destinations and reserves and can stop a payout in time. See {{concept:transaction-runner}}, {{concept:outbox-task-queue}} and {{concept:idempotency-key}}.

## Entry points
- Job `payouts.run-weekly` (Monday 06:00 `Europe/Warsaw`), `payouts.send`, `payouts.resolve-in-doubt` (every minute), `payouts.audit-daily` ({{concept:job-scheduler-lease}}). [code: packages/backend/libs/domains/payments/infra/payout.jobs.ts#PayoutJobs]
- `GET /shops/:shopId/payouts`, `GET /shops/:shopId/payouts/upcoming`, `GET /shops/:shopId/payouts/:payoutId`: a member with `payouts.read` reads their shop's payouts. [code: packages/backend/libs/domains/payments/api/payouts.controller.ts#PayoutsController]
- `GET /finance/payouts`, `GET /finance/payouts/runs`, `PUT /finance/shops/:shopId/payout-destination`, `PUT /finance/shops/:shopId/payout-reserve`, `POST /finance/payouts/:payoutId/cancel`: the finance operator API (platform `admin` only). [code: packages/backend/libs/domains/payments/api/payouts-admin.controller.ts#PayoutsAdminController]
- Topic `payouts.events`: `payout.created`, `payout.paid`, `payout.failed`, `payout.cancelled`, `payout.in_doubt`, `payout.discrepancy_detected`. [code: packages/backend/libs/domains/payments/application/events/payout-events.ts#payoutEvents]

## Rules
- **S15.R-01** The run's period MUST be a real Monday, not after the current week and not older than 52 weeks; any other period is refused with `period_invalid` and nothing is created. The schedule is one row at `0 6 * * 1` `Europe/Warsaw`, registered idempotently, and a payload that breaks the job contract is refused at enqueue. [proof: S15 AS-13, S15 AS-14] [code: packages/backend/libs/domains/payments/domain/period.ts#validatePeriod]
- **S15.R-02** A shop has at most one payout per period. Its row, `PAYOUT` journal, history row, `payout.created` and send job are written in ONE transaction, so a failure at any of them leaves none, and no provider call is made in it. Concurrent and repeated runs create each payout once. [proof: S15 AS-01, S15 AS-02, S15 AS-03, S15 AS-16] [code: packages/backend/libs/domains/payments/application/payout-creation.service.ts#PayoutCreationService]
- **S15.R-03** The payout is the authoritative balance minus a reserve of `ceil(balance x bps / 10000)` (platform default 10%, per-shop override 0 to 50%), computed in `BigInt`; the minimum (1000) applies to the balance and again after the reserve, inclusive; the cap (5,000,000) limits one payout, is not a reserve, and the rest rolls to the next week; zero, negative and under-minimum balances create nothing and are not counted as skips. [proof: S15 AS-04, S15 AS-05, S15 AS-06, S15 AS-07, S15 AS-08] [code: packages/backend/libs/domains/payments/domain/reserve.ts#planPayout]
- **S15.R-04** A shop is skipped with a named reason, before any money moves, when it is unknown to tenancy, not `ACTIVE`, has payouts disabled, has no destination or has a destination still cooling; the reasons are counted per run and logged. [proof: S15 AS-09] [code: packages/backend/libs/domains/payments/domain/eligibility.ts#assessEligibility]
- **S15.R-05** The payout is decided on the balance read inside the creation transaction; a charge that lands between the read and the posting is refused by the ledger, rolls the step back and skips only that shop (`insufficient_balance`, `ledger_busy`); a failing balance listing fails the run as `ledger_unavailable` with nothing created. [proof: S15 AS-10, S15 AS-11]
- **S15.R-06** The run pages sellers by keyset (200), reads tenancy, destinations and reserves in batches per page, isolates one shop's failure from the others, stops between shops on the job's signal or the shutdown registry (`FAILED interrupted`), and resumes without duplicating. [proof: S15 AS-12, S15 AS-15, S15 AS-55] [code: packages/backend/libs/domains/payments/application/payout-run.service.ts#PayoutRunService]
- **S15.R-07** A payout is `PENDING`, `SENDING`, `UNKNOWN`, `PAID`, `FAILED` or `CANCELLED`; exactly twelve (state, event) pairs are allowed and the three final states accept nothing; every change is a conditional update that bumps `payoutVersion`, writes a history row and its event in the same transaction. [proof: S15 AS-27] [code: packages/backend/libs/domains/payments/domain/payout-state.ts#transition]
- **S15.R-08** A send claims `PENDING -> SENDING` in a committed conditional update fenced by the job attempt, calls the provider with NO transaction open, then settles in a separate transaction; ten simultaneous deliveries give one claim, one provider transfer, one `PAID`, one journal and one event. [proof: S15 AS-17, S15 AS-18, S15 AS-29] [code: packages/backend/libs/domains/payments/application/payout-transfer.service.ts#PayoutTransferService]
- **S15.R-09** The provider is called with the payout id as idempotency key on every attempt and with the destination snapshot taken at creation, so a redelivery after a crash gets the same transfer and a later destination change redirects nothing. [proof: S15 AS-19, S15 AS-26]
- **S15.R-10** A timeout, an unreadable answer or a mismatch leaves `UNKNOWN`, never `FAILED`; the resolver looks the transfer up by reference (found: `PAID`; rejected: `FAILED`; unknown to the provider: the same-key re-send, at most three; unreachable: nothing changes and the next look is later with full jitter) and raises one `payout.in_doubt` after 24 hours. [proof: S15 AS-20, S15 AS-21, S15 AS-22] [code: packages/backend/libs/domains/payments/application/payout-resolver.service.ts#PayoutResolverService]
- **S15.R-11** A definite rejection makes the payout `FAILED` with a sanitized reason, returns the money by a `PAYOUT_REVERSAL` journal and is never retried; a transient answer (`429`, `502`, `503`, `504`, reset) is retried with the same key up to 5 attempts and then leaves `UNKNOWN`; the adapter makes one call per attempt. [proof: S15 AS-23, S15 AS-24]
- **S15.R-12** The provider's answer is data to check: amount, currency, destination and a non-empty reference must match the request; anything else is `UNKNOWN` with a mismatch count and a discrepancy event, and posts nothing. [proof: S15 AS-25] [code: packages/backend/libs/domains/payments/domain/provider-answer.ts#validateProviderAnswer]
- **S15.R-13** A late outcome that contradicts a final payout changes nothing, is counted and reported once; the job and the resolver both finishing the same payout give one `PAID`, one journal and one event. [proof: S15 AS-28, S15 AS-30]
- **S15.R-14** The books follow the state: creation posts seller to `PAYOUT_CLEARING` (`PAYOUT`, `<id>`), `PAID` posts `PAYOUT_CLEARING` to `PAYOUTS_SENT` (`PAYOUT`, `<id>:sent`), `FAILED` and `CANCELLED` post the reversal (`PAYOUT_REVERSAL`, `<id>`); `PAYOUT_CLEARING` always equals the payouts that are `PENDING`, `SENDING` or `UNKNOWN`. [proof: S15 AS-17, S15 AS-23, S15 AS-42]
- **S15.R-15** A member with `payouts.read` lists their shop's payouts newest first by keyset with a signed cursor, reads one with its timeline, and sees the upcoming payout computed with the same functions as the run; bodies carry public statuses (`SENDING` and `UNKNOWN` show as `IN_TRANSIT`) and never a destination, attempt count or raw failure text; another shop's payout and an unknown one answer identically; reads are limited to 120 a minute and fail open. [proof: S15 AS-31, S15 AS-32, S15 AS-33, S15 AS-34, S15 AS-35, S15 AS-36]
- **S15.R-16** An operator sets a shop's destination (`acct_` plus 8 to 64 alphanumerics): a first destination counts at once, a different one after 48 hours (the shop is skipped meanwhile, not paid to the old account), the same value writes nothing; the full value is stored once and returned only masked. [proof: S15 AS-38, S15 AS-39] [code: packages/backend/libs/domains/payments/domain/destination.ts#effectiveFromFor]
- **S15.R-17** An operator sets a shop's reserve in basis points (0 to 5000) with a reason; every effective change has a history row and applies only to payouts created afterwards. [proof: S15 AS-40] [code: packages/backend/libs/domains/payments/application/payout-reserve.service.ts#PayoutReserveService]
- **S15.R-18** The three operator writes require `Idempotency-Key` (replay, in-flight `409`, other body `422`, missing `422`, a refused body does not use the key, retention 24 hours), a non-revoked session, and are limited to 30 a minute and fail closed. [proof: S15 AS-41, S15 AS-48]
- **S15.R-19** Only a `PENDING` payout can be cancelled; cancel and send are exclusive through the same conditional update, so exactly one wins; cancel posts the reversal, records actor and reason and emits `payout.cancelled`; any other state answers `409 payout_state_conflict` with the state and changes nothing. [proof: S15 AS-42, S15 AS-43, S15 AS-44, S15 AS-45] [code: packages/backend/libs/domains/payments/application/payout-cancel.service.ts#PayoutCancelService]
- **S15.R-20** The operator lists payouts (filters, keyset, internal statuses, masked destination) and the run records newest first; both are for the platform admin only. [proof: S15 AS-46, S15 AS-47] [code: packages/backend/libs/domains/payments/application/payout-query.service.ts#PayoutQueryService]
- **S15.R-21** A daily audit looks up every payout paid on the previous closed UTC day by reference and records each difference (`amount`, `currency`, `destination`, `missing_transfer`, `reversed_at_provider`) once as a finding, a metric and an event; it changes no payout; a provider outage fails the day without partial output. [proof: S15 AS-49] [code: packages/backend/libs/domains/payments/application/payout-audit.service.ts#PayoutAuditService]
- **S15.R-22** Every lifecycle event is appended to the outbox in the transition's own transaction, parses with the schemas in `packages/contracts` shared with the consumers, and carries no destination or secret. [proof: S15 AS-50] [code: packages/backend/libs/domains/payments/application/payout-transition.service.ts#PayoutTransitionService]
- **S15.R-23** Payout metrics move by the stated amounts with closed-set labels, and logs carry ids, amounts and codes only. [proof: S15 AS-51]
- **S15.R-24** The payout tables are owned by payments with no foreign key and no foreign model; the public entry point exports `PayoutsModule` and `PayoutsWorkerModule` only; each module starts on its own. [proof: S15 AS-52] [code: packages/backend/libs/domains/payments/index.ts#PayoutsModule]
- **S15.R-25** The expand migration is idempotent and keeps old readers working: it copies amounts, references, destinations (from `ProviderAccount` and `Shop.stripeAccountId`) and one history row per payout, and the contract step refuses unless the old and new columns agree. [proof: S15 AS-53]
- **S15.R-26** Payout settings are validated at startup and a bad value fails naming the setting and never a secret. [proof: S15 AS-54] [code: packages/backend/libs/common/config/payout-config.ts#payoutConfigKeys]

## Behaviors
- **S15.B-01** Given two eligible shops with 50,000 and 20,000, when the run executes, then payouts of 45,000 and 18,000 are `PENDING` with 5,000 and 2,000 held, balances are 5,000 and 2,000, `PAYOUT_CLEARING` holds 63,000, and the run is `COMPLETED` with 2 created. [proof: S15 AS-01]
- **S15.B-02** Given a destination changed 47 hours 59 minutes ago, when the run executes, then the shop is skipped as `destination_cooling`; at 48 hours it is paid to the new account. [proof: S15 AS-39]
- **S15.B-03** Given the provider accepted a transfer and the sending process died, when the job is redelivered, then the same key returns the same transfer and the payout is `PAID` once. [proof: S15 AS-19]
- **S15.B-04** Given the provider timed out, when the resolver finds the transfer, then the payout is `PAID` without a second transfer; when it finds a rejection, the payout is `FAILED` and the money is back. [proof: S15 AS-20]
- **S15.B-05** Given the provider answers with a wrong amount, then the payout is `UNKNOWN`, the mismatch is counted, a discrepancy event is emitted and nothing is posted. [proof: S15 AS-25]
- **S15.B-06** Given a cancel and a send at the same moment, then exactly one wins and the ledger still sums to zero. [proof: S15 AS-44]
- **S15.B-07** Given a run stopped after two payouts, when it is run again, then the two are found and the rest created, with the totals of an uninterrupted run. [proof: S15 AS-15]
- **S15.B-08** Given five seeded differences at the provider, when the audit runs, then each is reported once and a second run reports nothing. [proof: S15 AS-49]

## Owns
- Tables: `Payout`, `PayoutHistory`, `PayoutRun`, `PayoutDestination`, `PayoutDestinationHistory`, `PayoutReserve`, `PayoutReserveHistory`, `PayoutAuditDay`, `PayoutAuditFinding`.
- Events: `payout.created`, `payout.paid`, `payout.failed`, `payout.cancelled`, `payout.in_doubt`, `payout.discrepancy_detected` on topic `payouts.events`.
- Jobs: `payouts.run-weekly`, `payouts.send`, `payouts.resolve-in-doubt`, `payouts.audit-daily`.
- Configuration: `PAYOUT_DEFAULT_RESERVE_BPS`, `PAYOUT_MIN_MINOR`, `PAYOUT_CAP_MINOR`, `PAYOUT_DESTINATION_COOLING_HOURS`, `PAYOUT_PROVIDER_TIMEOUT_MS`, `PAYOUT_SEND_MAX_ATTEMPTS`, `PAYOUT_RESOLVER_MAX_RESENDS`, `PAYOUT_STALE_SENDING_MS`, `PAYOUT_IN_DOUBT_AFTER_HOURS`, `PAYOUT_CURSOR_SECRET`.

## Decisions
- The provider port returns the raw answer and the application validates it, so the validation is testable with a double behind the port.
- Retries live in two places that never act on the same state: the job layer for a transient answer (`SENDING`) and the resolver for an unknown outcome (`UNKNOWN`).
- A changed destination is skipped during cooling rather than paid to the old account: an attacker who redirects an account cannot divert the next run.
- `PayoutDestination` supersedes S14's `ProviderAccount`; the contract step (a later release, `migrations/contract/`) drops it.

## Known gaps
- Not proven by an automated test (listed in `specs/UNVERIFIED.md`, status `not run`): a 1,000-shop run that is repeated, raced and interrupted (SC-001), the payouts page under 300 ms at the 95th percentile with 5 years of history (SC-005), and a 1,000-shop run in under 5 minutes (SC-007).
- The Stripe transfer calls (`createTransfer`, `listTransfersByGroup`) are exercised through the scriptable double and the adapter's error classification, not against the real API.
- The seller journey in the browser (AS-37) belongs to W04 and J01.
