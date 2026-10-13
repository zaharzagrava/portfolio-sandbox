---
id: transaction-timeouts
title: Statement and lock timeouts
kind: term
status: draft
aliases: [lock timeout, statement timeout]
defined_for: transaction-runner
rules_hash: 6cdc5e934364
---
# Statement and lock timeouts
## Definition
These are two limits for a [transaction scope](transaction-scope.md). The statement timeout caps how long a single SQL statement may run. The lock timeout caps how long the scope waits to get a lock. Both must be whole numbers of milliseconds within an allowed range. They must never be pasted into the SQL text. Design intent (not stated in the spec): keeping them out of the SQL text prevents [SQL injection ↗](../sw-external-terms.md#sql-injection).

## Example
Illustrative: a statement timeout of `5000` ms is accepted. The values `0`, `1.5` and `"5000; DROP TABLE x"` are rejected because they are not integers in the range 1 to 600 000.

## Known gaps
- The spec does not say how the timeouts are set (option names, defaults, or whether they can be set per scope).
- The spec does not say which error is returned when a timeout fires or when an invalid value is given.
- Not confirmed in the code: how the values reach the database without interpolation (for example, as [bound parameters ↗](../sw-external-terms.md#bound-parameters)).

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-16
- [transaction-runner](../concepts/transaction-runner.md): C-06
- [serializable-scope](serializable-scope.md)
- [transaction-scope](transaction-scope.md)
<!-- used-by:end -->
