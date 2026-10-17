# Contract: manifest and `manifest.json`

Source: `libs/infrastructure/serverless/manifest/lambdas.manifest.ts` (`LAMBDAS`, `LambdaSpec`, `validateManifest`). Output: `dist/lambda-bundles/manifest.json`, read by the runner and by Terraform (`var.lambda_manifest_path`).

`manifest.json` is an array of `{ name, entry, queue, fifo, timeoutSec, memoryMb, batchSize, maxConcurrency, visibilityTimeoutSec, maxReceiveCount, dbPoolMax, deadLetter? }`, with each `deadLetter` also expanded into its own element (`name` = `<name>-dlq`, `queue` = the DLQ, `deadLetterOf` = source function name).

`validateManifest(specs)` rejects (AS-28, AS-30), naming function and field:

1. `visibilityTimeoutSec < 6 × timeoutSec` (also for dead-letter entries).
2. `fifo` differs from the `.fifo` suffix of `queue`.
3. FIFO `batchSize > 10`.
4. `maxConcurrency < 2`.
5. `timeoutSec > 900` or `memoryMb` outside 128–10,240.
6. Two functions on one queue.
7. `maxReceiveCount < 1`.
8. A dead-letter handler whose queue is not the DLQ of an existing entry.
9. `Σ maxConcurrency × dbPoolMax` above the connection budget constant (1,000).

Run in: the build (`scripts/build-lambdas.mjs`), the runner start-up, and `manifest/manifest.spec.ts` in CI. `manifest/queue-config-conformance.spec.ts` compares every Lambda-consumed queue's visibility, receive limit, FIFO flag and DLQ name with `elasticmq.conf` and `infra/stack/main.tf`.
