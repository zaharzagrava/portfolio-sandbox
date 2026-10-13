---
id: injected-clock
title: Injected clock
kind: term
status: draft
aliases: [clock]
defined_for: S14-ledger-reconciliation
rules_hash: b3080f6e8114
---
# Injected clock
## Definition
The injected clock is the time source that the [ledger](ledger.md) receives as a dependency. The ledger does not read the system time directly. [Journal posting](ledger-posting.md) takes `postedAt` from this clock, so one [journal](ledger-journal.md) gets exactly one timestamp. Making time a dependency lets tests fix the clock and check exact timestamps. That reason is design intent (not stated in the spec).

## Example
A test gives the posting service a clock fixed at `2026-10-13T00:00:00Z` (illustrative). It posts a journal and checks that every line's `postedAt` equals that instant ([S14 AS-01](acceptance-scenario.md)).

## Known gaps
- The spec does not say which clock implementation runs in production, or whether time comes from the application or the database.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-07
- [S28](../capabilities/S28-notifications.md): R-25
- [acceptance-scenario](acceptance-scenario.md)
- [ledger-journal](ledger-journal.md)
- [ledger-posting](ledger-posting.md)
- [ledger](ledger.md)
- [posted-at](posted-at.md)
- [validate-day](validate-day.md)
- [wake-instant](wake-instant.md)
<!-- used-by:end -->
