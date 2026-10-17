# Contract: `Idempotency.run`

```ts
run<T>(key: string, work: () => Promise<T>, options: { leaseMs: number; fingerprint?: string; retentionSec?: number })
  : Promise<{ result: T | undefined; replayed: boolean; resultOmitted?: boolean }>
idempotencyKey(...parts: string[]): string
```

| Situation | Outcome |
|---|---|
| No live record | Conditional put `IN_PROGRESS` with a new `ownerToken`, run `work`, conditional update to `COMPLETED` |
| Live `COMPLETED`, same or no fingerprint | Return stored result, `replayed: true`, work not run |
| Live `IN_PROGRESS` | `AlreadyInProgressError` (transient) |
| Fingerprint differs | `IdempotencyKeyConflictError` (permanent), record unchanged |
| `work` throws | Conditional delete (token), rethrow |
| Completion write fails | Claim kept, `IdempotencyCompletionFailed` metric, store error rethrown |
| Token no longer matches on complete or release | `StaleClaimError`, record unchanged |
| Claim write fails | Transient error, work not run |
| Bad key, lease ≤ 0, lease below function timeout | `InvalidIdempotencyKeyError` / options error before any store call |
| Result over 64 KiB | `COMPLETED` with `resultOmitted: true`, replay returns `result: undefined` |

Item shape: see [data-model.md](../data-model.md). Time comes from the injected clock (S54 `now()`); tests freeze it.
