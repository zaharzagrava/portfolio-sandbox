# AdReconciliationDrift

**Severity:** ticket · **Owner:** marketing (S36) · **Dashboards:** metrics `ads_reconciliation_drift_ratio{day}`, `ads_reconciliation_runs_total{status}`, `ads_billing_lag_seconds` · **SLO:** SC-007 (unexplained difference after reconciliation is zero; a drift above 1% alerts the same day)

## What it means
For one UTC day the clicks the streaming path billed differ from the exact valid, distinct clicks in the raw log by more than 1% (`ads_reconciliation_drift_ratio{day="YYYY-MM-DD"} > 0.01`). The daily reconciliation has already posted the corrective `ADJUSTMENT` journals, so shops are charged the exact amount; the alert says the speed path lost or double counted clicks and must be understood before it grows. Shops are not over-charged by it, but refunds and extra charges appear on their statements.

## Triage (≤ 5 min)
1. Is it real? Read the day's `AdReconciliationRun` (`status`, `hoursChecked`, `hoursAdjusted`, `driftRatio`) and `ads_reconciliation_drift_ratio{day}`. A run with `status = 'FAILED'` and `reason = 'source_unavailable'` is not drift: the raw log was unreadable and no money moved (next run retries).
2. What changed? Aggregator deploys, a restart storm (`ads_aggregator_fenced_total`), consumer lag on `ads-click-log-writer` / `ads-aggregate-writer`, a broker outage in the hour of the drift (`ads_clicks_total{outcome="record_failed"}`).
3. Blast radius: which campaigns and hours: `SELECT "campaignId", "hour", "deltaClicks" FROM "AdBillingAdjustment" WHERE "reconciliationRunId" = '<run id>' ORDER BY abs("deltaClicks") DESC`.

## Mitigate (stop the bleeding first, root-cause later)
- **If the aggregator was fenced or restarted repeatedly:** check that every worker replica has its own `ads_aggregator_instance`; a duplicate slot name makes two healthy replicas fence each other. Fix the configuration and redeploy.
- **If the writers lagged:** scale the worker or wait; late rows are counted by the next day's run (the 3-day window), no manual action on money.
- **If the stream path under-counted after a broker outage:** nothing to undo; the adjustments already charged the difference. Record the incident.
- Never edit `AdBillingRun`, `AdBillingAdjustment` or ledger rows by hand: a closed day is only corrected by a new, dated adjustment.

## Verify
`ads_reconciliation_drift_ratio` of the following days stays at or below 0.01, and `ads_reconciliation_runs_total{status="failed"}` does not grow. Re-run a day explicitly with the job `ads.reconcile-day {day: "YYYY-MM-DD"}`: it must post nothing (idempotent).

## Follow-up
Ticket for the root cause of the drift; postmortem if more than one day exceeds 1% or the drift is above 10%.
