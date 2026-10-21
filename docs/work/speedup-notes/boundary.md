# Boundary and table-ownership checks shared (helper "boundary")

Nothing was run (the rules forbid it). Only prettier and the type checker were run (the type checker shows one error in sqs/task-queue.e2e-spec.ts from another helper's change, not from this work).

## The shared helper
`test/utils/static-checks.ts` (import as `@app/test/utils/static-checks`). It holds the small "run once" function G2 wrote (answers kept on `globalThis`, so every test file in the same process gets the same answer), plus two shortcuts:
- `boundaryCheck(backendDir)`: runs `pnpm --silent check:boundaries` once per process, key `check:boundaries`.
- `ownershipCheck(backendDir, extraArgs, banner)`: runs `pnpm [--silent] check:table-ownership [args]` once per process for each flavour (plain or `--strict`, silent or with the pnpm banner line). Specs that only look for a name in the output use the silent flavour; the ones that split the output into sections (payments, orders) or that G2 left with the banner keep the banner flavour, so they see the same text as before.
The answer holds exit status, stdout and stderr. Colours are switched off for all of them.

## Files changed (all in packages/backend)
- discovery/trending-platform, discovery/search-platform, catalog-sync/import-boundary: G2's own copy of the function was removed, they use the helper now.
- discovery/autocomplete-platform: same, boundary through the helper. Its ownership check runs a different command (node with ts-node, strict), so it calls `runOnce` directly with its own key.
- assistant/assistant-platform, experimentation/analytics-ops, media/video-events: the two checks now run side by side and the boundary answer is shared.
- payments/payment-boundary, payments/ledger-ops, payments/payout-ops: the ownership check is shared (three files plus others with the same flavour run it once instead of three times).
- orders/orders-boundary: ownership check and boundary check both shared.
- Extra files found by the search that run the same scans directly (depcruise or the ownership script through node): developer-platform/public-api-boundary, identity/ownership-gates (both ran depcruise with the same arguments as `check:boundaries` and the ownership script plain; now through the helper, run side by side), content/story-tenancy (ownership strict through the helper).

## Why it is the same check
- All assertions and scenario ids are unchanged.
- The old code often threw when a command exited with a non-zero status. Where it did, the new code asserts `status` is 0 (analytics-ops, video-events search, payments, orders, public-api-boundary, story-tenancy). Where the old code ignored failure (assistant ownership, analytics-ops ownership) it still does.
- The converted tests were synchronous before and are now async, so they fall under the 60 s default test limit; those that had none got an explicit 300 000 ms limit (payment-boundary, orders-boundary x2, story-tenancy). The limit was never enforced on the synchronous version, so this is not widening a wait.
- `check:boundaries` is `depcruise apps libs test db --config .dependency-cruiser.cjs --output-type err`, the same as the depcruise calls that were replaced; `check:table-ownership` is the ownership script run with ts-node, the same as the direct node calls.

## Expected saving
With one Vitest process the boundary scan runs once instead of about 12 times (30 to 90 s each, so several minutes of CPU), and in each file the ownership check no longer waits for the boundary one. With separate processes (Jest) only the side-by-side part helps. Ownership scans with the same flavour are shared too.

## What could break
- If the sources change during a run, the shared answer is stale (does not happen in a run).
- Under sharding each shard process runs the scans once; that is expected.
- The first caller's timeout (280 s) counts for everyone. Several scans at the same time on a busy machine could be slower; the limit is the same as before or larger.

## Looked at, not shared
- rag-eval, build-lambdas, workers-wiring (build script), video-pipeline (probe), knowledge-*, others: no whole-repo scan or tsc; they build lambdas or call a tool for their own scenario. openssl in integration-boundary makes a test certificate. No spec runs tsc.
