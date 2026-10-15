# Job contracts: S18

| Job | Schedule | Payload | Behavior |
|---|---|---|---|
| `billing.usage-reconcile` | `15 3 * * *` UTC (`upsertSchedule`; catch `InvalidScheduleError`), single-run lease, idempotent | `z.strictObject({})` via `declareJobType` next to the `JobPayloads` augmentation in `application/billing.job-types.ts` | Walks open `UsageSettlement` rows (keyset, 500 per page). Per row checks `settledAmountMinor == price(settledQuantity)` under the snapshot and `settledQuantity <= exact total`. Sets gauge `usage_ledger_drift` to the number of bad rows; logs subscription, period, metric only; modifies nothing. Usage store failure: job fails and retries per the job type's attempts (gauge unchanged). |
