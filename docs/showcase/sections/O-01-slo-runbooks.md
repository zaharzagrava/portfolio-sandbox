# O-01 — SLOs, Error Budgets, Runbooks, Incident Process

Status: ☑ done · Phase 8 · Depends on: SD-33 · Lesson 07/01

## Deliverables
- `docs/slo/*.yaml` per critical journey: browse/search (99.9%, p99 < 300 ms), checkout (99.95% success), payments processing (99.99% no-loss, 99.9% < 5 s end-to-end), launch-event holds (99.9%), notifications (99% < 60 s), realtime delivery.
- Error budget policy doc (who does what when the budget is gone).
- Severity levels + paging policy.
- Runbooks in `docs/runbooks/` using the template from the notes: `APIErrorBudgetFastBurn`, `PostgresConnectionsHigh`, `KafkaConsumerLagHigh`, `DLQNotEmpty`, `FlashSaleOversellDetected`, `RedisMemoryHigh`, `ProjectionLagHigh`, `StripeCircuitOpen`.
- Blameless postmortem template + one worked example postmortem ("flash sale stock drift").
- k6 thresholds aligned with SLOs (F-04 convention).

## Steps
- [x] SLO YAMLs + generator wiring (SD-33).
- [x] Runbooks (each links dashboards/log queries, triage < 5 min, mitigation branches, verification).
- [x] Postmortem template + example.

## Scale
SLO targets encode D25 numbers; k6 thresholds and burn-rate alerts are generated from the same YAML so "scale" is measurable, not claimed.

## Implementation notes (2026-10-02)
- **SLOs:** `docs/slo/*.yaml` define 9 SLOs: browse latency + availability, checkout availability + latency, payments processing + end-to-end (projection lag ≤ 5 s), launch holds, read-model freshness, realtime gateway.
  - `docs/slo/README.md` has the SLO table with budgets in minutes, the burn-rate table, **severity levels SEV1-4 with ack times**, the paging policy (a page with no action needed is an alert bug), and the **error budget policy** (> 50% ship freely, 0-50% canary + rollback plan, exhausted = feature freeze, > 20% in one incident = mandatory postmortem).
  - Payments "no-loss" is enforced by `LedgerInvariantViolated` (page on the first occurrence) + reconciliation, not by a ratio.
- **Generated outputs:** `pnpm slo:generate` produces the Prometheus rules (81 rules) and `scripts/load-tests/slo-thresholds.json`, so k6 thresholds and alerts cannot drift apart.
- **Runbooks** (`docs/runbooks/`): a template plus the 8 listed in Deliverables. Every alert in `causes.yml` and every generated burn-rate alert links one.
  - Each runbook has: what it means for users, triage ≤ 5 min with exact SQL / LogQL / CLI, mitigation branches (rollback first, then dependency-specific steps), verification queries and follow-up.
  - They reference real mechanisms: SD-38 kill switch, F-05 projection rebuild and DLQ, F-01 load shedding, SD-19 holds and idempotency keys, DLQ redrive with `start-message-move-task`.
- **Postmortems** (`docs/incidents/`): a blameless template, plus a worked example ("flash sale stock drift after a Redis failover") that follows the `FlashSaleOversellDetected` runbook and produces concrete prevent/detect/mitigate actions (`WAIT 1 50`, failover-event alert, mid-sale reconciliation).
