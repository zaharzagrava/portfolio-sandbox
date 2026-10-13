---
id: ledger-busy
title: ledger_busy
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# ledger_busy
## Definition
`ledger_busy` is the error a [ledger posting](ledger-posting.md) fails with when it waits too long. Either it could not lock the [balance rows](balance-row.md) it needs within the [lock timeout](transaction-timeouts.md), or its statement ran past the [statement timeout](transaction-timeouts.md). It is a [retryable error](retryable.md), so trying the same posting again later can succeed. Bounding the waits stops a posting stuck behind a busy account from holding the caller's transaction open. That last point is design intent (not stated in the spec).

## Example
A `PAYOUT` posting tries to lock the balance row of `SHOP_<uuid>` while another posting already holds that lock. The lock wait passes the lock timeout, so [`postJournal`](post-journal.md) fails with `ledger_busy` and the caller retries. The ledger joined the caller's transaction, so the whole transaction must be retried, not just the posting.

## Known gaps
- The spec does not say which HTTP status or problem body `ledger_busy` maps to when it reaches an API caller.
- The spec does not say who retries: the ledger, the caller, or the job layer. It also gives no retry count or backoff.
- The spec does not say whether the caller's transaction can still be used after `ledger_busy`. In most databases, a timed-out statement aborts the whole transaction.

## Used by
<!-- used-by:start -->
- [balance-row](balance-row.md)
- [ledger-posting](ledger-posting.md)
- [retryable](retryable.md)
- [transaction-timeouts](transaction-timeouts.md)
<!-- used-by:end -->
