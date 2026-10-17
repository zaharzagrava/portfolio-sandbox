# Contract: local runner

- `pnpm start:lambda-local [name...]` — needs `pnpm build:lambdas` first. Starts the named functions (default all) from `dist/lambda-bundles/manifest.json`.
- `pnpm start:lambda-local -- --redrive <dlq-name>` — moves every message from the DLQ back to its source queue with body, group ID and attributes unchanged, a fresh dedupe ID for FIFO; prints the count moved; an empty queue prints 0 and exits 0.
- Library: `startRunner({ manifestPath, sqs, clock, maxConcurrency, signal? }): Promise<{ stop() }>` and `redrive({ dlq, sqs }): Promise<number>`.
- Environment: `SQS_ENDPOINT`, `SQS_QUEUE_URL_PREFIX`, `LAMBDA_LOCAL_MAX_CONCURRENCY` (default 2). Effective concurrency = min(manifest `maxConcurrency`, cap).
- Start-up failures (exit non-zero before any receive): visibility below 6 × timeout, queue missing, bundle missing, unknown name.
- Per invocation: full record shape (AS-38), `MessageAttributeNames: ['All']`, no `VisibilityTimeout` override, no `ChangeMessageVisibility`; delete exactly the records not in `batchItemFailures`; nothing on throw or timeout; a timed-out handler is logged `abandoned_invocation`.
- Failures: delete-entry failures logged and survived; receive failures back off 1 s doubling to 30 s; SIGTERM stops receiving, awaits in-flight work up to the function timeout, deletes successes, exits 0.
