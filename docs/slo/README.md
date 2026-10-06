# SLOs, error budgets, paging (O-01)

The YAML files here are the **single source of truth**. `pnpm slo:generate` turns them into Prometheus recording and burn-rate alert rules (`infra/observability/prometheus/rules/slo.generated.yml`) and k6 thresholds (`packages/backend/scripts/load-tests/slo-thresholds.json`). CI fails if the generated files are stale.

| SLO | Journey | Objective (30 d) | SLI | Budget |
|---|---|---|---|---|
| browse-search-latency | Browse & search | 99.9% | requests < 300 ms | 43 min of "slow" |
| browse-search-availability | Browse & search | 99.9% | non-5xx | 43 min |
| checkout-availability | Checkout | 99.95% | non-5xx (4xx out-of-stock is a correct answer) | 21.6 min |
| checkout-latency | Checkout | 99% | < 750 ms | 7.2 h |
| payments-processing | Payments | 99.99% | non-5xx in payment-processor | 4.3 min |
| payments-end-to-end | Payments | 99.9% | result in read model < 5 s | 43 min |
| launch-event-holds | Launch events | 99.9% | non-5xx on hold requests | 43 min |
| read-model-freshness | Notifications & realtime | 99% | projection lag < 60 s | 7.2 h |
| realtime-gateway | Notifications & realtime | 99.9% | SSE connects non-5xx | 43 min |

"No-loss" for payments is not a ratio: it is guarded by the ledger invariant alert (`LedgerInvariantViolated`, page on the first occurrence) and the nightly reconciliation (SD-20).

## Alerting from SLOs
Multi-window, multi-burn-rate (Google SRE workbook):

| Burn rate | Long / short window | Budget spent when it fires | Action |
|---|---|---|---|
| 14.4× | 1 h / 5 m | 2% in 1 h | **page** |
| 6× | 6 h / 30 m | 5% in 6 h | **page** |
| 1× | 3 d / 6 h | on track to spend 100% | **ticket** |

Cause-based alerts (`rules/causes.yml`) page only for imminent, user-visible failure: the DB connection ceiling, Redis memory, consumer lag, money invariants and the Stripe circuit.

## Severity and paging policy
| Severity | Meaning | Who / how fast | Examples |
|---|---|---|---|
| **SEV1** | Money or data at risk, checkout/payments down for many users | Page on-call + incident commander, ack ≤ 5 min, status page | ledger invariant, oversell, payments-processing fast burn |
| **SEV2** | A journey degraded, budget burning fast | Page on-call, ack ≤ 15 min | checkout/browse fast burn, Stripe circuit open, Redis memory |
| **SEV3** | Slow burn / single component, no immediate user impact | Ticket, next business day | 3d burn, DLQ not empty, projection lag |
| **SEV4** | Cosmetic / internal tooling | Backlog | dashboard target down |

`severity=page` alerts map to SEV1/2, `severity=ticket` to SEV3. Pages outside business hours are reviewed weekly: a page that needed no action is a bug in the alert (tune or delete it).

## Error budget policy
1. **Budget > 50%:** ship freely; experiments and risky migrations are allowed.
2. **Budget 0–50%:** every deploy touching the journey needs a rollback plan and canary (O-02). Reliability items get priority in planning.
3. **Budget exhausted:** feature freeze on the owning team's services for the rest of the window. Only fixes, reliability work and security patches ship. The owning team lead and on-call agree when the freeze lifts (budget back above 10%, or root causes fixed).
4. **One incident eats > 20% of a budget:** a postmortem is mandatory (template in `docs/incidents/`), with action items tracked to completion.
5. **Disputes:** the SLO owner (YAML `owner`) and the engineering manager decide. If an SLO is consistently met with large margin or missed by design, change the YAML, not the policy.
