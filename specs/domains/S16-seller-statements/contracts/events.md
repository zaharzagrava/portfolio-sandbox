# Event contracts: S16 statements

## Produced (outbox → `statements.events`, key = aggregate ID)

Defined with `defineEvent` in `application/events/statements-events.ts`; schemas exported from `packages/contracts/src/statements/events.ts`; envelope `{eventId, type, version:1, occurredAt, aggregateId}`.

| Type | Aggregate | Payload | Written by |
|---|---|---|---|
| `statements.period_closed` | `month` (`YYYY-MM`) | `{month, knowledgeCutoff, shopCount, runId, closedAt}` | `PeriodCloseService.finalise`, same transaction as `CLOSING → CLOSED` |
| `statements.adjustment_booked` | `adjustmentId` | `{adjustmentId, shopId, refersToMonth, bookedMonth, causeKind, causeRef, grossDeltaMinor, commissionDeltaMinor, lineCountDelta, payoutsPaidDeltaMinor}` | `AdjustmentService`, same transaction as the adjustment row |

The topic is registered in `infrastructure/events/topic-registry.ts` by this change. Consumers (S28, J01) dedupe by `eventId`.

## Consumed

| Topic / type | Projector (`name`) | Idempotency | Validation | Dead-letter reasons |
|---|---|---|---|---|
| `orders.events` `order.paid` | `statements-sales` | inbox claim by `eventId` and version guard on `(orderId, lineId, orderVersion)` | `orderPaidFactSchema` (statements side, picks fields explicitly): `lineId`, `category` (trim, lower, 1–64), `shopId` UUID, `quantity` int ≥ 1, money ints ≥ 0, `lineTotalMinor = quantity×unitPriceMinor − discountMinor` and ≤ 1e12, currency `EUR`, `paidAt` ISO with offset, `orderVersion` int ≥ 1, known `version` | `invalid_payload`, `missing_line_id`, `missing_shop`, `currency_not_eur`, `line_total_mismatch`, `amount_too_large`, `unknown_version` |
| `payouts.events` `payout.paid` | `statements-payouts` | inbox + `payoutVersion` guard | `payoutPaidSchema` imported from `packages/contracts/src/payments/payout-events.ts` | `invalid_payload`, `currency_not_eur`, `unknown_version` |
| `ledger.events` `ledger.journal_posted` v2 | `statements-ledger` | inbox + unique `journalId` | `journalPostedV2Schema` from `packages/contracts/src/payments/ledger-events.ts`; only kind `SALE` is stored, other kinds are skipped and counted; v1 payloads are not upcast (skipped, counted `legacy`) | `invalid_payload`, `unknown_version` |

Other types on these topics (`payout.created`, `payout.failed`, `payout.cancelled`, `payout.in_doubt`, …) are not in `handles`, so the framework skips them and they have no effect (AS-56). Metrics follow FR-054: `statements_events_applied_total{stream,outcome}`, `statements_events_rejected_total{stream,reason}`, `statements_ingestion_lag_seconds{stream}`.
