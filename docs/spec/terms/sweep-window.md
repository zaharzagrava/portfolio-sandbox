---
id: sweep-window
title: Sweep window
kind: term
status: draft
aliases: [sweep windows, windows]
defined_for: S14-ledger-reconciliation
rules_hash: beabeae26b1c
---
# Sweep window
## Definition
A sweep window is the period of time that one run of the shard sweep covers. In each window, the sweep posts at most one `SWEEP` journal per [hot account](hot-account.md). That journal moves the non-empty [shards](ledger-balance-shard.md) of the account into shard 0. Because the sweep is [deterministic ↗](../sw-external-terms.md#deterministic-build) per account and window, the window identifies which consolidation a `SWEEP` journal belongs to. Design intent (not stated in the spec): if the same window is swept twice, the second sweep should match the existing journal and not move the money again.

## Example
The scheduled job `ledger.sweep-hot-accounts` runs for the window 10:00–11:00 UTC (illustrative). For that window it posts one `SWEEP` journal for `PLATFORM_FEES`, one for `PROVIDER_CLEARING` and one for `MARKETPLACE_CLEARING`. It posts a journal for an account only if that account has non-empty shards. Every `PLATFORM_FEES` shard is folded into shard 0 by that single journal.

## Known gaps
- The spec does not say where a window starts and ends. It also does not say whether a window is exactly the hourly schedule period.
- The spec does not say how the window is turned into the journal's reference, so it is unclear what makes a re-run [idempotent ↗](../sw-external-terms.md#idempotency) under the (kind, reference) uniqueness.
- The spec does not say what happens to a window whose sweep was missed or failed. It does not say whether a later run catches it up or folds it into the next window.

## Used by
<!-- used-by:start -->
- [hot-account](hot-account.md)
- [ledger-balance-shard](ledger-balance-shard.md)
- [shard-sweep](shard-sweep.md)
<!-- used-by:end -->
