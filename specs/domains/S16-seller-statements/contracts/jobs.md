# Job contracts: S16 statements

Registered through S49 `@JobHandler` in `infra/statements.jobs.ts`; payloads declared with `declareJobType` and a zod contract (a malformed payload is rejected without effects, AS-29).

| Job | Payload | Trigger | Concurrency / retry | Idempotency |
|---|---|---|---|---|
| `statements.close-month` | `{month?: 'YYYY-MM', runId?: uuid}` | Schedule `0 2 2 * *` zone `UTC` (no month: oldest closable month up to the previous UTC month by the injected clock); admin close (month + runId) | 1; 3 attempts, backoff with jitter; `period_not_ready` re-enqueues with backoff instead of failing | Persisted `knowledgeCutoff`; `ON CONFLICT DO NOTHING` snapshots; a `CLOSED` month is a no-op (AS-30) |
| `statements.reconcile-month` | `{month, cause, shopId?}`; cause is `rate_change:<changeId>`, `late_sale:<orderId>`, `late_payout:<payoutId>` or `close:<runId>` | Rate change (inside the rate transaction), late fact (inside the ingest transaction), close completion | 4; one shop's failure is isolated and re-enqueued | Enqueue key `<cause>:<month>[:<shopId>]`; unique adjustment key; per shop-month advisory lock |
| `statements.verify-period` | `{month}` | Close completion | 1 | Findings upserted per `(month, kind, shop)` |
| `statements.verify-periods` | `{}` | Daily 04:00 `UTC` | 1 | Same |
| `statements.retro-adjust` (legacy) | old payload | Only rows already queued | 1 | Mapped to `reconcile-month` with cause `rate_change:legacy:<reason>`; removed in the contract task |

Cooperative stop: handlers check the job's stop signal and the shutdown registry between batches, finish the current batch, release the lease and leave the period `CLOSING` (AS-80). Every job and query has an explicit timeout (`STATEMENTS_JOB_TIMEOUT_MS`, `db_statement_timeout_ms`).
