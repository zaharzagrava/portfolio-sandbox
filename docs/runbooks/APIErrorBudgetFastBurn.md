# APIErrorBudgetFastBurn (`SLOBurn_*_page_*`)

**Severity:** page · **Owner:** SLO owner (YAML) · **Dashboards:** Grafana → Marketplace → *API — RED per route* · **SLO:** label `slo`

## What it means
A journey is failing or slow at ≥ 6× the rate its SLO allows. At 14.4× the whole 30-day budget is gone in ~2 days, so users see errors now.

## Triage (≤ 5 min)
1. *API — RED*: filter `service`. Which **routes** carry the 5xx / slow requests (panels "Error rate by route", "p99 latency by route")?
2. Errors or latency? Errors → Loki: `{service="core", level="error"} | json | line_format "{{.msg}} {{.err}}"`. Open a `traceId` → Jaeger shows the failing span (DB? Redis? downstream?).
3. Deploy in the last hour? `gh run list --workflow deploy.yml --limit 5`.
4. Traffic spike? Requests/s panel vs last week; 429s rising means load shedding/rate limits are doing their job.

## Mitigate
- **Recent deploy:** roll back first, debug later (`deploy.yml` → rollback; Lambda: alias back to the previous version).
- **Dependency down** (Jaeger shows timeouts to Postgres/Redis/ES/Stripe): follow that runbook (`PostgresConnectionsHigh`, `RedisMemoryHigh`, `StripeCircuitOpen`).
- **Overload** (event loop p99 > 200 ms, CPU high): scale the ASG out (`aws autoscaling set-desired-capacity`); load shedding (F-01) returns 503 before collapse; raise edge rate limits only if the traffic is legitimate.
- **One feature failing:** turn its flag off (SD-38 kill switch: `POST /api/admin/flags/<key>/kill`).

## Verify
`slo:sli_error:ratio_rate5m{slo="<slo>"}` back under the budget line for 30 minutes; the alert resolves by itself (short window).

## Follow-up
Postmortem if > 20% of the budget was spent.
