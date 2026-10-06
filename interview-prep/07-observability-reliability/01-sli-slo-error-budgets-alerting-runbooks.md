# SLIs, SLOs, Error Budgets, Alerting Thresholds, Runbooks, Incidents

> **Covers:** SLI/SLO definitions, error budgets, concrete alert thresholds and runbooks.

Learn the definitions **word for word**, and have **numbers** ready.

---

## 1. Definitions (memorize these)

- **SLI (Service Level Indicator)**: a *quantitative measure* of one aspect of the service as users experience it, best expressed as a **ratio of good events to valid events**:
  `SLI = good events / valid events × 100%`
  Example: *"The proportion of valid HTTP requests to the checkout API that return a non-5xx response, measured at the load balancer."*

- **SLO (Service Level Objective)**: a **target value** for an SLI over a **time window**.
  Example: *"99.9% of checkout requests succeed, measured over a rolling 28-day window."*

- **SLA (Service Level Agreement)**: a **contract** with customers that has **consequences** (credits, refunds) when it's missed. The SLA is **looser** than the internal SLO (SLO 99.9%, SLA 99.5%), so you get warned well before a contract breach.

- **Error budget** = `1 − SLO`: the amount of unreliability you're *allowed*. At 99.9%, 0.1% of requests may fail. Over 30 days that's **43.2 minutes** of full downtime-equivalent.

- **Burn rate**: how fast you consume the budget relative to the steady rate that would use exactly 100% of it by the end of the window.
  Burn rate 1 = the budget runs out at the end of the window. Burn rate 14.4 = **2% of a 30-day budget gone in 1 hour**.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SloDefinition`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L12): The SloDefinition interface defines an SLO with name, objective, SLI type (availability or latency) and metric, and so encodes the SLI/SLO definitions as code. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`validateSlo`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L36): validateSlo checks that an SLO has a kebab-case name, an objective between 0 and 100, and a threshold for latency SLIs. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`errorRatio`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L43): errorRatio builds the PromQL bad-over-valid ratio for availability (5xx) and latency (histogram bucket) SLIs. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

### The nines table

| SLO | Budget / 30 days | / 7 days | / 1 day |
|---|---|---|---|
| 99% | 7h 12m | 1h 40.8m | 14.4m |
| 99.5% | 3h 36m | 50.4m | 7.2m |
| 99.9% | **43.2m** | 10.1m | 1.44m |
| 99.95% | 21.6m | 5.04m | 43.2s |
| 99.99% | 4.32m | 1.01m | 8.64s |

Each extra nine costs roughly **10× more** engineering effort. Pick SLOs based on **user expectations and business needs**, not "as high as possible". Also, your SLO can't be higher than your dependencies' availability multiplied together, unless you have redundancy.

---

## 2. Choosing SLIs: concrete examples by service type

| Service type | SLI | Good event definition | Measured where |
|---|---|---|---|
| Request/response API | **Availability** | response status not 5xx (and not 429 caused by *our* overload) | LB / ingress logs or metrics |
| | **Latency** | request served in < 300 ms (choose threshold from UX) | LB / server histogram |
| Data pipeline / ETL sync | **Freshness** | data in target is < 15 min behind source | watermark lag metric |
| | **Correctness** | reconciliation diff = 0 for records processed | reconciliation job output |
| | **Coverage** | % of expected records processed in the run | job metrics |
| Async queue workers | **Processing latency** | message processed within 5 min of enqueue | queue age / end-to-end timestamps |
| Batch jobs (monthly invoicing) | **Success / timeliness** | job completed successfully by 06:00 on the 1st | job status |
| Frontend | **Core Web Vitals** | page load LCP < 2.5 s; INP < 200 ms | RUM |

Details that show maturity:
- **Exclude invalid events**: health checks, requests from internal synthetic monitors (or count them separately), and client errors (4xx) because they're not the service's fault. **429s are debatable**: count them if *we* throttled because of our own capacity problems.
- Measure **as close to the user as possible** (LB or RUM rather than in-process). A pod that crashes reports no errors about itself.
- Write latency SLOs as **thresholds**, not averages: "99% of requests < 500 ms **and** 95% < 200 ms" (multiple thresholds).
- Use **critical user journeys** (login, search, checkout), not every endpoint. Group endpoints by importance.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`k6Thresholds`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L80): k6Thresholds extracts load-test thresholds from the SLOs per user journey, so SLIs are tied to journeys. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
<!-- theory-links:end -->

### Example SLO document (what you'd present)
```yaml
service: checkout-api
owner: team-checkout (on-call: #checkout-oncall)
slos:
  - name: checkout-availability
    sli: ratio of POST /orders responses with status < 500, measured at ingress
    objective: 99.9%
    window: 28d rolling
  - name: checkout-latency
    sli: ratio of POST /orders requests completed in < 800ms, measured at ingress
    objective: 99%
    window: 28d rolling
  - name: confirmation-email-freshness
    sli: ratio of minutes where order-confirmation email lag < 5 min
    objective: 99.5%
    window: 28d rolling
error_budget_policy: link-to-policy
review: quarterly with product
```

---

## 3. Error budget policy (who does what when the budget is gone)

A written agreement between engineering and product:

> - **Budget > 50% remaining**: normal feature velocity; risky experiments allowed.
> - **Budget 25–50%**: extra scrutiny on risky changes; prioritize top reliability action items.
> - **Budget < 25%**: only low-risk deploys; reliability work prioritized in sprint.
> - **Budget exhausted**: **feature freeze** for the service (except security/P0 fixes) until budget recovers or for N days; postmortem required for each incident consuming >20% of budget; team lead + product manager review.
> - **Exceptions**: outages caused by dependencies outside our control are reviewed case by case; the owning team for the dependency gets the action items.
> - **Owner**: service owning team's engineering manager is accountable for enforcing; SRE/platform advises.

The point: the error budget turns "reliability vs velocity" from a matter of opinion into a **data-driven decision**.

---

## 4. Alerting philosophy

1. **Page on symptoms, not causes.** Users feel "checkout errors at 5%", not "CPU at 90%". High CPU with healthy SLIs isn't an emergency, so make it a ticket or dashboard item.
2. **Every page must be actionable, urgent, and real.** If the on-call engineer can't do anything, or it can wait until morning, it's a ticket.
3. **Every alert has**: an owner, a severity, a **runbook link**, a dashboard link, and a clear description of user impact.
4. Track alert quality: number of pages per on-call shift (Google SRE suggests at most ~2 incidents per 12-hour shift), and the false-positive rate. Remove or tune noisy alerts.

### Severity levels (example)
| Sev | Meaning | Response |
|---|---|---|
| SEV1 | critical user-facing outage / data loss / security breach | page immediately, incident commander, status page, all-hands as needed |
| SEV2 | major degradation, partial outage, key feature broken | page on-call, status page if customer visible |
| SEV3 | minor impact, workaround exists | ticket, business hours |
| SEV4 | no user impact (capacity warning, cert expiring in 14 days) | ticket |

---

## 5. Concrete alert thresholds

### 5.1 SLO burn-rate alerts (multi-window, multi-burn-rate, from the Google SRE Workbook)
For a **99.9% SLO** (budget 0.1%) over 30 days:

| Severity | Long window | Short window | Burn rate | Error rate threshold | Budget consumed when it fires |
|---|---|---|---|---|---|
| **Page** | 1h | 5m | 14.4 | > 1.44% | 2% |
| **Page** | 6h | 30m | 6 | > 0.6% | 5% |
| **Ticket** | 3d | 6h | 1 | > 0.1% | 10% |

- **Long window** = significance (enough budget gone to matter). **Short window** = the problem is **still happening**, so the alert resets quickly after recovery.
- Why not "error rate > 1% for 5 minutes"? It's noisy during low traffic, and it misses slow burns that drain the whole budget over days.

```yaml
# Prometheus rule (99.9% availability SLO)
groups:
- name: api-slo
  rules:
  - record: job:slo_errors_per_request:ratio_rate1h
    expr: sum(rate(http_requests_total{job="api",code=~"5.."}[1h])) / sum(rate(http_requests_total{job="api"}[1h]))
  - record: job:slo_errors_per_request:ratio_rate5m
    expr: sum(rate(http_requests_total{job="api",code=~"5.."}[5m])) / sum(rate(http_requests_total{job="api"}[5m]))
  - alert: APIErrorBudgetFastBurn
    expr: |
      job:slo_errors_per_request:ratio_rate1h > (14.4 * 0.001)
      and
      job:slo_errors_per_request:ratio_rate5m > (14.4 * 0.001)
    labels: { severity: page, team: checkout }
    annotations:
      summary: "API burning error budget 14x (2% of monthly budget in 1h)"
      runbook_url: https://runbooks.internal/api/high-error-rate
      dashboard: https://grafana.internal/d/api-slo
```

Latency burn: the same pattern using `http_request_duration_seconds_bucket{le="0.3"}` to count requests over the threshold as "bad".

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`BURN_ALERTS`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L30): BURN_ALERTS lists the multi-window, multi-burn-rate page and ticket alert patterns with their burn factors and windows. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [`sloRuleGroup`](../../packages/backend/libs/common/telemetry/slo-rules.ts#L55): sloRuleGroup generates the Prometheus rule group with recording rules and multi-burn-rate alerts for each SLO. _(slo-rules.ts)_ · [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md)
> - [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md): The telemetry module generates the multi-window burn-rate alerting rules from YAML SLO definitions.
<!-- theory-links:end -->

### 5.2 Cause-based alerts (tickets or warnings, sometimes pages): example numbers
Tune these for your system. The point in an interview is to show you think in **concrete values with durations**:

| Component | Signal | Warning (ticket) | Critical (page) |
|---|---|---|---|
| **Node.js** | event loop delay p99 | > 100ms for 10m | > 500ms for 5m |
| | heap used / limit | > 80% for 15m | > 90% for 5m or OOMKills > 0 |
| | pod restarts | > 3 in 30m | CrashLoopBackOff |
| **Postgres** | connections used / max | > 75% for 10m | > 90% for 5m |
| | replication lag | > 30s for 5m | > 5m (stale reads / failover risk) |
| | disk free | < 20% | < 10%, or `predict_linear` says full within 4h |
| | longest transaction age | > 15m | > 1h (vacuum blocked) |
| | deadlocks | > 0 sustained (ticket) | — |
| | `age(datfrozenxid)` | > 1B | > 1.5B (wraparound risk) |
| | p95 query latency (top statements) | > 2× baseline 15m | — (SLO alert covers it) |
| **Redis** | memory used / maxmemory | > 80% | > 95% or evictions > 0 when used as datastore |
| | hit ratio | < 80% for 30m (cache) | — |
| | replication link down | — | > 1m |
| **SQS / queues** | `ApproximateAgeOfOldestMessage` | > 5m | > 15m (freshness SLO risk) |
| | DLQ depth | > 0 (ticket, with message samples) | > 100 or growing fast |
| **Kafka** | consumer lag (time) | > 2m | > 10m |
| **K8s** | CPU throttling | > 25% for 15m | — |
| | HPA at max replicas | for 15m (ticket: capacity) | — |
| **TLS** | certificate expiry | < 21 days | < 7 days |
| **Jobs** | monthly invoice job | not started by 01:30 | failed or not finished by 06:00 |

Use `for:` durations to avoid flapping, and add hysteresis where possible.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [load-shedding](../../docs/humans/concepts/common-load-shedding/load-shedding.md): The load-shedding module monitors event-loop delay and exposes a p99 metric, which is the Node.js event-loop signal used in cause-based alerts.
> - [`QueueMetricsService`](../../packages/backend/libs/infrastructure/sqs/queue-metrics.service.ts#L15): QueueMetricsService exposes SQS queue depth and message age as OpenTelemetry gauges, the signals that queue and DLQ alerts are built on. _(queue-metrics.service.ts)_
<!-- theory-links:end -->

---

## 6. Runbooks

A runbook says: **this alert fired. Here's what it means, how to confirm it, how to mitigate it, and who to escalate to.** It's written for a tired engineer at 3 a.m. who may not know the service well.

### Template
```markdown
# <Alert name>
**Severity:** SEV2 (page) | **Owner:** team-x | **Last reviewed:** 2026-09-01
## What this alert means
## User impact
## Dashboards & logs (links)
## Triage (diagnose in < 5 min)
## Mitigation (stop the bleeding first)
## Resolution / root cause investigation
## Escalation
## Verification (how do you know it's fixed)
## History (links to past incidents)
```

### Example 1: `APIErrorBudgetFastBurn`
```markdown
# APIErrorBudgetFastBurn (checkout-api)
Severity: page (SEV2; escalate to SEV1 if >10% errors or checkout fully down)

## Meaning
5xx ratio > 1.44% over 1h AND 5m. At this rate 2% of monthly budget burns per hour.

## Impact
Users may fail to place orders. Revenue-impacting.

## Triage
1. Grafana "API SLO" dashboard: which endpoints? (panel: 5xx by route)
2. Did something change?  `argocd app history checkout-api` / #deploys channel — deploy in last 2h?
3. Check dependencies panel: Postgres latency/connections, Redis, external payment provider.
4. Logs: `service:checkout-api level:error` grouped by error code; open a trace for a failing request.

## Mitigation (pick the matching branch)
- Recent deploy → ROLL BACK first, investigate later:
  `argocd app rollback checkout-api <previous-revision>` (or revert commit in GitOps repo).
- Postgres connection exhaustion → see runbook "PostgresConnectionsHigh".
- Single pod bad (errors only from one pod) → `kubectl delete pod <pod>`; check node health.
- Payment provider down (errors in payment calls only) → enable feature flag `payments.queueMode=true`
  (accept orders, process payments later); post status page update.
- Traffic spike / overload → scale: `kubectl scale deploy checkout-api --replicas=<n>` (HPA max permitting);
  confirm DB can take it.

## Escalation
- No mitigation in 30 min → page secondary + engineering manager.
- Data integrity concern → page payments tech lead, declare SEV1.

## Verification
Error ratio 5m back below 0.1%; burn alert resolves; spot-check checkout manually.

## After
Incident ticket, timeline in #inc channel, postmortem if > 20% budget consumed.
```

### Example 2: `PostgresConnectionsHigh`
```markdown
## Meaning
Active connections > 90% of max_connections for 5m. New connections will fail soon → 5xx.

## Triage
SELECT state, application_name, count(*) FROM pg_stat_activity GROUP BY 1,2 ORDER BY 3 DESC;
- Many "idle in transaction"? → app leak (transaction not committed/released).
- Many "active" with long durations? → slow queries:
  SELECT pid, now()-query_start AS dur, wait_event_type, left(query,100)
  FROM pg_stat_activity WHERE state <> 'idle' ORDER BY dur DESC LIMIT 20;
- Did replica count jump (HPA)? pods × pool size > max_connections?

## Mitigation
- Terminate stuck idle-in-transaction sessions older than 10 min:
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE state = 'idle in transaction' AND now() - state_change > interval '10 minutes';
- Cancel a runaway query: SELECT pg_cancel_backend(<pid>);
- Cap HPA max replicas temporarily; reduce worker concurrency.
- Recent deploy introduced N+1 / missing index → rollback.

## Long-term
PgBouncer / RDS Proxy, pool sizing, idle_in_transaction_session_timeout, statement_timeout.
```

### Example 3: `DLQNotEmpty` (sync pipeline)
Steps: check sample messages (`aws sqs receive-message --queue-url $DLQ --max-number-of-messages 5`), classify (poison payload vs downstream outage vs bug), fix, **redrive** (`aws sqs start-message-move-task --source-arn $DLQ_ARN`), verify the main queue drains, and run reconciliation for the affected period.

**Runbook hygiene:** review runbooks after every incident and quarterly, link them from alerts, prefer **automation** for repeated steps (a runbook step that is always the same should become a script or auto-remediation), and test them during game days.

---

## 7. Incident management

- **Roles**: Incident Commander (coordinates and decides; doesn't debug), Ops/Tech lead (hands on keyboard), Communications lead (status page, stakeholders), Scribe (timeline).
- **Priorities**: 1) stop the bleeding (rollback, failover, feature flag), 2) restore service, 3) preserve evidence, 4) root cause later.
- Communicate on a schedule (every 30 min for SEV1), even when there's nothing new.
- **Key metrics**: MTTD (detect), MTTA (acknowledge), MTTM/MTTR (mitigate/recover).

### Blameless postmortem template
```markdown
# Postmortem: Checkout failures 2026-09-12
Status: final | Severity: SEV2 | Duration: 47 min | Budget consumed: 31% (monthly)
## Summary (3 sentences)
## Impact (users affected, failed requests, revenue estimate)
## Timeline (UTC; detection → mitigation → resolution)
## Root cause(s) & contributing factors (5 whys; systems, not people)
## What went well / what went poorly / where we got lucky
## Action items
| Action | Type (prevent/detect/mitigate) | Owner | Due | Ticket |
|---|---|---|---|---|
| Add CI check for missing index on new FK columns | prevent | @dev | 2026-09-30 | ABC-123 |
| Add canary analysis on 5xx ratio to Argo Rollouts | detect | @platform | 2026-10-15 | ABC-124 |
```
Action items need **owners and due dates**, and someone (the EM) checks they get done.

---

## Interview Q&A

**Q: Define SLI, SLO, and SLA, with an example.**
An SLI is a measured ratio of good to valid events, for example the percentage of checkout requests answered with non-5xx at the load balancer. An SLO is the target for that SLI over a window: 99.9% over 28 days, which gives a 0.1% error budget, about 40 minutes of full outage. An SLA is the contractual promise with penalties, deliberately looser, say 99.5%.

**Q: How do you alert on an SLO?**
Multi-window burn-rate alerts. Page when the 1h and 5m error ratios both exceed 14.4× the budget rate (2% of the monthly budget in an hour), or the 6h and 30m ratios exceed 6× (5%). Open a ticket at 1× over 3 days. That catches fast outages quickly and slow burns eventually, without paging on short blips.

**Q: What makes a good runbook?**
It's linked from the alert and says what the alert means and its user impact, has dashboard and query links, fast triage steps, mitigation branches that come first (rollback, flags, scaling, exact commands), escalation paths, verification, and links to past incidents. It's reviewed after every incident and repetitive steps get automated.

**Q: What happens when the error budget is exhausted?**
Whatever the pre-agreed error budget policy says: feature freeze or reliability-only work for the owning team until the budget recovers, postmortems for big consumers, and the EM and PM accountable for enforcing it. The point is that the data makes the call rather than an argument.
