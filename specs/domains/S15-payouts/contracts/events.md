# Event contracts: S15 — `payments` payouts

Definitions use `defineEvent` over zod schemas in `packages/contracts/src/payments/payout-events.ts`; the envelope `{eventId, type, version: 1, occurredAt, aggregateId}` is S53's, `aggregateId = payoutId`. Money is `…Minor`. **No destination, no provider account id, no secret, no provider body** in any payload (AS-50, AS-51). Delivery is by the relay from the outbox to the topic, never a direct publish.

## Produced (outbox → topic `payouts.events`, key = `payoutId`)

| Event | Version | Appended by | Payload |
|---|---|---|---|
| `payout.created` | 1 | creation step (same transaction as the row, the journal, the history and the job) | `{payoutId, shopId, periodStart, amountMinor, reserveHeldMinor, currency, payoutVersion}` |
| `payout.paid` | 1 | result transaction (`→ PAID`) | `{payoutId, shopId, periodStart, amountMinor, currency, transferRef, paidAt, payoutVersion}` |
| `payout.failed` | 1 | result transaction (`→ FAILED`) | `{payoutId, shopId, periodStart, amountMinor, currency, failureCode, payoutVersion}` |
| `payout.cancelled` | 1 | cancel transaction | `{payoutId, shopId, periodStart, amountMinor, currency, cancelledBy, reason, payoutVersion}` |
| `payout.in_doubt` | 1 | resolver, once per payout (`inDoubtEventAt` conditional update in the same transaction) | `{payoutId, shopId, periodStart, amountMinor, currency, inDoubtSince, payoutVersion}` |
| `payout.discrepancy_detected` | 1 | adapter-mismatch path, conflicting-outcome path (once, `discrepancyReportedAt`), daily audit (once per `(payoutId, kind)`) | `{payoutId, shopId, kind: "amount"\|"currency"\|"destination"\|"missing_transfer"\|"reversed_at_provider"\|"conflicting_outcome", payoutVersion}` |

Rules:

- Every transition event is appended inside the transition's own transaction (`OutboxService.append(event, tx)`): a rollback removes it (AS-16, AS-50). `payoutVersion` is the row's version **after** the update. `SENDING` and `UNKNOWN` transitions bump the version but have no event, so versions seen by a consumer are monotone, not contiguous: consumers dedupe by `eventId` or discard `payoutVersion ≤ last seen`.
- `payout.cancelled.reason` is the operator's text (≤ 200 chars, already validated); it carries no personal data by contract (the admin UI says so); the `cancelledBy` is an admin user id.
- `provider mismatch` (AS-25) → `payout.discrepancy_detected` with the `kind` that failed (`amount`, `currency`, `destination`) or `missing_transfer` for an absent/empty `transferRef` and malformed bodies; the transition to `UNKNOWN` has no event of its own.
- No event is produced for `SENDING`, for skips, or for the run record.

## Compatibility with consumers already in the repository

| Consumer | File | Check |
|---|---|---|
| S43 webhooks | `packages/contracts/src/developer-platform/webhooks.ts` `webhookPayoutEventSchemas` (`looseObject`) | `payout.paid`/`payout.failed` payloads parse; fields `payoutId`, `periodStart`, `amountMinor`, `currency`, `transferRef`/`failureCode`, `payoutVersion` present |
| S28 notifications | `packages/contracts/src/notifications/consumed-events.ts` `payoutConsumedSchemas` (`object`) | same, and the topic name `payouts.events` matches `notifications.topics.ts` |
| S16 statements | (not yet built) | reads `payout.paid` per shop and month, R3; sibling bullet |

A contract spec (`packages/contracts/src/payments/payout-events.spec.ts`) parses one fixture per event with the S15 schema, S43's and S28's. Neither sibling file is edited.

## Consumed

None. This capability has no async consumer; it therefore has no inbox, no consumer-idempotency test (VII.4) and no DLQ. Duplicate delivery of **jobs** is covered by the job rows of the test plan (AS-18, AS-30, AS-44).

## Jobs (registered with S49; each `declareJobType` with a zod contract next to its `JobPayloads` augmentation)

| Job | Payload | Schedule | Options |
|---|---|---|---|
| `payouts.run-weekly` | `{periodStart?: 'YYYY-MM-DD'}` | `0 6 * * 1` `Europe/Warsaw` | `maxAttempts: 3`, `fleetConcurrency: 1`, lease 10 min with heartbeat, cooperative stop on `ctx.signal` |
| `payouts.send` | `{payoutId: uuid}` | enqueued by the creation step, `idempotencyKey: payout-send:<payoutId>`, `shopId` for fairness | `maxAttempts: 5`, `concurrency: 8`; on `ctx.isLastAttempt` a transient outcome becomes `UNKNOWN` instead of a throw |
| `payouts.resolve-in-doubt` | `{}` | `* * * * *` UTC | `maxAttempts: 3`, `fleetConcurrency: 1`, ≤ 50 payouts per run |
| `payouts.audit-daily` | `{day?: 'YYYY-MM-DD'}` | `20 3 * * *` UTC (checks the previous UTC day) | `maxAttempts: 3`, `fleetConcurrency: 1` |

`InvalidScheduleError` from `upsertSchedule` is caught at bootstrap and logged with the job name. This domain has no caller of `JobsService.cancel`.

## Metrics (FR-052; registered through `MetricsRegistry`, names exact)

`payout_created_total`, `payout_skipped_total{reason}`, `payout_transfer_total{outcome}` (`paid`, `rejected`, `transient`, `unknown`), `payout_in_doubt_age_seconds` (gauge: age of the oldest in-doubt payout, 0 when none), `payout_provider_mismatch_total{kind}`, `payout_conflicting_outcome_total`, `payout_discrepancy_detected_total{kind}`, `payout_run_duration_seconds` (histogram), `payout_run_total{status}`. Label values come from closed enums (no ids, no destinations).
