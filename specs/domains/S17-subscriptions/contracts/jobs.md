# Job contracts: S17 billing

Registered with S49 `@JobHandler` in `infra/billing.jobs.ts` (thin shells over application services); payload types declared with `declareJobType` and a zod contract; a malformed payload is rejected without effect.

| Job | Payload | Trigger | Concurrency / retry | Idempotency key |
|---|---|---|---|---|
| `billing.run` | `{}` | Schedule `*/10 * * * *`, zone `UTC`, lease 600 s, upserted once at worker boot (`upsertSchedule`) | 1; no retry beyond the next slot | schedule slot |
| `billing.charge-invoice` | `{invoiceId}` | subscribe / renewal / change transaction (`runAt = now`); dunning (`runAt = nextAttemptAt`) | 8; 3 retries for infrastructure errors only (a provider outcome is never a job error) | `invoice-charge:<invoiceId>:<attempt>` |
| `billing.resolve-attempt` | `{invoiceId, attempt}` | an unknown outcome (`+30 s`), then backoff with full jitter capped at 15 min; also stale-claim detection | 4; reschedules itself rather than failing | `resolve-attempt:<invoiceId>:<attempt>:<n>` |
| `billing.manual-attempt` | `{invoiceId, k}` | payment-method update on a `PAST_DUE` / `UNPAID` subscription (immediate) | 4 | `invoice-charge:<invoiceId>:manual:<k>` |

Every job honours the stop signal and the shutdown registry between units of work (FR-059). Explicit timeouts: provider call 8 s, usage lines 5 s, statement timeout from `db_statement_timeout_ms`. The S49 job-type registry entries and the S50 policy registry entries (`rate-limit-policies.ts`) are added in the same change; queues named by the jobs exist in the test stack (L-002, L-020).
