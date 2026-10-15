# Event contracts: S18 (consumer only; no event is emitted)

Each consumer is a `Projector` (S53) with `idempotency: 'inbox'`, schema validation before any effect, and `PermanentError(reason)` for dead-lettering. Unknown extra fields are ignored.

| Topic / type | Payload (zod) | Identity | Effect |
|---|---|---|---|
| `usage.recorded` v1 (from developer-platform) | envelope `aggregateId = subjectId` (non-empty); `{metric: string matching ^(api\.calls\|llm\.[a-z][a-z_]{0,31}\.tokens)$, quantity: int 1..1_000_000_000, ts: ISO instant in [now−90d, now+5min]}` | `eventId` | insert row `usage_events`; `usage_events_ingested_total{metric_class}` |
| `llm.call_completed` v1 (from `@app/infrastructure/llm`) | `{subjectId (non-empty), metric (allowlist), billableTokens: int ≥ 0, …}`; `ts` = envelope `occurredAt`; `aggregateId` = call id | `llm:<aggregateId>` | `billableTokens 0` → `usage_events_ignored_total{reason="zero_quantity"}`; otherwise insert. `subjectId: "anonymous"` (S47 `llm.rag.tokens`, outcomes failed/refused/aborted) is stored as platform cost |
| `billing.subscription_status_changed` v1 (S17) | `{subscriptionId: uuid, subjectType: 'USER'\|'SHOP', subjectId: uuid, status, from: string\|null, planCode, subscriptionVersion: int ≥ 0}` | `eventId` | same `subscriptionId` and `version ≤ cached` → ignored (`stale_event`); newer or different `subscriptionId` → `invalidateIfOlder` / `invalidate`; no entry → nothing stored; `entitlement_invalidations_total{outcome}` (`applied`, `stale_event`, `duplicate`) |

Dead-letter reasons: `invalid_payload`, `unknown_metric`, `ts_in_future`, `too_old` (counted in `usage_events_rejected_total{reason}`). A store failure is not a dead-letter: the handler throws a transient error, the message is not acknowledged and is redelivered (AS-20, AS-30). Consumer groups: `billing-usage-recorded`, `billing-llm-usage`, `billing-entitlement-invalidation`. Shutdown: stop taking messages, finish the batch (FR-043).
