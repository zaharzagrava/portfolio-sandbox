# Configuration: S16 statements

Read by `domain/config.ts` (zod) at module initialisation; an invalid value fails startup naming the key (AS-79). No secrets.

| Key | Default | Valid range | Notes |
|---|---|---|---|
| `STATEMENTS_SNAPSHOT_BATCH` | 10000 | 1–10000 | rows per snapshot insert batch |
| `STATEMENTS_ADJUSTMENT_SHOP_BATCH` | 1000 | 1–1000 | shops per reconcile batch |
| `STATEMENTS_EXPORT_BATCH` | 1000 | 1–5000 | rows fetched ahead of the socket |
| `STATEMENTS_CLOSE_MARGIN_MIN` | 10 | ≥ 0 | minutes past month end the watermarks must pass |
| `STATEMENTS_EXPORT_CONCURRENCY` | 2 | ≥ 1 | per shop; the `statements.export.concurrent` policy limit |
| `STATEMENTS_EXPORT_TIMEOUT_MS` | 120000 | ≥ 1000 | `SET LOCAL statement_timeout` for the export transaction |
| `STATEMENTS_JOB_TIMEOUT_MS` | 600000 | ≥ 1000 | per job attempt |
| `STATEMENTS_CLOSE_SCHEDULE` / `STATEMENTS_CLOSE_SCHEDULE_TZ` | `0 2 2 * *` / `UTC` | valid cron / IANA zone | validated with S49 `schedule-validation` |
| `STATEMENTS_RETENTION_YEARS` | 10 | ≥ 10 | stated only; no purge is built |
| `STATEMENTS_LEDGER_GRACE_HOURS` | 24 | ≥ 1 | `missing_in_ledger` grace |
| `STATEMENTS_DRAIN_MS` | 30000 | ≥ 1000 | export drain on shutdown |
