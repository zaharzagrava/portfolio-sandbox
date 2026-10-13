---
id: journal-unbalanced
title: JournalUnbalanced
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# JournalUnbalanced
## Definition
`JournalUnbalanced` is the error raised when a [journal's lines](ledger-journal.md) do not sum to exactly zero. The posting is refused as a whole: no entry, [running balance](running-balance.md) or [outbox row](event-row.md) is written. Callers get this error before anything reaches [the store](ledger-store.md). The store also enforces the same rule at commit, whoever wrote the rows.

## Example
A caller posts an [`ADJUSTMENT` journal](adjustment-journal.md) with two lines in one currency: `SHOP_<uuid> +1000` and `PLATFORM_FEES -999` (illustrative). The sum is +1, so [`postJournal`](post-journal.md) raises `JournalUnbalanced` and nothing is persisted.

## Known gaps
- Not confirmed in the code: whether the store's commit-time check also surfaces as `JournalUnbalanced` or as a different database error.
- The spec does not say whether this error rolls back the caller's whole transaction or only the posting, given that the posting joins the caller's transaction.

## Used by
<!-- used-by:start -->
- [adjustment-journal](adjustment-journal.md)
- [event-row](event-row.md)
- [ledger-journal](ledger-journal.md)
- [ledger-store](ledger-store.md)
- [running-balance](running-balance.md)
<!-- used-by:end -->
